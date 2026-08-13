import { describe, expect, it } from 'vitest';
import { nullLogger, sessionId as toSessionId, type SessionID } from '@shepherd/sdk';
import {
  FrameDecoder,
  PROTOCOL_VERSION,
  REQUEST,
  RESPONSE,
  encodeJsonFrame,
  type SessionInfo,
} from '@shepherd/core';
import { SessionClient, type ClientSocket, type SessionClientOptions } from './session-client.ts';

/**
 * The handshake, and only the handshake.
 *
 * It is the one exchange whose failure mode is a **stale daemon**, which is not
 * an exotic state: the daemon is detached to outlive the app and
 * `reclaimSocketPath` refuses to take over a live socket, so every `pnpm ship`
 * leaves a new build talking to the previous build's daemon for as long as that
 * process lives. `SessionServer` is built for it — it compares
 * `PROTOCOL_VERSION`, refuses, and says so in a message carrying both versions.
 *
 * The client threw that message away. It resolved on ANY reply, ignored the `ok`
 * flag, marked itself connected, flushed its outbox and re-attached into a socket
 * the daemon had already closed. Everything then silently did not work, with the
 * explanation sitting unread in a frame it had already received.
 */

/** A socket the test drives: it records what was written and injects replies. */
class FakeSocket implements ClientSocket {
  readonly written: Uint8Array[] = [];
  destroyed = false;
  #data: (bytes: Uint8Array) => void = () => undefined;
  #close: () => void = () => undefined;

  write(bytes: Uint8Array): void {
    this.written.push(bytes);
  }
  destroy(): void {
    this.destroyed = true;
    // A real socket's close follows its destroy, and the retry is scheduled from
    // there — so a fake that stayed silent would hide the reconnect path.
    this.#close();
  }
  onData(fn: (bytes: Uint8Array) => void): void {
    this.#data = fn;
  }
  onClose(fn: () => void): void {
    this.#close = fn;
  }
  onError(): void {
    /* not exercised here */
  }

  /** Push a frame down as if the daemon had sent it. */
  send(bytes: Uint8Array): void {
    this.#data(bytes);
  }

  /** The frames this socket was asked to write, decoded. */
  sent(): { kind: number; json: Record<string, unknown> }[] {
    const decoder = new FrameDecoder();
    const out: { kind: number; json: Record<string, unknown> }[] = [];
    for (const bytes of this.written) {
      for (const frame of decoder.feed(bytes).frames) {
        out.push({ kind: frame.kind, json: (frame.json ?? {}) as Record<string, unknown> });
      }
    }
    return out;
  }
}

/** The logger, recording so a test can assert what was REPORTED. */
function recordingLog() {
  const lines: string[] = [];
  const sink = (level: string) => (line: string) => void lines.push(`${level}: ${line}`);
  const log = {
    ...nullLogger,
    child: () => log,
    debug: sink('debug'),
    info: sink('info'),
    warn: sink('warn'),
    error: sink('error'),
  } as unknown as SessionClientOptions['log'];
  return { log, lines };
}

/** Let the client's own promise chain run to a stop. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
};

/** The seq the client used for its hello, read back off the wire. */
function helloSeq(socket: FakeSocket): number {
  const hello = socket.sent().find((frame) => frame.kind === REQUEST.hello);
  expect(hello).toBeDefined();
  return hello?.json['seq'] as number;
}

