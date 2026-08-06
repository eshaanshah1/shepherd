import type { PaneID } from '@shepherd/sdk';
import type { Pane } from '@shepherd/core/layout';
import type {
  SessionApi,
  SessionCreateRequest,
  SessionDataMessage,
  SessionExitMessage,
} from '../shared/index.ts';

/**
 * Pane id → terminal view → session, and the rule the v1 rewrite exists for:
 *
 *   **A React unmount must never kill a session.**
 *
 * v1 lost a running `claude` every time a `_ConditionalContent` re-created a
 * surface, because the view owned the PTY. Here a view owns nothing. The
 * registry holds the pane→session mapping; mounting a leaf calls `attach`,
 * unmounting calls `detach`, and the ONLY thing that ends a session is an
 * explicit `close(paneId)` — one method, one caller (the close-pane command).
 * `pane-sessions.test.ts` asserts both halves, because a guard with no negative
 * control guards nothing.
 *
 * **`detach` unparents; it does not tear down.** Each pane's terminal lives in
 * a wrapper element the registry owns, and `detach` merely removes that wrapper
 * from the DOM. This is not an optimisation — it is what makes a remount
 * *correct*. React reparents a surviving leaf whenever the tree's shape
 * changes (closing one pane of three moves the other two), so a design that
 * disposed the terminal would rebuild it on every split and close and rely on
 * main's 256 KB replay ring to redraw it: fine for a short session, and for a
 * long one it silently loses everything older than the ring. Keeping the
 * terminal means the remount costs one `appendChild`, and the stream never has
 * to stop — so there is no replay to duplicate and no window during which
 * output is dropped.
 */

export interface TerminalDisposable {
  dispose(): void;
}

/**
 * What the registry needs from a terminal. Structural, so `@xterm/xterm`'s
 * `Terminal` satisfies it without this file importing xterm — which is what
 * lets the lifecycle tests run in jsdom, where xterm cannot measure a cell.
 */
export interface TerminalLike {
  readonly cols: number;
  readonly rows: number;
  open(host: HTMLElement): void;
  write(data: Uint8Array | string): void;
  onData(listener: (data: string) => void): TerminalDisposable;
  onResize(listener: (size: { cols: number; rows: number }) => void): TerminalDisposable;
  focus(): void;
  /** Re-measure against the host element. Null when it cannot be measured yet. */
  fit(): { cols: number; rows: number } | null;
  /** The visible buffer as text. Diagnostics — see `inspect`. */
  text(): string;
  dispose(): void;
}

export type TerminalFactory = () => TerminalLike;

/** How a pane becomes a session spec. Injected: the smoke supplies its own. */
export type SessionSpecFactory = (pane: Pane) => SessionCreateRequest;

/** The view's whole vocabulary. `TerminalPane` is written against this, not the class. */
export interface PaneTerminals {
  /** Mount a terminal for `pane` into `host` and stream its session into it. */
  attach(pane: Pane, host: HTMLElement): void;
  /** The view went away. The session does not. */
  detach(paneId: PaneID): void;
  /** The pane is gone for good. This — and only this — kills the session. */
  close(paneId: PaneID): void;
  focus(paneId: PaneID): void;
  fit(paneId: PaneID): void;
  /** Every branch that ends in "and then nothing happens" must be readable. */
  inspect(paneId: PaneID): PaneDiagnostics | undefined;
}

export interface PaneDiagnostics {
  readonly paneId: PaneID;
  readonly sessionId: string | null;
  /** The session's bytes are flowing to this renderer. */
  readonly streaming: boolean;
  /** The terminal's element is currently parented into a live view. */
  readonly mounted: boolean;
  readonly exited: boolean;
  readonly cols: number;
  readonly rows: number;
  readonly text: string;
}

export interface PaneSessionRegistryOptions {
  readonly session: SessionApi;
  readonly createTerminal: TerminalFactory;
  readonly spec: SessionSpecFactory;
  readonly onError?: (error: unknown, context: string) => void;
}

