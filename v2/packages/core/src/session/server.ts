import { FrameDecoder, PROTOCOL_VERSION, REQUEST, RESPONSE, encodeByteFrame, encodeJsonFrame, type Frame } from './protocol.ts';
import { HookJournal, type HookEnvelope } from './hook-journal.ts';
import type { SessionHost, SessionSpec } from './host.ts';
import {
  sessionId as toSessionId,
  type CategoryLogger,
  type Disposable,
  type Logger,
  type SessionID,
} from '@shepherd/sdk';

/**
 * The daemon's half of the session protocol.
 *
 * Deliberately socket-free: it takes a `Connection` it can write to and be fed
 * bytes by, so every claim below — a dropped connection detaches but does not
 * kill, a version mismatch is refused rather than misparsed, two clients see one
 * session — is testable without binding a port or racing an accept loop.
 * `packages/daemon`'s `main.ts` is the twenty lines that supply a real
 * `net.Socket`, and `@shepherd/remote` supplies a TLS one — which is the reason
 * this lives in CORE rather than in the daemon. It is the session protocol's
 * server; the daemon is a process that hosts it, and it is not the only one.
 *
 * **The rule this whole process exists to enforce:** a connection going away
 * detaches its viewers and KILLS NOTHING. That is R0's "a session outlives its
 * view" at a process boundary, and it is the entire milestone — if a client
 * disconnect could end a pty, moving sessions out of Electron would buy nothing.
 */

/**
 * What the server needs from one client. A `net.Socket` satisfies it.
 *
 * **It carries no id, and that is the fix for a real defect.** Ids used to come
 * from the transport, and this server has more than one — a unix socket for the
 * app and a TLS endpoint for paired devices — each counting from 1. The phone's
 * connection 1 therefore REPLACED the app's connection 1 in the client table,
 * and every reply meant for the Mac went to the phone: the app's own panes went
 * blank and its requests timed out, while the phone looked connected.
 *
 * So the id belongs to whoever owns the table. `accept` mints it and hands it
 * back; a transport keys its own bookkeeping off that.
 */
export interface Connection {
  write(bytes: Uint8Array): void;
  close(): void;
}

export interface SessionServerOptions {
  readonly host: SessionHost;
  readonly log: Logger;
  /** Overrides `DEFAULT_JOURNAL_LIMIT`. Exists so a test can overflow it. */
  readonly journalLimit?: number;
}

/**
 * What a client says it IS, in its `hello`.
 *
 * Only `app` receives agent hooks, and the distinction is load-bearing rather
 * than descriptive: a paired phone is a full session client in this same table,
 * and if it counted as a listener, plugging one in would consume the replay the
 * Mac's app was waiting for — silently discarding the state of every agent that
 * ran while the app was closed.
 *
 * Absent means `device`, which is the safe direction: an older app that does not
 * send a role gets today's behaviour (no replay) rather than a phone quietly
 * swallowing one.
 */
export type ClientRole = 'app' | 'device';

interface ClientState {
  /** Minted by `accept`; see `Connection`. */
  readonly id: number;
  readonly connection: Connection;
  readonly decoder: FrameDecoder;
  /** sessionId -> the attachment this client holds. One per (client, session). */
  readonly attachments: Map<SessionID, Disposable>;
  /**
   * sessionId -> the viewport key this client registered.
   *
   * Tracked so `disconnect` can WITHDRAW them. Without this a client that goes
   * away keeps constraining the pty forever: the phone is put down, and the Mac
   * stays letterboxed to a phone's 60 columns with nothing anywhere saying why.
   * Caught by its own test rather than in the field.
   */
  readonly viewports: Map<SessionID, string>;
  greeted: boolean;
  role: ClientRole;
}

export class SessionServer {
  readonly #host: SessionHost;
  readonly #log: CategoryLogger;
  readonly #clients = new Map<number, ClientState>();
  readonly #hostExit: Disposable;
  readonly #hostResize: Disposable;
  readonly #hostObserved: Disposable;
  readonly #journal: HookJournal;
  #nextClientId = 1;
  #servesHooks = false;

