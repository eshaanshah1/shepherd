import {
  FrameDecoder,
  PROTOCOL_VERSION,
  REQUEST,
  RESPONSE,
  encodeByteFrame,
  encodeJsonFrame,
  newSessionId,
  type Frame,
  type SessionError,
  type SessionExit,
  type SessionObserved,
  type SessionResize,
  type ForegroundReading,
  type ScreenState,
  type SessionInfo,
  type SessionSpec,
  type Viewport,
  type WillCreateHook,
} from '@shepherd/core';
import {
  ok,
  err,
  toDisposable,
  sessionId as toSessionId,
  type CategoryLogger,
  type Disposable,
  type Result,
  type SessionID,
} from '@shepherd/sdk';

/**
 * Main's half of the session protocol — the daemon, wearing `SessionHost`'s face.
 *
 * It satisfies `SessionHostLike` exactly, which is what makes R1 a transport
 * change rather than a rewrite: `SessionBridge`, the renderer, `LayoutStore`'s
 * `SessionSink` and every smoke are untouched by sessions moving out of process.
 *
 * **Synchronous, over a socket, deliberately.** Three things make that honest
 * rather than a lie:
 *
 *   1. **The id is minted here.** `create` cannot both answer in the same tick
 *      and learn an id the daemon chose, so the client chooses it and tells the
 *      daemon (`SessionSpec.id`). The alternative was making nine call sites
 *      async to serve one transport.
 *   2. **`get`/`list` read a local mirror**, kept current by the daemon's own
 *      replies and exit frames. A pane asking "what is my session" must not wait
 *      on a round trip during a React render.
 *   3. **Input is fire-and-forget.** `write` acks nothing — a round trip in
 *      front of every keystroke is the one place latency is felt. Failures
 *      surface through the log and through `onExit`, not through a return value
 *      nobody was waiting on.
 *
 * What it does NOT do is hide a disconnect. A dropped socket is reported and
 * retried, and every live viewer is re-attached on reconnect — where R0's
 * snapshot hands each one a correct screen, however long the gap was.
 */

/** The parts of a real socket this needs. `net.Socket` satisfies it. */
export interface ClientSocket {
  write(bytes: Uint8Array): void;
  destroy(): void;
  onData(fn: (bytes: Uint8Array) => void): void;
  onClose(fn: () => void): void;
  onError(fn: (error: unknown) => void): void;
}

export interface SessionClientOptions {
  /** Opens a connection to the daemon, spawning it if nothing is listening. */
  readonly connect: () => Promise<ClientSocket>;
  readonly log: CategoryLogger;
  /** Backoff between reconnect attempts. Exposed so a test need not sleep. */
  readonly retryMs?: number;
}

interface LiveAttachment {
  readonly sessionId: SessionID;
  readonly sink: (bytes: Uint8Array) => void;
  /**
   * True until this viewer has been handed a screen of its own.
   *
   * ONE process may hold several viewers of one session — two panes, or a pane
   * and a diagnostic tap — and the daemon deduplicates `attach` per client, so
   * only the FIRST gets a replay. A later one asks for a `snapshot` instead, and
   * this flag is what routes that snapshot to it alone.
   */
  awaitingSnapshot: boolean;
}

/**
 * How long to wait for the daemon before answering "it did not".
 *
 * Generous: this bounds a hang, it does not police latency. A local socket
 * answers in microseconds, so anything approaching this is already a fault.
 */
const REQUEST_TIMEOUT_MS = 5_000;

export class SessionClient {
  readonly #options: SessionClientOptions;
  readonly #log: CategoryLogger;
  readonly #decoder = new FrameDecoder();
  /** The local mirror of the daemon's inventory. */
  readonly #sessions = new Map<SessionID, SessionInfo>();
  readonly #attachments = new Map<number, LiveAttachment>();
  readonly #exitListeners = new Set<(exit: SessionExit) => void>();
  readonly #resizeListeners = new Set<(resize: SessionResize) => void>();
  readonly #observedListeners = new Set<(observed: SessionObserved) => void>();
  #socket: ClientSocket | undefined;
  #connecting: Promise<void> | undefined;
  #nextAttachment = 1;
  #nextSeq = 1;
  #disposed = false;
  /** Frames issued before the socket came up. See `#send`. */
  readonly #outbox: Uint8Array[] = [];
  #everConnected = false;
  readonly #willCreate: WillCreateHook[] = [];

