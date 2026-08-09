import {
  FrameDecoder,
  PROTOCOL_VERSION,
  REQUEST,
  RESPONSE,
  encodeByteFrame,
  encodeJsonFrame,
  type Frame,
  type SessionHost,
  type SessionSpec,
} from '@shepherd/core';
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
 * `main.ts` is the twenty lines that supply a real `net.Socket`.
 *
 * **The rule this whole process exists to enforce:** a connection going away
 * detaches its viewers and KILLS NOTHING. That is R0's "a session outlives its
 * view" at a process boundary, and it is the entire milestone — if a client
 * disconnect could end a pty, moving sessions out of Electron would buy nothing.
 */

/** What the server needs from one client. A `net.Socket` satisfies it. */
export interface Connection {
  /** Stable per connection; used for logging and viewer bookkeeping. */
  readonly id: number;
  write(bytes: Uint8Array): void;
  close(): void;
}

export interface SessionServerOptions {
  readonly host: SessionHost;
  readonly log: Logger;
}

interface ClientState {
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
}

export class SessionServer {
  readonly #host: SessionHost;
  readonly #log: CategoryLogger;
  readonly #clients = new Map<number, ClientState>();
  readonly #hostExit: Disposable;

  constructor(options: SessionServerOptions) {
    this.#host = options.host;
    this.#log = options.log.child('session');
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
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  accept(connection: Connection): void {
    this.#clients.set(connection.id, {
      connection,
      decoder: new FrameDecoder(),
      attachments: new Map(),
      viewports: new Map(),
      greeted: false,
    });
    this.#log.info(`client ${connection.id} connected (${this.#clients.size} total)`);
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
    for (const id of [...this.#clients.keys()]) this.disconnect(id);
  }

  // ------------------------------------------------------------------ internals

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
        this.disconnect(client.connection.id);
        return;
      }
      client.greeted = true;
      this.#reply(client, seq, true, { version: PROTOCOL_VERSION, pid: process.pid });
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
        const created = this.#host.create(body['spec'] as SessionSpec);
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
        const key = `conn-${client.connection.id}:${String(body['viewerId'] ?? 'default')}`;
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
      this.#log.warn(`writing to client ${client.connection.id} threw: ${String(error)}`);
    }
  }
}
