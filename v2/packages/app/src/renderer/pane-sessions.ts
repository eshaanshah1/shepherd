import type { PaneID } from '@shepherd/sdk';
import type { Pane } from '@shepherd/core/layout';
import type {
  SessionApi,
  SessionCreateRequest,
  SessionDataMessage,
  SessionExitMessage,
  SessionResizeMessage,
} from '../shared/index.ts';

/**
 * Pane id → terminal view → session, and the rule the v1 rewrite exists for:
 *
 *   **A React unmount must never kill a session.**
 *
 * v1 lost a running `claude` every time a `_ConditionalContent` re-created a
 * surface, because the view owned the PTY. Here a view owns nothing. The
 * registry holds the pane→session mapping; mounting a leaf calls `attach`,
 * unmounting calls `detach`, and **nothing in this file ever kills a session.**
 *
 * That last clause is P4a's change, and it is the same rule one process over.
 * The kernel owns the layout, so `layout.close` — reached by ⌘W, by
 * `shepherd pane close`, by an extension — is what ends a session, through the
 * `SessionSink` a `LayoutStore` cannot be built without. By the time the pane's
 * disappearance reaches this renderer as a snapshot, main has already killed the
 * pty; a kill here would be a guaranteed second one. `release(paneId)` therefore
 * drops the view and nothing else, and `pane-sessions.test.ts` asserts that with
 * its negative controls kept pointing the other way round.
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

/** What a match counter and a next/previous button need. See `find-bar.tsx`. */
export interface TerminalSearch {
  /**
   * Selects the next match and scrolls it into view. False when there is none.
   *
   * `incremental` is what a keystroke passes: it keeps the current match while
   * the term still matches it, so typing `fo` `foo` refines one hit instead of
   * walking forward one match per character. An explicit next/previous must NOT
   * pass it, or the button would land on the match it started from.
   */
  findNext(term: string, incremental?: boolean): boolean;
  findPrevious(term: string): boolean;
  /** Drops the highlights. What closing the find bar does. */
  clear(): void;
  onResults(listener: (results: { resultIndex: number; resultCount: number }) => void): TerminalDisposable;
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
  /** Reshape the grid to the host's. See `#onHostResize`. */
  resize(cols: number, rows: number): void;
  focus(): void;
  /** Re-measure against the host element. Null when it cannot be measured yet. */
  fit(): { cols: number; rows: number } | null;
  /** The visible buffer as text. Diagnostics — see `inspect`. */
  text(): string;
  /**
   * Find, when the terminal has one. Optional because this interface is what
   * makes the lifecycle tests runnable in jsdom — a fake that has no addon is
   * still a terminal, and the find bar simply has nothing to drive.
   */
  readonly search?: TerminalSearch;
  dispose(): void;
}

export type TerminalFactory = () => TerminalLike;

/** How a pane becomes a session spec. Injected: the smoke supplies its own. */
export type SessionSpecFactory = (pane: Pane) => SessionCreateRequest;