interface Entry {
  readonly paneId: PaneID;
  pane: Pane;
  sessionId: string | null;
  terminal: TerminalLike | null;
  /** The element the terminal was opened into. Moves between hosts; never rebuilt. */
  wrapper: HTMLElement | null;
  host: HTMLElement | null;
  viewDisposables: TerminalDisposable[];
  /** Whether the session's bytes should be flowing here. False after close/dispose. */
  wantStream: boolean;
  streaming: boolean;
  exited: boolean;
  closed: boolean;
  /** Serializes this pane's async IPC so a fast unmount/remount cannot interleave. */
  queue: Promise<void>;
}

export class PaneSessionRegistry implements PaneTerminals {
  readonly #session: SessionApi;
  readonly #createTerminal: TerminalFactory;
  readonly #spec: SessionSpecFactory;
  readonly #onError: (error: unknown, context: string) => void;

  readonly #entries = new Map<PaneID, Entry>();
  readonly #bySession = new Map<string, Entry>();
  readonly #inflight = new Set<Promise<void>>();
  readonly #unsubscribe: Array<() => void> = [];

  constructor(options: PaneSessionRegistryOptions) {
    this.#session = options.session;
    this.#createTerminal = options.createTerminal;
    this.#spec = options.spec;
    this.#onError = options.onError ?? (() => undefined);

    // One subscription for every pane. `session:data` is already coalesced in
    // main (8ms / 32KB), so this is the only listener on the hot path.
    this.#unsubscribe.push(this.#session.onData((message) => this.#onData(message)));
    this.#unsubscribe.push(this.#session.onExit((message) => this.#onExit(message)));
  }

  attach(pane: Pane, host: HTMLElement): void {
    const entry = this.#ensure(pane);
    entry.pane = pane;
    if (entry.closed) return;

    if (entry.terminal === null) this.#buildTerminal(entry, host);
    const wrapper = entry.wrapper;
    if (wrapper !== null && wrapper.parentNode !== host) host.append(wrapper);
    entry.host = host;
    entry.wantStream = true;
    entry.terminal?.fit();

    this.#sync(entry, 'attach');
  }

  detach(paneId: PaneID): void {
    const entry = this.#entries.get(paneId);
    if (entry === undefined) return;
    // Unparent, and nothing else: no dispose, no `session.detach`, and above
    // all no kill. The terminal keeps its screen and the stream keeps flowing,
    // so a remount is an `appendChild` rather than a 256 KB replay.
    entry.wrapper?.remove();
    entry.host = null;
  }

