import type {
  ForegroundReading,
  ScreenState,
  SessionError,
  SessionExit,
  SessionInfo,
  SessionResize,
  SessionSpec,
  Viewport,
  WillCreateHook,
} from '@shepherd/core';
import {
  err,
  ok,
  toDisposable,
  sessionId as toSessionId,
  type CategoryLogger,
  type Disposable,
  type Result,
  type SessionID,
} from '@shepherd/sdk';
import { memberOf, qualify, unqualify } from '../shared/index.ts';
import { SessionClient, type ClientSocket } from './session-client.ts';
import type { SessionHostLike } from './session-bridge.ts';

/**
 * One `SessionHostLike` over several machines.
 *
 * A session id qualified with a member — `mac-b∷01H…` — is another member's
 * session, and an unqualified one is this Mac's. That is the same bookkeeping
 * `remote-views.ts` already does for view types, for the same reason and with the
 * same helpers: the prefix is local, it is stripped before anything leaves, and
 * over there it is the ordinary id the phone has always used.
 *
 * **What this buys is that nothing downstream learns about remote at all.**
 * `SessionBridge`, the IPC layer, `pane-sessions`, `terminal-pane` and xterm see
 * one opaque id and one API. A remote session is the same pane fed from a
 * different source — not a second terminal implementation, which is how v1's
 * remote path drifted into three copies of attach semantics.
 *
 * Two rules here are load-bearing:
 *
 *   1. **`kill` on a qualified id DETACHES. It never kills.** This Mac is a
 *      viewer of that pty; closing the pane must not end somebody else's agent.
 *      `layout.close` is the one terminator (ADR 0022) and what it terminates is
 *      a LOCAL session. A router that forwarded the kill would make closing a
 *      window here reach across the net and stop work over there.
 *   2. **A session that cannot be reached ends up ANNOUNCED, not silent.** Panes
 *      learn of an absence from `onExit` and nowhere else, so a remote attach
 *      that cannot be satisfied says so through the same channel a dead local
 *      session does — otherwise the pane is a black rectangle for the life of
 *      the process.
 */

/**
 * How long a pane keeps waiting for a member that has not answered.
 *
 * Twenty tries at two seconds — forty seconds, which covers a Mac waking up and
 * a Wi-Fi network coming back, and stops well short of a pane that waits for a
 * machine somebody took on holiday. Giving up ends in an announced exit, never in
 * silence.
 */
const REACH_ATTEMPTS = 20;
const REACH_DELAY_MS = 2_000;

export interface SessionRouterOptions {
  /** This Mac's own sessions — the daemon client, or a `SessionHost` in a test. */
  readonly local: SessionHostLike;
  /**
   * A socket onto that member's session protocol, already past the membership
   * handshake. `memberSessionSocket` in `@shepherd/remote` answers this.
   */
  readonly connect: (memberId: string) => Promise<ClientSocket>;
  readonly log: CategoryLogger;
  /** Backoff between reconnects, threaded into each member's client. */
  readonly retryMs?: number;
}

interface Member {
  readonly client: SessionClient;
  /** Resolves once its inventory has been read at least once. */
  readonly ready: Promise<void>;
}

export class SessionRouter implements SessionHostLike {
  readonly #options: SessionRouterOptions;
  readonly #log: CategoryLogger;
  readonly #local: SessionHostLike;
  readonly #members = new Map<string, Member>();
  readonly #exitListeners = new Set<(exit: SessionExit) => void>();
  readonly #resizeListeners = new Set<(resize: SessionResize) => void>();
  readonly #localSubscriptions: Disposable[] = [];
  #disposed = false;