/** The view's whole vocabulary. `TerminalPane` is written against this, not the class. */
export interface PaneTerminals {
  /**
   * Mount a terminal for `pane` into `host` and stream its session into it.
   *
   * `existing` is a session id the LAYOUT already binds to this pane, and it is
   * what makes a page reload survivable: sessions live in main and outlive the
   * window, so a renderer that always created would start a second pty for a
   * pane that already has one — leaving the first alive, rendered by nobody,
   * and killable only through a pane that no longer points at it. Measured: one
   * `window.reload` with two panes open left four sessions.
   */
  attach(pane: Pane, host: HTMLElement, existing?: string): void;
  /** The view went away. The session does not. */
  detach(paneId: PaneID): void;
  /**
   * The pane is gone from the layout. Drops the terminal and stops streaming —
   * and kills nothing, because core already did. See the class comment.
   */
  release(paneId: PaneID): void;
  /**
   * The pane is mounted but NOT VISIBLE — it lives in a root the window is not
   * showing. Drops its terminal and stops its stream; keeps its session, its id,
   * and its place in the registry. `attach` wakes it.
   *
   * Takes the `Pane` and not just an id, for the same reason `attach` does: a
   * pane whose root has never been on screen has no entry yet, and its session
   * must still be CREATED. `tasks.spawn` opens an agent into a root that may not
   * be the visible one, and an agent that waits to be looked at before it starts
   * is not an agent.
   */
  suspend(pane: Pane, existing?: string): void;
  focus(paneId: PaneID): void;
  fit(paneId: PaneID): void;
  /**
   * This pane's find, or undefined while it holds no terminal — which is a real
   * state, not a guard against one: a suspended pane has no terminal at all.
   */
  search(paneId: PaneID): TerminalSearch | undefined;
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
  /** Holding no terminal because nobody can see it. Wakes on the next `attach`. */
  readonly suspended: boolean;
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
  /**
   * Whether this pane should HAVE a session at all. True from the first mount —
   * visible or not — and false only once the pane is closed or the registry is
   * disposed.
   *
   * Separate from `wantStream` because a suspended pane wants the first and not
   * the second: its agent must be running even though nobody is watching it.
   * Collapsing the two is what made a hidden root's panes never spawn.
   */
  wantSession: boolean;
  /** Whether the session's bytes should be flowing here. False after close/dispose. */
  wantStream: boolean;
  /** Parked: no terminal, no stream, but still this pane's session. */
  suspended: boolean;
  /**
   * True only while the host's own size is being written into the grid.
   *
   * `terminal.resize()` emits xterm's `onResize`, and that listener reports the
   * new size to the host as an authoritative one — so applying a correction sent
   * it straight back, and with more than one pane on screen the corrections
   * chased each other at frame rate. Measured: 29,825 resizes in ten seconds,
   * cycling 28x39 → 24x39 → 56x45 → 64x45 and round again. `xterm-terminal.ts`
   * has claimed since it was written that `resize` "reshapes the grid without
   * telling the host"; this is the part that makes that true.
   */
  applyingHostSize: boolean;
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
    this.#unsubscribe.push(this.#session.onResize((message) => this.#onHostResize(message)));
  }

  attach(pane: Pane, host: HTMLElement, existing?: string): void {
    const entry = this.#ensure(pane);
    entry.pane = pane;
    if (entry.closed) return;

    // Adopt before anything can create. `#sync` creates when `sessionId` is
    // null, so this is the whole of the fix — and it is only ever an adoption:
    // an entry that already knows its session is left alone, since main's
    // binding and ours agreeing is the normal case and re-pointing it would
    // orphan whatever we were streaming.
    if (entry.sessionId === null && existing !== undefined && existing !== '') {
      entry.sessionId = existing;
      this.#bySession.set(existing, entry);
    }

    // Waking a suspended pane. `sessionId` is deliberately left alone: the
    // session outlived the view, and `#sync` re-attaches — where the host hands
    // it the screen it missed rather than a replay it has outgrown.
    entry.suspended = false;

    if (entry.terminal === null) this.#buildTerminal(entry, host);
    const wrapper = entry.wrapper;
    if (wrapper !== null && wrapper.parentNode !== host) host.append(wrapper);
    entry.host = host;
    entry.wantSession = true;
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

  release(paneId: PaneID): void {
    const entry = this.#entries.get(paneId);
    if (entry === undefined) return;
    this.#teardownView(entry);
    // `closed` is set SYNCHRONOUSLY, before anything is awaited: a pane released
    // while its very first `create` is still queued must not go on to spawn a
    // shell for a pane that no longer exists — `#sync` reads this flag first.
    entry.closed = true;
    entry.wantSession = false;
    entry.wantStream = false;
    this.#entries.delete(paneId);
    this.#enqueue(entry, 'release', async () => {
      const id = entry.sessionId;
      if (id === null) return;
      this.#bySession.delete(id);
      if (entry.streaming) {
        /**
         * Withdraw this pane's opinion about the size, then stop the fan-out.
         *
         * The withdrawal matters most exactly here, because this is the path a
         * CLOSED pane takes: a viewport left behind by a pane that no longer
         * exists would go on constraining the pty for every other viewer — a
         * narrow window closed on this Mac keeping a wide one letterboxed on
         * another, with nothing on either screen to explain it. `release`
         * detaches outside `#sync`, so it needs its own withdrawal; a
         * `session.detach` alone does not imply one.
         */
        await this.#session.setViewport(id, entry.paneId, null);
        // NOT a kill: the pty is core's, and it is already gone or on its way.
        await this.#session.detach(id);
        entry.streaming = false;
      }
    });
  }

  /**
   * The pane is mounted but nobody can see it — it is in a root the window is
   * not showing. Drop the terminal, stop the stream, keep the session.
   *
   * This is NOT `detach`. `detach` is React reparenting a pane you can still
   * see (splitting, closing a sibling), and it must stay a bare unparent — see
   * the class comment. This is the case that was previously IMPOSSIBLE: before
   * the host held a screen, a pane that stopped listening could never catch up,
   * so the comment above says a design that disposed the terminal would "rely on
   * main's 256 KB replay ring to redraw it: fine for a short session, and for a
   * long one it silently loses everything older than the ring". The ring is gone;
   * an attach is now handed a correct screen however long it was away.
   *
   * Measured at 20 panes with one visible: renderer memory 40.7 -> 2.0 MB and
   * IPC 4 -> 0.2 MB/s, with CPU a wash — and 19 panes stop RENDERING, which is
   * the largest term and the one the probe could not measure
   * (docs/superpowers/probes/2026-08-09-r0, p6).
   */
  suspend(pane: Pane, existing?: string): void {
    const entry = this.#ensure(pane);
    entry.pane = pane;
    if (entry.closed) return;

    // Adopt exactly as `attach` does. A reloaded page whose hidden root already
    // has sessions in main must not create a second set the moment it is shown.
    if (entry.sessionId === null && existing !== undefined && existing !== '') {
      entry.sessionId = existing;
      this.#bySession.set(existing, entry);
    }

    if (entry.suspended) return;
    entry.suspended = true;
    // The session is still wanted; only its bytes are not.
    entry.wantSession = true;
    entry.wantStream = false;
    this.#teardownView(entry);
    this.#sync(entry, 'suspend');
  }

  focus(paneId: PaneID): void {
    this.#entries.get(paneId)?.terminal?.focus();
  }

  fit(paneId: PaneID): void {
    this.#entries.get(paneId)?.terminal?.fit();
  }

  search(paneId: PaneID): TerminalSearch | undefined {
    return this.#entries.get(paneId)?.terminal?.search;
  }

  inspect(paneId: PaneID): PaneDiagnostics | undefined {
    const entry = this.#entries.get(paneId);
    if (entry === undefined) return undefined;
    return {
      paneId,
      sessionId: entry.sessionId,
      streaming: entry.streaming,
      mounted: entry.host !== null,
      suspended: entry.suspended,
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
      entry.wantSession = false;
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
      wantSession: false,
      wantStream: false,
      suspended: false,
      applyingHostSize: false,
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
        // The host's own answer, coming back through xterm's event. Reporting it
        // would be this pane telling the host what the host just said.
        if (entry.applyingHostSize) return;
        /**
         * An OPINION, not a command — `setViewport`, never `resize`.
         *
         * One pty can have several viewers (this pane, a phone, another member
         * of the net watching the same session), and `resize` is
         * last-writer-wins: reporting a window that way made this pane fight
         * every other viewer for the pty, at the rate a `ResizeObserver` fires.
         * Declared as a viewport, `core/session/viewport.ts` arbitrates —
         * smallest of each dimension — so the big screen letterboxes instead of
         * the small one losing lines. A sole viewer is trivially the smallest,
         * so a pane nobody else is watching behaves exactly as before.
         */
        void this.#session.setViewport(entry.sessionId, entry.paneId, { cols, rows });
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

      if (entry.sessionId === null && entry.wantSession && !entry.exited) {
        const created = await this.#session.create(this.#spec(entry.pane));
        if (!created.ok) {
          this.#onError(created.error, `create ${entry.paneId}`);
          return;
        }
        entry.sessionId = created.value.sessionId;
        this.#bySession.set(entry.sessionId, entry);

        /**
         * The pane's one-shot command, typed into the pty it just got.
         *
         * Inside the create branch, which is what makes it one-shot: `#sync`
         * runs again on every attach, and a command re-typed on a remount would
         * start a second agent in a pane that already has one.
         *
         * `write`, not `paste`: this is a single line by contract
         * (`layout.split`'s schema says so), and the trailing newline IS the
         * Enter that runs it.
         */
        const command = entry.pane.initialCommand;
        if (command !== null && command !== '') {
          const typed = await this.#session.write(entry.sessionId, `${command}\n`);
          if (!typed.ok) this.#onError(typed.error, `initialCommand ${entry.paneId}`);
        }
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
        // Declare what this view can show, now that bytes are flowing. An
        // opinion the host arbitrates — see the `onResize` listener.
        const terminal = entry.terminal;
        if (terminal !== null) {
          await this.#session.setViewport(id, entry.paneId, {
            cols: terminal.cols,
            rows: terminal.rows,
          });
        }
      } else if (!wantStream && entry.streaming) {
        /**
         * Withdrawn BEFORE the detach, and it is not merely tidy: a viewport
         * left behind goes on constraining the pty for everybody else, so a
         * narrow pane that was closed would keep a wide one letterboxed with
         * nothing on screen to explain it. `undefined`/`null` is the withdrawal
         * `host.setViewport` documents and that nothing used to send.
         */
        await this.#session.setViewport(id, entry.paneId, null);
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

  /**
   * The host reshaped the pty; this emulator follows.
   *
   * It is NOT this pane's own resize — that goes the other way, as a viewport
   * the host arbitrates. This is the answer coming back, and it can differ from
   * what this pane asked for because somebody else is watching too. A viewer
   * that ignored it would keep a wide grid and paint narrow output into it,
   * losing lines silently. The repaint arrives right behind it as a snapshot.
   */
  #onHostResize(message: SessionResizeMessage): void {
    const entry = this.#bySession.get(message.sessionId);
    const terminal = entry?.terminal;
    if (entry === undefined || !terminal) return;
    if (terminal.cols === message.cols && terminal.rows === message.rows) return;
    entry.applyingHostSize = true;
    try {
      terminal.resize(message.cols, message.rows);
    } finally {
      entry.applyingHostSize = false;
    }
  }

  #onExit(message: SessionExitMessage): void {
    const entry = this.#bySession.get(message.sessionId);
    if (entry === undefined) return;
    entry.exited = true;
    entry.streaming = false;
    this.#bySession.delete(message.sessionId);
  }
}