  close(paneId: PaneID): void {
    const entry = this.#entries.get(paneId);
    if (entry === undefined) return;
    this.#teardownView(entry);
    entry.closed = true;
    entry.wantStream = false;
    this.#entries.delete(paneId);
    this.#enqueue(entry, 'close', async () => {
      const id = entry.sessionId;
      if (id === null) return;
      this.#bySession.delete(id);
      if (entry.streaming) {
        await this.#session.detach(id);
        entry.streaming = false;
      }
      if (!entry.exited) await this.#session.kill(id);
    });
  }

  focus(paneId: PaneID): void {
    this.#entries.get(paneId)?.terminal?.focus();
  }

  fit(paneId: PaneID): void {
    this.#entries.get(paneId)?.terminal?.fit();
  }

  inspect(paneId: PaneID): PaneDiagnostics | undefined {
    const entry = this.#entries.get(paneId);
    if (entry === undefined) return undefined;
    return {
      paneId,
      sessionId: entry.sessionId,
      streaming: entry.streaming,
      mounted: entry.host !== null,
      exited: entry.exited,
      cols: entry.terminal?.cols ?? 0,
      rows: entry.terminal?.rows ?? 0,
      text: entry.terminal?.text() ?? '',
    };
  }

  /** Pane ids the registry still holds, in insertion order. */
  paneIds(): PaneID[] {
    return [...this.#entries.keys()];
  }

  /** Resolves when every queued IPC round trip has finished. Tests and the smoke. */
  async settled(): Promise<void> {
    while (this.#inflight.size > 0) {
      await Promise.all([...this.#inflight]);
    }
  }

  /** Drops every view and stream. Kills nothing — see the class comment. */
  dispose(): void {
    for (const off of this.#unsubscribe.splice(0)) off();
    for (const entry of this.#entries.values()) {
      this.#teardownView(entry);
      entry.wantStream = false;
      this.#sync(entry, 'dispose');
    }
  }

  // ------------------------------------------------------------------ internals

  #ensure(pane: Pane): Entry {
    const existing = this.#entries.get(pane.id);
    if (existing !== undefined) return existing;
    const entry: Entry = {
      paneId: pane.id,
      pane,
      sessionId: null,
      terminal: null,
      wrapper: null,
      host: null,
      viewDisposables: [],
      wantStream: false,
      streaming: false,
      exited: false,
      closed: false,
      queue: Promise.resolve(),
    };
    this.#entries.set(pane.id, entry);
    return entry;
  }

  #buildTerminal(entry: Entry, host: HTMLElement): void {
    // The wrapper is what moves between hosts. xterm's `open()` builds its DOM
    // under whatever it is given and caches a good deal about it, so it is
    // called exactly once per terminal and never against a second parent.
    const wrapper = host.ownerDocument.createElement('div');
    wrapper.className = 'sh-term-surface';
    wrapper.dataset['paneId'] = entry.paneId;
    entry.wrapper = wrapper;

    const terminal = this.#createTerminal();
    entry.terminal = terminal;
    host.append(wrapper);
    terminal.open(wrapper);

    entry.viewDisposables.push(
      terminal.onData((data) => {
        if (entry.sessionId === null || entry.exited) return;
        void this.#session.write(entry.sessionId, data);
      }),
      terminal.onResize(({ cols, rows }) => {
        if (entry.sessionId === null || entry.exited) return;
        void this.#session.resize(entry.sessionId, cols, rows);
      }),
    );
  }

  #teardownView(entry: Entry): void {
    for (const disposable of entry.viewDisposables.splice(0)) disposable.dispose();
    entry.terminal?.dispose();
    entry.wrapper?.remove();
    entry.terminal = null;
    entry.wrapper = null;
    entry.host = null;
  }

  /**
   * Converge the IPC on what the pane now wants: a session exists once a pane
   * has been mounted at all, and its bytes flow while `wantStream` holds (i.e.
   * until the pane is closed or the registry is disposed — NOT merely while a
   * view is parented).
   *
   * Written as a converge rather than as create/attach/detach call sites, so a
   * mount that races its own unmount cannot leave a half state; the per-entry
   * queue is what makes "races" mean "runs in order" here.
   */
  #sync(entry: Entry, context: string): void {
    this.#enqueue(entry, context, async () => {
      if (entry.closed) return;

      if (entry.sessionId === null && entry.wantStream && !entry.exited) {
        const created = await this.#session.create(this.#spec(entry.pane));
        if (!created.ok) {
          this.#onError(created.error, `create ${entry.paneId}`);
          return;
        }
        entry.sessionId = created.value.sessionId;
        this.#bySession.set(entry.sessionId, entry);
      }

      const id = entry.sessionId;
      if (id === null) return;
      const wantStream = entry.wantStream && !entry.exited;

      if (wantStream && !entry.streaming) {
        const attached = await this.#session.attach(id);
        if (!attached.ok) {
          this.#onError(attached.error, `attach ${entry.paneId}`);
          return;
        }
        entry.streaming = true;
        // Size the pty to the view now that bytes are flowing.
        const terminal = entry.terminal;
        if (terminal !== null) await this.#session.resize(id, terminal.cols, terminal.rows);
      } else if (!wantStream && entry.streaming) {
        await this.#session.detach(id);
        entry.streaming = false;
      }
    });
  }

  #enqueue(entry: Entry, context: string, work: () => Promise<void>): void {
    const next = entry.queue.then(work).catch((error: unknown) => {
      this.#onError(error, `${context} ${entry.paneId}`);
    });
    entry.queue = next;
    this.#inflight.add(next);
    void next.finally(() => this.#inflight.delete(next));
  }

  #onData(message: SessionDataMessage): void {
    // Written whether or not the terminal is parented right now: an unparented
    // one is still the pane's screen, and dropping bytes here would leave a
    // gap that nothing later fills in.
    this.#bySession.get(message.sessionId)?.terminal?.write(message.bytes);
  }

  #onExit(message: SessionExitMessage): void {
    const entry = this.#bySession.get(message.sessionId);
    if (entry === undefined) return;
    entry.exited = true;
    entry.streaming = false;
    this.#bySession.delete(message.sessionId);
  }
}