describe('the daemon handshake', () => {
  const clientFor = (socket: FakeSocket) => {
    const { log, lines } = recordingLog();
    const client = new SessionClient({
      connect: () => Promise.resolve(socket),
      log,
      // Long, so nothing reconnects mid-assertion. The retry itself is the
      // subject of its own test below, which drives it explicitly.
      retryMs: 60_000,
    });
    return { client, lines };
  };

  it('sends hello first, carrying its own protocol version', async () => {
    const socket = new FakeSocket();
    const { client } = clientFor(socket);
    void client.start();
    await settle();

    const first = socket.sent()[0];
    expect(first?.kind).toBe(REQUEST.hello);
    expect(first?.json['version']).toBe(PROTOCOL_VERSION);
    client.dispose();
  });

  it('reports the daemon‘s OWN refusal, so a stale daemon names itself', async () => {
    const socket = new FakeSocket();
    const { client, lines } = clientFor(socket);
    void client.start();
    await settle();

    // Exactly what `SessionServer` sends a client it will not speak to.
    socket.send(
      encodeJsonFrame(RESPONSE.err, {
        seq: helloSeq(socket),
        value: {
          code: 'protocol-mismatch',
          message: 'daemon speaks protocol 1, client speaks 2',
        },
      }),
    );
    await settle();

    // The message the daemon went to the trouble of composing, in the log.
    expect(lines.join('\n')).toContain('daemon speaks protocol 1, client speaks 2');
    client.dispose();
  });

  it('does NOT flush its outbox to a daemon that refused it', async () => {
    // The half that made the old bug destructive rather than merely quiet: the
    // client believed it was connected and started talking.
    const socket = new FakeSocket();
    const { client } = clientFor(socket);
    void client.start();
    await settle();
    const beforeRefusal = socket.sent().length;

    socket.send(
      encodeJsonFrame(RESPONSE.err, {
        seq: helloSeq(socket),
        value: { code: 'protocol-mismatch', message: 'daemon speaks protocol 1, client speaks 2' },
      }),
    );
    await settle();

    expect(socket.sent().length).toBe(beforeRefusal);
    client.dispose();
  });

  it('lets go of the refused socket, so a retry can be scheduled at all', async () => {
    /*
     * `#ensureConnected` returns early while a socket is held, so a refused
     * handshake that kept one would leave the client holding a connection it must
     * not use and no reconnect would ever be scheduled — the same defect one layer
     * quieter.
     */
    const socket = new FakeSocket();
    const { client } = clientFor(socket);
    void client.start();
    await settle();

    socket.send(
      encodeJsonFrame(RESPONSE.err, {
        seq: helloSeq(socket),
        value: { code: 'protocol-mismatch', message: 'daemon speaks protocol 1, client speaks 2' },
      }),
    );
    await settle();

    expect(socket.destroyed).toBe(true);
    client.dispose();
  });

  it('proceeds normally when the daemon greets it back', async () => {
    const socket = new FakeSocket();
    const { client, lines } = clientFor(socket);
    void client.start();
    await settle();

    socket.send(
      encodeJsonFrame(RESPONSE.ok, {
        seq: helloSeq(socket),
        value: { version: PROTOCOL_VERSION, pid: 4242 },
      }),
    );
    await settle();

    expect(socket.destroyed).toBe(false);
    expect(lines.join('\n')).not.toContain('could not reach the session daemon');
    client.dispose();
  });
});

/**
 * What happens when the daemon is REPLACED rather than merely disconnected.
 *
 * Measured on a live app before this existed: main had run since 15:19 and was
 * talking to a daemon started at 16:34, holding four sessions of which only two
 * had a process. The other two were ptys of the daemon that had gone, and every
 * layer told the truth on its own:
 *
 *   - the mirror is cleared and refilled only in `start()`, so a reconnect kept
 *     believing in them;
 *   - `#reattachAll` sent its attach with `#send`, registering no `#pending`, so
 *     the daemon's `unknown-session` refusal arrived and was dropped by
 *     `#onFrame` for want of anyone waiting on that seq;
 *   - `SessionHost.foreground` answers `hasForegroundProcess: false` for an id it
 *     has never heard of, which reads as a healthy shell sitting at a prompt.
 *
 * The pane stayed black for the rest of the app's life with nothing anywhere
 * saying why, while panes opened after the restart worked — "streaming is broken
 * on some panes".
 */