  constructor(options: SessionClientOptions) {
    this.#options = options;
    this.#log = options.log;
  }

  get connected(): boolean {
    return this.#socket !== undefined;
  }

  /**
   * Connects, greets, and adopts whatever the daemon is already running.
   *
   * The adoption is the point: on a relaunch the daemon holds the sessions the
   * previous run left behind, and this is where main learns their ids again —
   * ADR 0036's "the daemon is the authority on what is alive".
   */
  async start(): Promise<Result<readonly SessionInfo[], string>> {
    await this.#ensureConnected();
    if (this.#socket === undefined) return err('could not reach the session daemon');
    const listed = await this.#request(REQUEST.list, {});
    if (!listed.ok) return err(String(listed.error));
    const sessions = (listed.value as { sessions?: SessionInfo[] }).sessions ?? [];
    this.#sessions.clear();
    for (const info of sessions) this.#sessions.set(info.id, info);
    this.#log.info(`adopted ${sessions.length} session(s) already running in the daemon`);
    return ok(sessions);
  }

  // ------------------------------------------------------- SessionHostLike

  /**
   * The env-injection seam, applied HERE rather than in the daemon.
   *
   * `claude-code` injects the session id and the hook socket path through it, and
   * the extension host lives in this process — so the hooks run before the spec
   * crosses the socket and `shepherdd` never has to know an extension exists.
   * The alternative was a daemon that loads extensions, which is a much larger
   * thing than a daemon that owns ptys.
   */
  onWillCreate(hook: WillCreateHook): Disposable {
    this.#willCreate.push(hook);
    return toDisposable(() => {
      const at = this.#willCreate.indexOf(hook);
      if (at >= 0) this.#willCreate.splice(at, 1);
    });
  }

  create(spec: SessionSpec): Result<SessionInfo, SessionError> {
    // Minted here — see the class comment. The daemon is told which id to use.
    const id = spec.id ?? newSessionId();
    const withEnv = this.#applyWillCreate(id, spec);
    const optimistic: SessionInfo = {
      id,
      // Filled in when the daemon answers. Nothing in main may assume a pid
      // before then, and nothing does: it is diagnostics and smoke-only.
      pid: 0,
      cwd: withEnv.cwd,
      command: withEnv.command,
      args: withEnv.args ? [...withEnv.args] : [],
      cols: withEnv.cols ?? 80,
      rows: withEnv.rows ?? 24,
      ...(withEnv.paneId === undefined ? {} : { paneId: withEnv.paneId }),
    };
    this.#sessions.set(id, optimistic);

    /*
     * `seed` crosses as BASE64: the request frame is JSON, and a `Uint8Array`
     * put through it arrives as `{"0":27,"1":91,…}` — an object the daemon would
     * feed as nothing at all, silently. The daemon decodes it back (`server.ts`).
     */
    const wireSpec: Record<string, unknown> = { ...withEnv, id };
    if (withEnv.seed !== undefined) wireSpec['seed'] = Buffer.from(Array.from(withEnv.seed)).toString('base64');

    void this.#request(REQUEST.create, { spec: wireSpec }).then((answer) => {
      if (!answer.ok) {
        // The pane will show an empty terminal and no bytes will ever arrive, so
        // the branch that ends in "and then nothing happens" says why.
        this.#log.error(`daemon refused to create ${id}: ${JSON.stringify(answer.error)}`);
        this.#sessions.delete(id);
        this.#announceExit({ sessionId: id, exitCode: -1 });
        return;
      }
      this.#sessions.set(id, answer.value as SessionInfo);
    });