  constructor(options: SessionServerOptions) {
    this.#host = options.host;
    this.#log = options.log.child('session');
    this.#journal = new HookJournal(
      options.journalLimit === undefined ? {} : { limit: options.journalLimit },
    );
    // Every client watching a session learns it ended, whether or not it was
    // the one that asked for the kill.
    this.#hostExit = this.#host.onExit((exit) => {
      for (const client of this.#clients.values()) {
        if (!client.attachments.has(exit.sessionId)) continue;
        client.attachments.get(exit.sessionId)?.dispose();
        client.attachments.delete(exit.sessionId);
        this.#send(client, encodeJsonFrame(RESPONSE.exit, { ...exit }));
      }
    });

    /**
     * …and every client watching learns it changed SIZE, for the same reason.
     *
     * The size is arbitrated between viewers, so it changes underneath a client
     * that did nothing — a phone attaching letterboxes the Mac. Without this the
     * Mac kept a wide grid and painted narrow output into it, losing lines with
     * nothing to indicate a fault.
     *
     * The fresh snapshot is not optional: resizing an emulator reflows the grid
     * but redraws no content, so a viewer told only the size is correctly shaped
     * and showing the old screen.
     */
    this.#hostResize = this.#host.onResize((resize) => {
      for (const client of this.#clients.values()) {
        if (!client.attachments.has(resize.sessionId)) continue;
        this.#send(client, encodeJsonFrame(RESPONSE.resized, { ...resize }));
        this.#host.snapshot(resize.sessionId, (bytes) => {
          this.#send(client, encodeByteFrame(RESPONSE.snapshot, resize.sessionId, bytes));
        });
      }
    });

    /**
     * …and every client learns what a session CALLS itself — attached or not.
     *
     * The one broadcast here that is not gated on `attachments`, and the gate is
     * exactly what it must not have: a suspended pane detaches, so the tab whose
     * label would go stale is the tab an attachment check would skip. A client
     * with no interest drops a small JSON frame.
     */
    this.#hostObserved = this.#host.onObserved((observed) => {
      for (const client of this.#clients.values()) {
        this.#send(client, encodeJsonFrame(RESPONSE.observed, { ...observed }));
      }
    });
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  /**
   * One agent hook arrived. Forward it, or hold it for an app that will come.
   *
   * Called by whoever serves the hook socket — `packages/daemon`'s `main.ts`,
   * through `EventsIngress`. This is the whole reason the socket moved into the
   * daemon: an agent goes on firing hooks into a pty this process owns while the
   * app is being replaced, and the app has no way to learn afterwards what it
   * missed. A `claude` that did not restart never fires another `SessionStart`.
   *
   * Forward OR hold, never both: a replay of something already applied would fold
   * a second `Stop` into a reopened turn, which is a wrong state rather than a
   * no-op.
   */
  recordHook(envelope: HookEnvelope): void {
    const apps = [...this.#clients.values()].filter((c) => c.greeted && c.role === 'app');
    if (apps.length === 0) {
      this.#journal.record(envelope);
      return;
    }
    for (const app of apps) this.#send(app, encodeJsonFrame(RESPONSE.hooked, { ...envelope }));
  }

  /** What the journal is holding, for a log line or a diagnostic. */
  get journalSize(): number {
    return this.#journal.size;
  }

  /**
   * Declare that this process really holds the hook socket.
   *
   * Called by the daemon **after a successful bind**, never as a constant — the
   * handshake advertises it, and an app that is told the daemon has the socket
   * stands its own ingress down. A daemon whose bind failed but claimed the
   * capability anyway would silence the fallback and lose every hook, with each
   * side believing the other had it.
   *
   * This is advertised rather than settled by a `PROTOCOL_VERSION` bump, and the
   * reason is the daemon's whole purpose: a mismatch is refused, so a new app
   * would find its terminals dead against the old daemon — and it cannot replace
   * that daemon without killing every agent the user is running. So the app keeps
   * its own ingress for exactly that case and serves hooks itself, as it always
   * did.
   */
  setServesHooks(serves: boolean): void {
    this.#servesHooks = serves;
  }

  /** Registers a client and returns the id to use for `feed` and `disconnect`. */
  accept(connection: Connection): number {
    const id = this.#nextClientId;
    this.#nextClientId += 1;
    this.#clients.set(id, {
      id,
      connection,
      decoder: new FrameDecoder(),
      attachments: new Map(),
      viewports: new Map(),
      greeted: false,
      role: 'device',
    });
    this.#log.info(`client ${id} connected (${this.#clients.size} total)`);
    return id;
  }

  /**
   * A client went away.
   *
   * Its viewers go; its sessions do not. A `dispose` here is the same
   * `PtyFanout` detach a closed window performs, and the pty never notices.
   */
  disconnect(id: number): void {
    const client = this.#clients.get(id);
    if (!client) return;
    for (const attachment of client.attachments.values()) attachment.dispose();
    client.attachments.clear();
    // Withdraw its opinion about size, or a departed viewer goes on shrinking
    // the pty for everyone still watching.
    for (const [sessionId, key] of client.viewports) {
      this.#host.setViewport(sessionId, key, undefined);
    }
    client.viewports.clear();
    this.#clients.delete(id);
    this.#log.info(
      `client ${id} disconnected; ${this.#host.list().length} session(s) still running`,
    );
  }

  feed(id: number, chunk: Uint8Array): void {
    const client = this.#clients.get(id);
    if (!client) return;

    const { frames, error } = client.decoder.feed(chunk);
    for (const frame of frames) this.#handle(client, frame);
    if (error) {
      // A stream that cannot be resynchronized is not recoverable — say why and
      // drop it, rather than leaving a half-parsed connection open forever.
      this.#log.error(`client ${id} sent an unusable frame (${error.code}): ${error.message}`);
      client.connection.close();
      this.disconnect(id);
    }
  }

  dispose(): void {
    this.#hostExit.dispose();
    this.#hostResize.dispose();
    this.#hostObserved.dispose();
    for (const id of [...this.#clients.keys()]) this.disconnect(id);
  }

  // ------------------------------------------------------------------ internals

  #replayHooks(client: ClientState): void {
    const { events, dropped } = this.#journal.drain();
    for (const envelope of events) {
      this.#send(client, encodeJsonFrame(RESPONSE.hooked, { ...envelope }));
    }
    if (events.length > 0) {
      this.#log.info(`replayed ${events.length} agent hook(s) held while no app was connected`);
    }
    if (dropped > 0) {
      // A partial replay lands a state that may be wrong, and the whole point of
      // counting is that this is the only thing telling it apart from a complete
      // one.
      this.#log.warn(`dropped ${dropped} agent hook(s) before this replay — the journal was full`);
    }
  }

  #handle(client: ClientState, frame: Frame): void {
    const body = (frame.json ?? {}) as Record<string, unknown>;
    const seq = typeof body['seq'] === 'number' ? body['seq'] : -1;

    // `hello` first, always. A client speaking a different protocol version must
    // be told so rather than have its frames guessed at — a daemon left running
    // from an older build is the normal way this happens.
    if (frame.kind === REQUEST.hello) {
      const theirs = body['version'];
      if (theirs !== PROTOCOL_VERSION) {
        this.#reply(client, seq, false, {
          code: 'protocol-mismatch',
          message: `daemon speaks protocol ${PROTOCOL_VERSION}, client speaks ${String(theirs)}`,
        });
        client.connection.close();
        this.disconnect(client.id);
        return;
      }
      client.greeted = true;
      client.role = body['role'] === 'app' ? 'app' : 'device';
      this.#reply(client, seq, true, {
        version: PROTOCOL_VERSION,
        pid: process.pid,
        // Whether the APP may stand its own hook ingress down. See `setServesHooks`.
        hooks: this.#servesHooks,
      });
      /*
       * Reply, then replay, in one synchronous step.
       *
       * `PtyFanout` states the contract this borrows: snapshot, register and
       * replay are ONE step, or bytes arriving in between are either lost or
       * delivered twice. The same holds here and for the same reason — the drain
       * empties the journal, so anything recorded between the reply and the flush
       * would be held for a client that has already gone live. Nothing can arrive
       * in between because this path is synchronous, which is what makes the
       * ordering free rather than lucky.
       */
      if (client.role === 'app') this.#replayHooks(client);
      return;
    }

    if (!client.greeted) {
      this.#reply(client, seq, false, {
        code: 'not-greeted',
        message: 'send hello before anything else',
      });
      return;
    }

    switch (frame.kind) {
      case REQUEST.create: {
        /*
         * `seed` is the one field that cannot survive the cast beside it.
         *
         * It is bytes, and this frame is JSON — so it travels as base64 and has
         * to be decoded here. Left to the cast, a string would arrive where a
         * `Uint8Array` is declared, `feed` would iterate its characters as byte
         * values, and a restored pane would replay garbage. A cast is not a
         * check, and this is the field that proves it.
         */
        const raw = body['spec'] as SessionSpec & { seed?: unknown };
        const seed = typeof raw.seed === 'string' ? new Uint8Array(Buffer.from(raw.seed, 'base64')) : undefined;
        const created = this.#host.create({
          ...raw,
          ...(seed === undefined ? { seed: undefined } : { seed }),
        });
        this.#reply(client, seq, created.ok, created.ok ? created.value : created.error);
        return;
      }
      case REQUEST.attach: {
        const id = toSessionId(String(body['sessionId']));
        if (client.attachments.has(id)) {
          // Idempotent per (client, session), exactly as `SessionBridge` is:
          // a re-attach that stacked would double every byte.
          this.#reply(client, seq, true, { alreadyAttached: true });
          return;
        }
        const attached = this.#host.attach(id, (bytes) => {
          this.#send(client, encodeByteFrame(RESPONSE.data, id, bytes));
        });
        if (!attached.ok) {
          this.#reply(client, seq, false, attached.error);
          return;
        }
        client.attachments.set(id, attached.value);
        this.#reply(client, seq, true, { attached: true });
        return;
      }
      case REQUEST.detach: {
        const id = toSessionId(String(body['sessionId']));
        client.attachments.get(id)?.dispose();
        client.attachments.delete(id);
        this.#reply(client, seq, true, {});
        return;
      }
      case REQUEST.write: {
        // A BYTE frame: no seq, no reply. Acking every keystroke would put a
        // round trip in front of the one path where latency is felt.
        if (frame.sessionId !== undefined && frame.bytes !== undefined) {
          this.#host.write(toSessionId(frame.sessionId), frame.bytes);
        }
        return;
      }
      case REQUEST.paste: {
        const result = this.#host.paste(toSessionId(String(body['sessionId'])), String(body['text']));
        this.#reply(client, seq, result.ok, result.ok ? {} : result.error);
        return;
      }
      case REQUEST.resize: {
        const result = this.#host.resize(
          toSessionId(String(body['sessionId'])),
          Number(body['cols']),
          Number(body['rows']),
        );
        this.#reply(client, seq, result.ok, result.ok ? {} : result.error);
        return;
      }
      case REQUEST.setViewport: {
        const id = toSessionId(String(body['sessionId']));
        const viewport = body['viewport'] as { cols: number; rows: number } | null;
        // Scoped to the CONNECTION, so a client that goes away stops
        // constraining the pty for everyone else — see `ClientState.viewports`.
        const key = `conn-${client.id}:${String(body['viewerId'] ?? 'default')}`;
        const result = this.#host.setViewport(id, key, viewport ?? undefined);
        if (viewport === null) client.viewports.delete(id);
        else client.viewports.set(id, key);
        this.#reply(client, seq, result.ok, result.ok ? {} : result.error);
        return;
      }
      case REQUEST.kill: {
        const result = this.#host.kill(toSessionId(String(body['sessionId'])));
        this.#reply(client, seq, result.ok, result.ok ? {} : result.error);
        return;
      }
      case REQUEST.foreground: {
        // Answered even for an unknown session: `foregroundReading` is explicit
        // that a dead session is running nothing, which is knowledge rather than
        // an absence of it.
        this.#reply(client, seq, true, this.#host.foreground(toSessionId(String(body['sessionId']))));
        return;
      }
      case REQUEST.list: {
        this.#reply(client, seq, true, { sessions: this.#host.list() });
        return;
      }
      case REQUEST.screen: {
        const screen = this.#host.screen(toSessionId(String(body['sessionId'])));
        this.#reply(client, seq, screen !== undefined, screen ?? { code: 'unknown-session' });
        return;
      }
      case REQUEST.snapshot: {
        const id = toSessionId(String(body['sessionId']));
        const asked = this.#host.snapshot(id, (bytes) => {
          this.#send(client, encodeByteFrame(RESPONSE.snapshot, id, bytes));
          this.#reply(client, seq, true, { bytes: bytes.length });
        });
        if (!asked.ok) this.#reply(client, seq, false, asked.error);
        return;
      }
      default: {
        this.#reply(client, seq, false, {
          code: 'unknown-request',
          message: `no handler for frame kind ${frame.kind}`,
        });
      }
    }
  }

  #reply(client: ClientState, seq: number, ok: boolean, value: unknown): void {
    this.#send(client, encodeJsonFrame(ok ? RESPONSE.ok : RESPONSE.err, { seq, value }));
  }

  #send(client: ClientState, frame: Uint8Array): void {
    try {
      client.connection.write(frame);
    } catch (error) {
      // A dead socket is the normal way this happens, and it must not take the
      // daemon — or anyone else's session — down with it.
      this.#log.warn(`writing to client ${client.id} threw: ${String(error)}`);
    }
  }
}