describe('a daemon that restarted underneath us', () => {
  const ALIVE = toSessionId('11111111-1111-4111-8111-111111111111');
  const GHOST = toSessionId('22222222-2222-4222-8222-222222222222');

  const infoFor = (id: SessionID): SessionInfo => ({
    id,
    pid: 4242,
    cwd: '/tmp',
    command: '/bin/zsh',
    args: ['-l'],
    cols: 80,
    rows: 24,
  });

  /** A client whose `connect` hands out the given sockets, in order. */
  function reconnecting(sockets: readonly FakeSocket[]) {
    const { log, lines } = recordingLog();
    let next = 0;
    const client = new SessionClient({
      connect: () => {
        const socket = sockets[next];
        next += 1;
        if (socket === undefined) throw new Error('the test ran out of sockets');
        return Promise.resolve(socket);
      },
      log,
      retryMs: 0,
    });
    return { client, lines };
  }

  /** The seq of the first frame of `kind` this socket was asked to write. */
  const seqOf = (socket: FakeSocket, kind: number): number =>
    socket.sent().find((frame) => frame.kind === kind)?.json['seq'] as number;

  const framesOf = (socket: FakeSocket, kind: number) =>
    socket.sent().filter((frame) => frame.kind === kind);

  /** Answer the hello the client writes as soon as it holds a socket. */
  async function greet(socket: FakeSocket): Promise<void> {
    await settle();
    socket.send(
      encodeJsonFrame(RESPONSE.ok, {
        seq: seqOf(socket, REQUEST.hello),
        value: { version: PROTOCOL_VERSION, pid: 4242 },
      }),
    );
    await settle();
  }

  /** Answer the inventory request with exactly these sessions. */
  async function inventory(socket: FakeSocket, sessions: readonly SessionInfo[]): Promise<void> {
    socket.send(
      encodeJsonFrame(RESPONSE.ok, {
        seq: seqOf(socket, REQUEST.list),
        value: { sessions },
      }),
    );
    await settle();
  }

  /** A real socket's close lands on a macrotask, and so does the retry. */
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  /** Boot against `first`, holding one viewer of `GHOST`, then lose the socket. */
  async function bootAndDrop(first: FakeSocket, exits: string[], client: SessionClient) {
    void client.start();
    await greet(first);
    await inventory(first, [infoFor(GHOST)]);
    client.onExit((exit) => exits.push(exit.sessionId));
    const attached = client.attach(GHOST, () => undefined);
    expect(attached.ok).toBe(true);
    first.destroy();
    await tick();
  }

  it('buries a session the replacement daemon has never heard of', async () => {
    const [first, second] = [new FakeSocket(), new FakeSocket()];
    const exits: string[] = [];
    const { client } = reconnecting([first, second]);
    await bootAndDrop(first, exits, client);

    // The replacement daemon is empty: this is a fresh process, and the ptys of
    // the old one died with it.
    await greet(second);
    await inventory(second, []);

    expect(exits).toContain(GHOST);
    expect(client.has(GHOST)).toBe(false);
    client.dispose();
  });

  it('does not re-attach a viewer to a session that is gone', async () => {
    const [first, second] = [new FakeSocket(), new FakeSocket()];
    const exits: string[] = [];
    const { client } = reconnecting([first, second]);
    await bootAndDrop(first, exits, client);

    await greet(second);
    await inventory(second, []);

    // A pane wired to nothing is the whole defect. Re-attaching would earn the
    // refusal that used to be discarded; not sending it is the honest answer.
    expect(framesOf(second, REQUEST.attach)).toHaveLength(0);
    client.dispose();
  });

  it('keeps a session the replacement daemon still holds', async () => {
    // The other half: a daemon that merely dropped its socket must not lose its
    // sessions, or a hiccup would kill every terminal in the app.
    const [first, second] = [new FakeSocket(), new FakeSocket()];
    const exits: string[] = [];
    const { client } = reconnecting([first, second]);
    await bootAndDrop(first, exits, client);

    await greet(second);
    await inventory(second, [infoFor(GHOST)]);

    expect(exits).toHaveLength(0);
    expect(client.has(GHOST)).toBe(true);
    expect(framesOf(second, REQUEST.attach)).toHaveLength(1);
    client.dispose();
  });

  it('adopts a session the replacement daemon has and we do not', async () => {
    const [first, second] = [new FakeSocket(), new FakeSocket()];
    const exits: string[] = [];
    const { client } = reconnecting([first, second]);
    await bootAndDrop(first, exits, client);

    await greet(second);
    await inventory(second, [infoFor(GHOST), infoFor(ALIVE)]);

    expect(client.has(ALIVE)).toBe(true);
    client.dispose();
  });

  it('reports a refused re-attach instead of dropping the daemon‘s answer', async () => {
    const [first, second] = [new FakeSocket(), new FakeSocket()];
    const exits: string[] = [];
    const { client, lines } = reconnecting([first, second]);
    await bootAndDrop(first, exits, client);

    // The inventory says it is there, so a re-attach is sent — and refused
    // anyway. Belt and braces: the two answers disagree, and the refusal is the
    // one that was measured against a real pty.
    await greet(second);
    await inventory(second, [infoFor(GHOST)]);
    second.send(
      encodeJsonFrame(RESPONSE.err, {
        seq: seqOf(second, REQUEST.attach),
        value: { code: 'unknown-session', message: `no live session ${GHOST}` },
      }),
    );
    await settle();

    expect(lines.join('\n')).toContain('unknown-session');
    expect(exits).toContain(GHOST);
    client.dispose();
  });

  it('keeps every session when the replacement daemon does not answer at all', async () => {
    /*
     * The conservative half, and the same rule `foreground` keeps one process
     * along: "I could not look" must never be reported as "nothing is there".
     * Burying live sessions because the inventory timed out would turn a slow
     * daemon into a lost afternoon of agent work.
     */
    const [first, second] = [new FakeSocket(), new FakeSocket()];
    const exits: string[] = [];
    const { client } = reconnecting([first, second]);
    await bootAndDrop(first, exits, client);

    await greet(second);
    // No inventory reply — the request is left to its deadline.
    await settle();

    expect(exits).toHaveLength(0);
    expect(client.has(GHOST)).toBe(true);
    client.dispose();
  });
});