  constructor(options: SessionRouterOptions) {
    this.#options = options;
    this.#log = options.log;
    this.#local = options.local;
    // Local events pass through unchanged: an unqualified id is what every
    // existing consumer already expects, so this adds nothing to that path.
    this.#localSubscriptions.push(
      this.#local.onExit((exit) => this.#announceExit(exit)),
      this.#local.onResize((resize) => this.#announceResize(resize)),
    );
  }

  /**
   * Reach a member and read its inventory, so a later `attach` can be answered.
   *
   * Called before a remote pane is bound, which is what makes the ordinary path
   * synchronous: by the time the renderer mounts and attaches, the mirror knows
   * the session. The restore path cannot do that — the pane is bound from disk
   * before anything has been dialled — so `attach` below also copes with a member
   * that is not ready yet.
   */
  async reach(memberId: string): Promise<Result<readonly SessionInfo[], string>> {
    const member = this.#member(memberId);
    await member.ready;
    const listed = member.client.list();
    return ok(listed.map((info) => this.#qualifyInfo(memberId, info)));
  }

  // ------------------------------------------------------------ SessionHostLike

  /**
   * Always local. A viewer does not spawn processes on somebody else's machine —
   * that is what invoking a command over there is for, and it is the member's own
   * verb table that decides whether it may.
   */
  create(spec: SessionSpec): Result<SessionInfo, SessionError> {
    return this.#local.create(spec);
  }

  onWillCreate(hook: WillCreateHook): Disposable {
    // Local only, and it could not be otherwise: the hooks inject this process's
    // extension-host env into a pty this process is about to start.
    return this.#local.onWillCreate(hook);
  }

  get(id: SessionID): SessionInfo | undefined {
    const at = memberOf(id);
    if (at === undefined) return this.#local.get(id);
    const info = this.#members.get(at)?.client.get(toSessionId(unqualify(id)));
    return info === undefined ? undefined : this.#qualifyInfo(at, info);
  }

  has(id: SessionID): boolean {
    return this.get(id) !== undefined;
  }

  list(): SessionInfo[] {
    const all = [...this.#local.list()];
    for (const [memberId, member] of this.#members) {
      for (const info of member.client.list()) all.push(this.#qualifyInfo(memberId, info));
    }
    return all;
  }

  attach(id: SessionID, sink: (bytes: Uint8Array) => void): Result<Disposable, SessionError> {
    const at = memberOf(id);
    if (at === undefined) return this.#local.attach(id, sink);

    const bare = toSessionId(unqualify(id));
    const member = this.#member(at);
    const immediate = member.client.attach(bare, sink);
    if (immediate.ok) return immediate;

    /**
     * Not known YET — which for a member is the ordinary case, not a failure.
     *
     * A restored pane is bound to a remote session before this Mac has dialled
     * anything, and these are machines that sleep and move networks. So the
     * attach WAITS, and the two ways of waiting are deliberately different:
     *
     *   - **The member answered and has no such session.** That is settled: the
     *     pty is gone, and the pane is told through `onExit` — the only channel
     *     anything downstream listens on for an absence.
     *   - **The member has not answered at all.** Nothing is settled. Retried,
     *     with the reason written into the pane's own stream so the person
     *     looking at it knows what it is waiting for. A member that cannot be
     *     reached is a missing section, not a broken window.
     */
    let live = true;
    let attached: Disposable | undefined;
    void (async () => {
      await member.ready;
      for (let attempt = 0; attempt < REACH_ATTEMPTS; attempt += 1) {
        if (!live || this.#disposed) return;
        const retried = member.client.attach(bare, sink);
        if (retried.ok) {
          attached = retried.value;
          return;
        }
        if (member.client.connected) {
          // Reached, and it does not have this session. Settled — and said out
          // loud, because a pane whose session is gone otherwise shows a black
          // rectangle for the life of the process.
          this.#log.warn(`${at} has no session ${bare} to attach to`);
          this.#announceExit({ sessionId: id, exitCode: -1 });
          return;
        }
        /**
         * The notice goes into the TERMINAL, once.
         *
         * A pane is a screen for bytes, so the honest place to say "I am waiting
         * for another machine" is the screen. It needs no new pane state and no
         * second UI, and it repairs itself: when the member answers, R0's
         * snapshot repaints the whole grid over this line — alt screen and all —
         * so there is nothing to clear.
         */
        if (attempt === 0) {
          sink(
            new TextEncoder().encode(
              `\r\n[2m… waiting for ${at} — it is in this net but has not answered yet[0m\r\n`,
            ),
          );
        }
        await new Promise((resolve) => setTimeout(resolve, this.#options.retryMs ?? REACH_DELAY_MS));
        // Ask again rather than merely waiting: `start` re-dials and re-reads the
        // inventory, which is the whole content of "is it back yet".
        await member.client.start();
      }
      if (!live || this.#disposed) return;
      this.#log.warn(`gave up reaching ${at} for ${bare}`);
      this.#announceExit({ sessionId: id, exitCode: -1 });
    })();

    return ok(
      toDisposable(() => {
        live = false;
        attached?.dispose();
      }),
    );
  }

  write(id: SessionID, data: string | Uint8Array): Result<void, SessionError> {
    return this.#route(id, (host, bare) => host.write(bare, data));
  }

  paste(id: SessionID, text: string): Result<void, SessionError> {
    return this.#route(id, (host, bare) => host.paste(bare, text));
  }

  resize(id: SessionID, cols: number, rows: number): Result<void, SessionError> {
    return this.#route(id, (host, bare) => host.resize(bare, cols, rows));
  }

  setViewport(
    id: SessionID,
    viewerId: string,
    viewport: Viewport | undefined,
  ): Result<void, SessionError> {
    return this.#route(id, (host, bare) => host.setViewport(bare, viewerId, viewport));
  }

  /**
   * Local: end the session. Remote: **stop watching it, and nothing else.**
   *
   * See rule 1 in the class comment. The asymmetry is the whole point of the
   * milestone — main going away is a viewer leaving, and so is a pane closing on
   * a machine that does not own the pty.
   */
  kill(id: SessionID, signal?: string): Result<void, SessionError> {
    const at = memberOf(id);
    if (at === undefined) return this.#local.kill(id, signal);
    const member = this.#members.get(at);
    if (member === undefined) return ok(undefined);
    this.#log.info(`closing a viewer of ${id} — the session belongs to ${at} and keeps running`);
    return ok(undefined);
  }

  snapshot(id: SessionID, sink: (bytes: Uint8Array) => void): Result<void, SessionError> {
    return this.#route(id, (host, bare) => host.snapshot(bare, sink));
  }

  async screen(id: SessionID): Promise<ScreenState | undefined> {
    const at = memberOf(id);
    if (at === undefined) return await this.#local.screen(id);
    const member = this.#member(at);
    await member.ready;
    return await member.client.screen(toSessionId(unqualify(id)));
  }

  async foreground(id: SessionID): Promise<ForegroundReading> {
    const at = memberOf(id);
    if (at === undefined) return await this.#local.foreground(id);
    const member = this.#members.get(at);
    // "I could not look" is NOT "nothing is there" — `host.ts` is explicit that
    // the reconciliation sweep reads `false` as its demote signal, so an
    // unreachable member must answer undefined rather than false.
    if (member === undefined) return { hasForegroundProcess: undefined };
    return await member.client.foreground(toSessionId(unqualify(id)));
  }

  onExit(listener: (exit: SessionExit) => void): Disposable {
    this.#exitListeners.add(listener);
    return toDisposable(() => this.#exitListeners.delete(listener));
  }

  onResize(listener: (resize: SessionResize) => void): Disposable {
    this.#resizeListeners.add(listener);
    return toDisposable(() => this.#resizeListeners.delete(listener));
  }

  dispose(): void {
    this.#disposed = true;
    for (const subscription of this.#localSubscriptions.splice(0)) subscription.dispose();
    for (const member of this.#members.values()) member.client.dispose();
    this.#members.clear();
    this.#local.dispose();
  }

  // ----------------------------------------------------------------- internals

  #route(
    id: SessionID,
    call: (host: SessionHostLike, bare: SessionID) => Result<void, SessionError>,
  ): Result<void, SessionError> {
    const at = memberOf(id);
    if (at === undefined) return call(this.#local, id);
    const member = this.#members.get(at);
    if (member === undefined) {
      return err({
        code: 'unknown-session',
        message: `${at} is not connected, so ${id} cannot be reached`,
        sessionId: id,
      });
    }
    return call(member.client, toSessionId(unqualify(id)));
  }

  /**
   * One client per member, kept — the same rule `invokeAt` keeps for the control
   * channel. A connection per call would pay the TLS handshake and the whole
   * membership check for every keystroke's worth of traffic.
   *
   * Constructed synchronously so every `SessionHostLike` method stays
   * synchronous: `SessionClient` queues what it is handed before its first
   * connection comes up, which is the same property that lets a pane created on
   * launch write into a session before the daemon's socket is ready.
   */
  #member(memberId: string): Member {
    const existing = this.#members.get(memberId);
    if (existing !== undefined) return existing;

    /**
     * The member's name in front of every line, because `SessionClient`'s own
     * messages all say "the session daemon" — and with several members that is
     * three machines' worth of reconnect chatter with nothing saying whose.
     */
    const log: CategoryLogger = {
      debug: (message) => this.#log.debug(`${memberId}: ${message}`),
      info: (message) => this.#log.info(`${memberId}: ${message}`),
      warn: (message) => this.#log.warn(`${memberId}: ${message}`),
      error: (message) => this.#log.error(`${memberId}: ${message}`),
    };
    const client = new SessionClient({
      connect: () => this.#options.connect(memberId),
      log,
      ...(this.#options.retryMs === undefined ? {} : { retryMs: this.#options.retryMs }),
    });

    // Re-emitted QUALIFIED, so a pane bound to `mac-b∷x` hears about `mac-b∷x`
    // and not about a bare id it never knew.
    client.onExit((exit) => {
      this.#announceExit({ ...exit, sessionId: toSessionId(qualify(memberId, exit.sessionId)) });
    });
    client.onResize((resize) => {
      this.#announceResize({
        ...resize,
        sessionId: toSessionId(qualify(memberId, resize.sessionId)),
      });
    });

    const member: Member = {
      client,
      ready: client
        .start()
        .then((started) => {
          if (started.ok) {
            this.#log.info(`${memberId} has ${started.value.length} session(s) we could watch`);
            return;
          }
          // Not fatal and not silent: a member that is asleep is the ordinary
          // case, and `attach` turns this into an announced absence rather than
          // a pane that waits forever.
          this.#log.info(`could not read ${memberId}'s sessions: ${started.error}`);
        })
        .catch((error: unknown) => {
          this.#log.info(`could not reach ${memberId}: ${String(error)}`);
        }),
    };
    this.#members.set(memberId, member);
    return member;
  }

  #qualifyInfo(memberId: string, info: SessionInfo): SessionInfo {
    return { ...info, id: toSessionId(qualify(memberId, info.id)) };
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

  #announceResize(resize: SessionResize): void {
    for (const listener of [...this.#resizeListeners]) {
      try {
        listener(resize);
      } catch (error) {
        this.#log.warn(`an onResize listener threw: ${String(error)}`);
      }
    }
  }
}
