import { describe, expect, it } from 'vitest';
import { nullLogger } from '@shepherd/sdk';
import {
  FrameDecoder,
  PROTOCOL_VERSION,
  REQUEST,
  RESPONSE,
  encodeJsonFrame,
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