/**
 * Agent hooks, arriving from the daemon rather than from a socket this process
 * opened.
 *
 * The daemon serves `hooks.sock` because it is the process that outlives the app:
 * an agent goes on firing hooks into a pty it owns while the app is being
 * replaced, and `report.sh` finds no socket and exits 0 by design. Those events
 * reach main as frames now, and main re-emits them onto its own bus.
 */
describe('agent hooks over the session protocol', () => {
  const clientFor = (socket: FakeSocket) => {
    const { log, lines } = recordingLog();
    const client = new SessionClient({
      connect: () => Promise.resolve(socket),
      log,
      retryMs: 60_000,
    });
    return { client, lines };
  };

  /** Greets and answers, carrying whatever capability the daemon claims. */
  const handshake = async (socket: FakeSocket, value: Record<string, unknown>): Promise<void> => {
    socket.send(
      encodeJsonFrame(RESPONSE.ok, {
        seq: helloSeq(socket),
        value: { version: PROTOCOL_VERSION, pid: 1, ...value },
      }),
    );
    await settle();
  };

  it('says it is the APP, so a phone cannot swallow its replay', async () => {
    // A device is a full session client in the daemon's same table. Without this
    // field, plugging in a phone would consume the journal the Mac was waiting
    // for and discard every state earned while the app was closed.
    const socket = new FakeSocket();
    const { client } = clientFor(socket);
    void client.start();
    await settle();

    expect(socket.sent()[0]?.json['role']).toBe('app');
    client.dispose();
  });

  it('hands a hooked frame to its listener', async () => {
    const socket = new FakeSocket();
    const { client } = clientFor(socket);
    const seen: { topic: string; sessionId: string; payload: unknown }[] = [];
    client.onHooked((envelope) => void seen.push(envelope));
    void client.start();
    await settle();
    await handshake(socket, { hooks: true });

    socket.send(
      encodeJsonFrame(RESPONSE.hooked, {
        topic: 'claude.hook',
        sessionId: 'session-1',
        payload: { event: 'Stop' },
      }),
    );

    expect(seen).toEqual([
      { topic: 'claude.hook', sessionId: 'session-1', payload: { event: 'Stop' } },
    ]);
    client.dispose();
  });

  it('reports a daemon that serves the hook socket', async () => {
    const socket = new FakeSocket();
    const { client } = clientFor(socket);
    void client.start();
    await settle();
    await handshake(socket, { hooks: true });

    expect(client.daemonServesHooks).toBe(true);
    client.dispose();
  });

  it('reports an OLD daemon that does not, so main serves hooks itself', async () => {
    // THE upgrade case, and why this is advertised rather than settled by a
    // protocol bump: a mismatch is refused, so a new app would find its terminals
    // dead against the old daemon — and it cannot replace that daemon without
    // killing every agent the user is running.
    const socket = new FakeSocket();
    const { client } = clientFor(socket);
    void client.start();
    await settle();
    await handshake(socket, {});

    expect(client.daemonServesHooks).toBe(false);
    client.dispose();
  });
});