    return ok(optimistic);
  }

  get(id: SessionID): SessionInfo | undefined {
    return this.#sessions.get(id);
  }

  list(): SessionInfo[] {
    return [...this.#sessions.values()];
  }

  has(id: SessionID): boolean {
    return this.#sessions.has(id);
  }

  attach(id: SessionID, sink: (bytes: Uint8Array) => void): Result<Disposable, SessionError> {
    if (!this.#sessions.has(id)) {
      return err({ code: 'unknown-session', message: `no live session ${id}`, sessionId: id });
    }
    // Already watching from this process? Then the daemon will not replay for
    // this viewer, so ask for a screen just for it.
    const alreadyWatching = [...this.#attachments.values()].some((a) => a.sessionId === id);

    const key = this.#nextAttachment;
    this.#nextAttachment += 1;
    this.#attachments.set(key, { sessionId: id, sink, awaitingSnapshot: alreadyWatching });

    if (alreadyWatching) {
      this.#send(encodeJsonFrame(REQUEST.snapshot, { seq: this.#seq(), sessionId: id }));
    } else {
      this.#send(encodeJsonFrame(REQUEST.attach, { seq: this.#seq(), sessionId: id }));
    }

    return ok(
      toDisposable(() => {
        this.#attachments.delete(key);
        // Only tell the daemon once NOTHING here is watching: two panes showing
        // one session share a single daemon-side attachment, and detaching on
        // the first close would silence the second.
        if (![...this.#attachments.values()].some((a) => a.sessionId === id)) {
          this.#send(encodeJsonFrame(REQUEST.detach, { seq: this.#seq(), sessionId: id }));
        }
      }),
    );
  }

  write(id: SessionID, data: string | Uint8Array): Result<void, SessionError> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    this.#send(encodeByteFrame(REQUEST.write, id, bytes));
    return ok(undefined);
  }

  paste(id: SessionID, text: string): Result<void, SessionError> {
    this.#send(encodeJsonFrame(REQUEST.paste, { seq: this.#seq(), sessionId: id, text }));
    return ok(undefined);
  }

  resize(id: SessionID, cols: number, rows: number): Result<void, SessionError> {
    const known = this.#sessions.get(id);
    if (known) this.#sessions.set(id, { ...known, cols, rows });
    this.#send(encodeJsonFrame(REQUEST.resize, { seq: this.#seq(), sessionId: id, cols, rows }));
    return ok(undefined);
  }

  kill(id: SessionID): Result<void, SessionError> {
    this.#send(encodeJsonFrame(REQUEST.kill, { seq: this.#seq(), sessionId: id }));
    return ok(undefined);
  }

  /** A round trip. `SessionHostLike` allows either shape; see its comment. */
  async screen(id: SessionID): Promise<ScreenState | undefined> {
    const answer = await this.#request(REQUEST.screen, { sessionId: id });
    return answer.ok ? (answer.value as ScreenState) : undefined;
  }

  snapshot(id: SessionID, sink: (bytes: Uint8Array) => void): Result<void, SessionError> {
    if (!this.#sessions.has(id)) {
      return err({ code: 'unknown-session', message: `no live session ${id}`, sessionId: id });
    }
    // The daemon answers with a DATA frame carrying the screen, so the sink is
    // registered exactly as an attachment's is — for one frame.
    const key = this.#nextAttachment;
    this.#nextAttachment += 1;
    this.#attachments.set(key, {
      sessionId: id,
      awaitingSnapshot: true,
      sink: (bytes) => {
        this.#attachments.delete(key);
        sink(bytes);
      },
    });
    this.#send(encodeJsonFrame(REQUEST.snapshot, { seq: this.#seq(), sessionId: id }));
    return ok(undefined);
  }

  setViewport(
    id: SessionID,
    viewerId: string,
    viewport: Viewport | undefined,
  ): Result<void, SessionError> {
    this.#send(
      encodeJsonFrame(REQUEST.setViewport, {
        seq: this.#seq(),
        sessionId: id,
        viewerId,
        viewport: viewport ?? null,
      }),
    );
    return ok(undefined);
  }

  /**
   * The pty's foreground process, over the wire.
   *
   * The failure answer is `{ hasForegroundProcess: undefined }` — **never
   * `false`**, and that is the whole care taken here. `host.ts` is explicit that
   * "I could not look" must not be reported as "nothing is there": the
   * reconciliation sweep reads `false` as its demote signal, and a daemon that
   * was merely slow to answer would demote a live agent with nothing anywhere
   * saying why. An unreachable daemon is exactly the unreadable-tty case, one
   * process along.
   */
  async foreground(id: SessionID): Promise<ForegroundReading> {
    const answer = await this.#request(REQUEST.foreground, { sessionId: id });
    if (!answer.ok) return { hasForegroundProcess: undefined };
    return answer.value as ForegroundReading;
  }

  /** The pty's size changed — a viewer must reshape its emulator to match. */
  onResize(listener: (resize: SessionResize) => void): Disposable {
    this.#resizeListeners.add(listener);
    return toDisposable(() => {
      this.#resizeListeners.delete(listener);
    });
  }

  /** A session's program named itself or changed directory. */
  onObserved(listener: (observed: SessionObserved) => void): Disposable {
    this.#observedListeners.add(listener);
    return toDisposable(() => {
      this.#observedListeners.delete(listener);
    });
  }

  onExit(listener: (exit: SessionExit) => void): Disposable {
    this.#exitListeners.add(listener);
    return toDisposable(() => this.#exitListeners.delete(listener));
  }

  dispose(): void {
    this.#disposed = true;
    this.#attachments.clear();
    this.#exitListeners.clear();
    this.#observedListeners.clear();
    // Destroying the socket ends nothing in the daemon. That asymmetry IS the
    // milestone: main going away is a viewer leaving, not a session ending.
    this.#socket?.destroy();
    this.#socket = undefined;
  }

  // ------------------------------------------------------------- internals

  /** The hooks, merged into the spec's env exactly as `SessionHost` does. */
  #applyWillCreate(id: SessionID, spec: SessionSpec): SessionSpec {
    let current = spec;
    for (const hook of this.#willCreate) {
      try {
        const patch = hook({
          sessionId: id,
          spec: {
            cwd: current.cwd,
            command: current.command,
            args: current.args ? [...current.args] : [],
            env: current.env ?? {},
            cols: current.cols ?? 80,
            rows: current.rows ?? 24,
            term: current.term ?? 'xterm-256color',
            scrollback: current.scrollback ?? 1000,
            ...(current.paneId === undefined ? {} : { paneId: current.paneId }),
          },
        });
        if (patch?.env) current = { ...current, env: { ...current.env, ...patch.env } };
      } catch (error) {
        // One bad hook must not stop a terminal opening — and must not be silent
        // either. Same rule as `SessionHost.#applyHooks`.
        this.#log.warn(`an onWillCreate hook for ${id} threw: ${String(error)}`);
      }
    }
    return current;
  }

  #seq(): number {
    const seq = this.#nextSeq;
    this.#nextSeq += 1;
    return seq;
  }

  readonly #pending = new Map<number, (result: Result<unknown, unknown>) => void>();

  /**
   * Sends immediately and resolves when the daemon answers.
   *
   * **It does NOT await the connection before sending, and that is the fix for a
   * real bug.** The first version did, which put the frame on a later microtask
   * — so a synchronous `write` issued right after `create` OVERTOOK it, and the
   * daemon dropped input for a session it had not made yet. The smoke found it
   * as "the marker never appears", which is exactly the shape a lost keystroke
   * takes. Ordering on this path is call order, and nothing may reorder it.
   */
  #request(kind: number, body: Record<string, unknown>): Promise<Result<unknown, unknown>> {
    const seq = this.#seq();
    const answer = new Promise<Result<unknown, unknown>>((resolve) => {
      this.#pending.set(seq, resolve);
      /**
       * A DEADLINE, because an unanswered request must not hang forever.
       *
       * `#send` drops a frame when the socket is down, and a daemon can restart
       * mid-flight — so without this the promise simply never settles. That is
       * not a stall in one call: `sessions.list` awaits `foreground` for every
       * session, so one dropped frame hangs the CLI, the palette and any
       * extension that asks, with nothing anywhere reporting a fault. The
       * symptom is a command that never returns, which reads as the app being
       * wedged.
       *
       * Answering `err` rather than throwing keeps the caller's shape: every
       * other failure here is a value.
       */
      const deadline = setTimeout(() => {
        if (!this.#pending.delete(seq)) return;
        this.#log.warn(`the daemon did not answer request ${seq} within ${REQUEST_TIMEOUT_MS}ms`);
        resolve({ ok: false, error: { code: 'timeout', message: 'the session daemon did not answer' } });
      }, REQUEST_TIMEOUT_MS);
      deadline.unref?.();
    });
    this.#send(encodeJsonFrame(kind as never, { ...body, seq }));
    void this.#ensureConnected();
    return answer;
  }

  /**
   * Queued before the FIRST connection; dropped after a disconnect.
   *
   * The asymmetry is deliberate and both halves are load-bearing:
   *
   *   - **Before the first connect** the app is starting up and every frame is
   *     setup — the pane that opened on launch created its session before the
   *     socket finished coming up. Dropping those would leave a pane wired to a
   *     session the daemon never heard of.
   *   - **After a disconnect** a queued frame is stale input: a keystroke typed
   *     into a terminal nobody was showing, which on reconnect would be
   *     delivered into whatever is there now. Those are dropped, loudly.
   */
  #send(frame: Uint8Array): void {
    if (this.#socket !== undefined) {
      this.#socket.write(frame);
      return;
    }
    if (this.#everConnected) {
      this.#log.warn('dropped a frame: the session daemon connection is down');
      return;
    }
    this.#outbox.push(frame);
    void this.#ensureConnected();
  }

  async #ensureConnected(): Promise<void> {
    if (this.#socket !== undefined || this.#disposed) return;
    this.#connecting ??= this.#connect().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  async #connect(): Promise<void> {
    try {
      const socket = await this.#options.connect();
      socket.onData((bytes) => this.#onData(bytes));
      socket.onError((error) => this.#log.warn(`session socket error: ${String(error)}`));
      socket.onClose(() => this.#onClose());
      this.#socket = socket;

      /**
       * The handshake's ANSWER is read, not merely awaited.
       *
       * `SessionServer` refuses a client whose `PROTOCOL_VERSION` differs, and its
       * own comment names how that happens: "a daemon left running from an older
       * build is the normal way this happens" — which is every `pnpm ship`. The
       * daemon is detached to outlive the app and `reclaimSocketPath` refuses to
       * take over a live socket, so a new build talks to the OLD daemon for as
       * long as that process lives.
       *
       * This used to resolve on ANY reply and ignore the `ok` flag, so the one
       * message that explains the failure — `protocol-mismatch`, carrying both
       * versions — was received and thrown away. The client then marked itself
       * connected, flushed its outbox and re-attached into a socket the daemon had
       * already closed, which reads as everything silently not working.
       *
       * Dormant today (`PROTOCOL_VERSION` has never moved off 1), and it would
       * have bitten on the first bump — precisely when the diagnosis is worth
       * most.
       */
      const hello = new Promise<void>((resolve, reject) => {
        const seq = this.#seq();
        this.#pending.set(seq, (result) => {
          if (result.ok) {
            resolve();
            return;
          }
          const refusal = result.error as { code?: unknown; message?: unknown } | undefined;
          reject(
            new Error(
              typeof refusal?.message === 'string'
                ? refusal.message
                : 'the daemon refused the handshake and gave no reason',
            ),
          );
        });
        socket.write(encodeJsonFrame(REQUEST.hello, { seq, version: PROTOCOL_VERSION }));
      });
      await hello;
      // Read BEFORE it is set: a first connection is `start`'s job and it lists
      // for itself, a later one is a daemon we have to re-learn.
      const reconnected = this.#everConnected;
      this.#everConnected = true;
      // Setup issued before the socket came up, in the order it was issued.
      // Flushed AFTER hello, because the daemon refuses everything before it.
      const queued = this.#outbox.splice(0);
      for (const frame of queued) socket.write(frame);
      if (queued.length > 0) this.#log.info(`flushed ${queued.length} queued frame(s)`);
      if (reconnected) await this.#resync();
      this.#reattachAll();
    } catch (error) {
      this.#log.error(`could not reach the session daemon: ${String(error)}`);
      /*
       * Let go of the socket, because the handshake above can now FAIL with one
       * already assigned. `#ensureConnected` returns early while `#socket` is
       * set, so a refused hello would otherwise leave the client holding a
       * connection it must not use and no retry would ever be scheduled — a
       * quieter version of the defect this whole path just fixed. `destroy`
       * triggers `onClose`, which is the one place that schedules the retry.
       */
      const dead = this.#socket;
      this.#socket = undefined;
      dead?.destroy();
    }
  }

  /**
   * The mirror, re-learned from the daemon we just reached.
   *
   * A reconnect is not always the same daemon. It exits when it has nothing to
   * guard, it is detached so it can die without taking the app with it, and a
   * replacement is spawned by the very next `connect` — so the process on the
   * other end of this socket may never have heard of the sessions we hold. Their
   * ptys died with the process that owned them, and a mirror nobody re-reads
   * turns them into sessions that look alive from every angle: `list` names
   * them, and `SessionHost.foreground` answers `hasForegroundProcess: false` for
   * an unknown id, which reads as an idle shell rather than an absence.
   *
   * **A failure buries nothing.** Same rule `foreground` keeps: "I could not
   * look" must not be reported as "nothing is there". A daemon too slow to
   * answer is not a daemon with no sessions, and guessing wrong here costs a
   * user every agent they had running.
   */
  async #resync(): Promise<void> {
    // Snapshotted before the request, so a session created while it is in flight
    // is not judged by an inventory taken before it existed.
    const known = new Set(this.#sessions.keys());
    const listed = await this.#request(REQUEST.list, {});
    if (!listed.ok) {
      this.#log.warn(
        `could not re-read the daemon's inventory (${JSON.stringify(listed.error)}) — keeping every session`,
      );
      return;
    }
    const sessions = (listed.value as { sessions?: SessionInfo[] }).sessions ?? [];
    const live = new Set(sessions.map((info) => info.id));
    for (const info of sessions) this.#sessions.set(info.id, info);
    for (const id of known) {
      if (live.has(id)) continue;
      this.#bury(id, 'the daemon that owned it is gone');
    }
  }

  /**
   * A session this process still believes in that the daemon does not have.
   *
   * The exit is the point. Nothing downstream polls for a session's absence —
   * `LayoutStore` and the panes learn it from `onExit` and nowhere else — so a
   * pane whose session vanished silently shows a black rectangle until the app
   * is restarted.
   */
  #bury(id: SessionID, why: string): void {
    if (!this.#sessions.delete(id)) return;
    this.#log.warn(`session ${id} is gone: ${why}`);
    this.#announceExit({ sessionId: id, exitCode: -1 });
  }

  /**
   * Every live viewer re-attaches after a reconnect.
   *
   * Safe precisely because of R0: an attach is handed a serialized screen, so a
   * viewer that missed a minute of output is not merely resynchronized — it is
   * CORRECT, alt screen and all. Against a byte ring this would have been a
   * partial redraw and a known limitation.
   *
   * **The answer is read.** This used to send through `#send`, registering no
   * pending handler — so the daemon's `unknown-session` refusal arrived, found
   * nobody waiting on its seq, and was dropped by `#onFrame`. That is the same
   * defect the hello handshake above already fixed once: the one message that
   * explains the failure, received and discarded.
   */
  #reattachAll(): void {
    const ids = [...new Set([...this.#attachments.values()].map((a) => a.sessionId))].filter((id) =>
      // `#resync` has already buried the rest, and asking after a session we
      // just announced the exit of would earn a refusal we would then have to
      // ignore.
      this.#sessions.has(id),
    );
    for (const id of ids) {
      void this.#request(REQUEST.attach, { sessionId: id }).then((answer) => {
        if (answer.ok) return;
        this.#log.error(`the daemon refused a re-attach to ${id}: ${JSON.stringify(answer.error)}`);
        // Two sources disagreed about this session and only one of them was
        // measured against a real pty. Trust the refusal.
        this.#bury(id, 'the daemon refused a re-attach to it');
      });
    }
    if (ids.length > 0) this.#log.info(`re-attached ${ids.length} viewer(s) after reconnecting`);
  }

  #onClose(): void {
    this.#socket = undefined;
    if (this.#disposed) return;
    this.#log.warn('session daemon connection closed — retrying');
    setTimeout(() => void this.#ensureConnected(), this.#options.retryMs ?? 250);
  }

  #onData(bytes: Uint8Array): void {
    const { frames, error } = this.#decoder.feed(bytes);
    for (const frame of frames) this.#onFrame(frame);
    if (error) {
      this.#log.error(`unusable frame from the daemon (${error.code}): ${error.message}`);
      this.#socket?.destroy();
    }
  }

  #onFrame(frame: Frame): void {
    /**
     * The pty changed size — arm every viewer of it for the repaint that
     * follows.
     *
     * The daemon sends `resized` and then one snapshot per CONNECTION, but this
     * process may hold several viewers of one session. Marking them all as
     * awaiting is what fans that single screen out to each of them, through the
     * routing a late attach already uses.
     */
    if (frame.kind === RESPONSE.resized) {
      const resize = frame.json as SessionResize;
      for (const [key, attachment] of [...this.#attachments]) {
        if (attachment.sessionId !== resize.sessionId) continue;
        this.#attachments.set(key, { ...attachment, awaitingSnapshot: true });
      }
      for (const listener of [...this.#resizeListeners]) {
        try {
          listener(resize);
        } catch (error) {
          this.#log.warn(`an onResize listener threw: ${String(error)}`);
        }
      }
      return;
    }

    /**
     * A session named itself or changed directory. Not routed by attachment —
     * the daemon does not gate this one, because a suspended pane has detached
     * and is precisely the tab whose label has to keep moving.
     */
    if (frame.kind === RESPONSE.observed) {
      const observed = frame.json as SessionObserved;
      for (const listener of [...this.#observedListeners]) {
        try {
          listener(observed);
        } catch (error) {
          this.#log.warn(`an onObserved listener threw: ${String(error)}`);
        }
      }
      return;
    }

    if (frame.kind === RESPONSE.snapshot) {
      // To the viewers that asked, and to nobody else: the others are already
      // showing this screen, and handing it to them again would repaint it into
      // the middle of their output.
      const id = frame.sessionId as SessionID;
      const payload = frame.bytes;
      if (payload === undefined) return;
      for (const [key, attachment] of [...this.#attachments]) {
        if (attachment.sessionId !== id || !attachment.awaitingSnapshot) continue;
        this.#attachments.set(key, { ...attachment, awaitingSnapshot: false });
        try {
          attachment.sink(payload);
        } catch {
          // A sink that throws must not cost the others theirs.
        }
      }
      return;
    }

    if (frame.kind === RESPONSE.data) {
      const id = frame.sessionId as SessionID;
      const payload = frame.bytes;
      if (payload === undefined) return;
      for (const attachment of [...this.#attachments.values()]) {
        if (attachment.sessionId !== id) continue;
        try {
          attachment.sink(payload);
        } catch {
          // A sink that throws must not cost the others their bytes — the same
          // rule `PtyFanout.deliver` keeps, one process along.
        }
      }
      return;
    }

    if (frame.kind === RESPONSE.exit) {
      const exit = frame.json as SessionExit;
      this.#sessions.delete(exit.sessionId);
      this.#announceExit(exit);
      return;
    }

    const body = frame.json as { seq?: number; value?: unknown } | undefined;
    if (body?.seq === undefined) return;
    const pending = this.#pending.get(body.seq);
    if (pending === undefined) return;
    this.#pending.delete(body.seq);
    pending(
      frame.kind === RESPONSE.ok
        ? { ok: true, value: body.value }
        : { ok: false, error: body.value },
    );
  }

  #announceExit(exit: SessionExit): void {
    for (const listener of [...this.#exitListeners]) {
      try {
        listener(exit);
      } catch (error) {
        this.#log.warn(`an onExit listener threw: ${String(error)}`);
      }
    }
  }
}
