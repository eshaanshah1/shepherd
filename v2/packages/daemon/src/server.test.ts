// The daemon, against a REAL `SessionHost` and real ptys, over a fake socket.
//
// Fake socket, real pty, on purpose: the thing worth proving is what happens to
// a *process* when a *connection* goes away, and a real socket would add an
// accept loop and a flush race to every assertion without making any of them
// stronger. `main.ts` is what turns a `net.Socket` into a `Connection`.

import { afterEach, describe, expect, it } from 'vitest';
import { SessionHost, FrameDecoder, PROTOCOL_VERSION, REQUEST, RESPONSE, encodeByteFrame, encodeJsonFrame, type Frame } from '@shepherd/core';
import { createLogger, systemClock, type LogRecord } from '@shepherd/sdk';
import { SessionServer, type Connection } from './server.ts';

const decoder = new TextDecoder();

let hosts: SessionHost[] = [];
let servers: SessionServer[] = [];

afterEach(() => {
  for (const server of servers) server.dispose();
  for (const host of hosts) host.dispose();
  servers = [];
  hosts = [];
});

/** A connection that records everything written to it, already decoded. */
function fakeConnection(id: number) {
  const frames: Frame[] = [];
  const decode = new FrameDecoder();
  let closed = false;
  const connection: Connection = {
    id,
    write: (bytes) => {
      frames.push(...decode.feed(bytes).frames);
    },
    close: () => {
      closed = true;
    },
  };
  return {
    connection,
    frames,
    get closed() {
      return closed;
    },
    /** JSON replies only, newest last. */
    replies: () => frames.filter((f) => f.kind === RESPONSE.ok || f.kind === RESPONSE.err),
    /** Everything the pty produced, concatenated. */
    output: () =>
      frames
        .filter((f) => f.kind === RESPONSE.data)
        .map((f) => decoder.decode(f.bytes))
        .join(''),
  };
}

function harness() {
  const records: LogRecord[] = [];
  const host = new SessionHost();
  const server = new SessionServer({
    host,
    log: createLogger({
      clock: systemClock,
      level: 'debug',
      sink: (_line, record) => records.push(record),
    }),
  });
  hosts.push(host);
  servers.push(server);
  return { host, server, records };
}

const send = (server: SessionServer, id: number, kind: number, json: unknown) =>
  server.feed(id, encodeJsonFrame(kind as never, json));

function greet(server: SessionServer, connection: Connection, seq = 0) {
  server.accept(connection);
  send(server, connection.id, REQUEST.hello, { seq, version: PROTOCOL_VERSION });
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const SHELL = { cwd: '/tmp', command: '/bin/sh', args: [] as string[] };

describe('SessionServer handshake', () => {
  it('answers hello with its protocol version and pid', () => {
    const { server } = harness();
    const client = fakeConnection(1);
    greet(server, client.connection);

    const reply = client.replies()[0];
    expect(reply?.kind).toBe(RESPONSE.ok);
    expect((reply?.json as { value: { version: number; pid: number } }).value.version).toBe(
      PROTOCOL_VERSION,
    );
  });

  /**
   * A daemon left running from an older build is the normal way a mismatch
   * happens. It must SAY so — a daemon that guessed at frames it does not
   * understand would fail somewhere else entirely, with nothing naming the
   * cause.
   */
  it('refuses a client speaking another protocol version, and says both', () => {
    const { server } = harness();
    const client = fakeConnection(1);
    server.accept(client.connection);
    send(server, 1, REQUEST.hello, { seq: 0, version: PROTOCOL_VERSION + 99 });

    const reply = client.replies()[0];
    expect(reply?.kind).toBe(RESPONSE.err);
    const { value } = reply?.json as { value: { code: string; message: string } };
    expect(value.code).toBe('protocol-mismatch');
    expect(value.message).toContain(String(PROTOCOL_VERSION));
    expect(value.message).toContain(String(PROTOCOL_VERSION + 99));
    expect(client.closed).toBe(true);
    expect(server.clientCount).toBe(0);
  });

  it('refuses everything before hello', () => {
    const { server } = harness();
    const client = fakeConnection(1);
    server.accept(client.connection);
    send(server, 1, REQUEST.list, { seq: 1 });

    const reply = client.replies()[0];
    expect(reply?.kind).toBe(RESPONSE.err);
    expect((reply?.json as { value: { code: string } }).value.code).toBe('not-greeted');
  });
});

describe('SessionServer sessions', () => {
  it('creates a session and streams its output to an attached client', async () => {
    const { server, host } = harness();
    const client = fakeConnection(1);
    greet(server, client.connection);

    send(server, 1, REQUEST.create, { seq: 1, spec: SHELL });
    const created = client.replies()[1]?.json as { value: { id: string } };
    const id = created.value.id;
    expect(host.list()).toHaveLength(1);

    send(server, 1, REQUEST.attach, { seq: 2, sessionId: id });
    // Markers assembled by the shell, so the ECHO of the command does not
    // contain them — the same trick `host.test.ts` uses, and the same reason.
    server.feed(1, encodeByteFrame(REQUEST.write, id, new TextEncoder().encode("printf 'ov%s\\n' 'er-the-wire'\r")));
    await waitFor(() => client.output().includes('over-the-wire'), 'pty output over the wire');
  });

  /**
   * THE claim this whole process exists for.
   *
   * If a client going away could end a pty, moving sessions out of Electron
   * would buy nothing — the app quitting IS a client going away.
   */
  it('a client disconnecting detaches its viewers and KILLS NOTHING', async () => {
    const { server, host } = harness();
    const client = fakeConnection(1);
    greet(server, client.connection);
    send(server, 1, REQUEST.create, { seq: 1, spec: SHELL });
    const id = (client.replies()[1]?.json as { value: { id: string } }).value.id;
    send(server, 1, REQUEST.attach, { seq: 2, sessionId: id });
    await waitFor(() => client.output().length > 0, 'the replay');

    const pid = host.list()[0]?.pid;
    server.disconnect(1);

    expect(server.clientCount).toBe(0);
    // Still live, still the SAME pty.
    expect(host.list()).toHaveLength(1);
    expect(host.list()[0]?.pid).toBe(pid);

    // And it is still usable by a client that arrives afterwards, which is the
    // relaunch case in miniature.
    const second = fakeConnection(2);
    greet(server, second.connection, 10);
    send(server, 2, REQUEST.attach, { seq: 11, sessionId: id });
    server.feed(2, encodeByteFrame(REQUEST.write, id, new TextEncoder().encode("printf 'af%s\\n' 'ter-reconnect'\r")));
    await waitFor(() => second.output().includes('after-reconnect'), 'output after reconnecting');
  });

  it('two clients watch one session, and each gets the screen once', async () => {
    const { server } = harness();
    const a = fakeConnection(1);
    const b = fakeConnection(2);
    greet(server, a.connection);
    send(server, 1, REQUEST.create, { seq: 1, spec: SHELL });
    const id = (a.replies()[1]?.json as { value: { id: string } }).value.id;

    send(server, 1, REQUEST.attach, { seq: 2, sessionId: id });
    server.feed(1, encodeByteFrame(REQUEST.write, id, new TextEncoder().encode("printf 'sh%s\\n' 'ared-marker'\r")));
    await waitFor(() => a.output().includes('shared-marker'), 'the first viewer');

    greet(server, b.connection, 10);
    send(server, 2, REQUEST.attach, { seq: 11, sessionId: id });
    await waitFor(() => b.output().includes('shared-marker'), 'the second viewer’s replay');
    // Exactly once: R0's no-duplicate contract, now across a process boundary.
    expect(b.output().split('shared-marker')).toHaveLength(2);
  });

  it('is idempotent per (client, session), so a re-attach cannot double bytes', async () => {
    const { server } = harness();
    const client = fakeConnection(1);
    greet(server, client.connection);
    send(server, 1, REQUEST.create, { seq: 1, spec: SHELL });
    const id = (client.replies()[1]?.json as { value: { id: string } }).value.id;

    send(server, 1, REQUEST.attach, { seq: 2, sessionId: id });
    await waitFor(() => client.output().length > 0, 'the first replay');
    send(server, 1, REQUEST.attach, { seq: 3, sessionId: id });

    const second = client.replies().find((r) => (r.json as { seq: number }).seq === 3);
    expect((second?.json as { value: { alreadyAttached: boolean } }).value.alreadyAttached).toBe(true);

    server.feed(1, encodeByteFrame(REQUEST.write, id, new TextEncoder().encode("printf 'on%s\\n' 'ce-only'\r")));
    await waitFor(() => client.output().includes('once-only'), 'the marker');
    expect(client.output().split('once-only')).toHaveLength(2);
  });

  it('tells every watcher when a session exits, and forgets it', async () => {
    const { server, host } = harness();
    const client = fakeConnection(1);
    greet(server, client.connection);
    send(server, 1, REQUEST.create, {
      seq: 1,
      spec: { cwd: '/tmp', command: '/bin/sh', args: ['-c', 'exit 3'] },
    });
    const id = (client.replies()[1]?.json as { value: { id: string } }).value.id;
    send(server, 1, REQUEST.attach, { seq: 2, sessionId: id });

    await waitFor(
      () => client.frames.some((f) => f.kind === RESPONSE.exit),
      'the exit frame',
    );
    const exit = client.frames.find((f) => f.kind === RESPONSE.exit);
    expect((exit?.json as { exitCode: number }).exitCode).toBe(3);
    expect(host.list()).toHaveLength(0);
  });

  it('reports a resize and a screen through the wire', async () => {
    const { server } = harness();
    const client = fakeConnection(1);
    greet(server, client.connection);
    send(server, 1, REQUEST.create, { seq: 1, spec: { ...SHELL, cols: 80, rows: 24 } });
    const id = (client.replies()[1]?.json as { value: { id: string } }).value.id;

    send(server, 1, REQUEST.resize, { seq: 2, sessionId: id, cols: 100, rows: 30 });
    send(server, 1, REQUEST.screen, { seq: 3, sessionId: id });
    const screen = client.replies().find((r) => (r.json as { seq: number }).seq === 3);
    expect((screen?.json as { value: { cols: number; rows: number } }).value).toMatchObject({
      cols: 100,
      rows: 30,
    });
  });

  /** A viewer with no opinion never resizes the pty — scoped to the connection. */
  it('scopes a viewport to the connection, so a departing client stops constraining it', async () => {
    const { server, host } = harness();
    const a = fakeConnection(1);
    const b = fakeConnection(2);
    greet(server, a.connection);
    send(server, 1, REQUEST.create, { seq: 1, spec: { ...SHELL, cols: 80, rows: 24 } });
    const id = (a.replies()[1]?.json as { value: { id: string } }).value.id;

    send(server, 1, REQUEST.setViewport, { seq: 2, sessionId: id, viewport: { cols: 200, rows: 50 } });
    expect(host.get(id as never)).toMatchObject({ cols: 200, rows: 50 });

    greet(server, b.connection, 10);
    send(server, 2, REQUEST.setViewport, { seq: 11, sessionId: id, viewport: { cols: 60, rows: 20 } });
    expect(host.get(id as never)).toMatchObject({ cols: 60, rows: 20 });

    // The small client leaves; the big one stops being letterboxed. This is the
    // phone-goes-away case, and it works because the key is the CONNECTION.
    server.disconnect(2);
    send(server, 1, REQUEST.setViewport, { seq: 3, sessionId: id, viewport: { cols: 200, rows: 50 } });
    expect(host.get(id as never)).toMatchObject({ cols: 200, rows: 50 });
  });
});

describe('SessionServer refusals', () => {
  it('drops a connection that sends an unusable frame, and says why', () => {
    const { server, records } = harness();
    const client = fakeConnection(1);
    greet(server, client.connection);

    // A length beyond the cap: unrecoverable, because there is no framing marker
    // to resynchronize on.
    const header = new Uint8Array(5);
    new DataView(header.buffer).setUint32(0, 0x7fffffff, true);
    header[4] = REQUEST.list;
    server.feed(1, header);

    expect(client.closed).toBe(true);
    expect(server.clientCount).toBe(0);
    expect(records.some((r) => r.level === 'error' && r.message.includes('frame-too-large'))).toBe(
      true,
    );
  });

  it('answers an unknown session with a typed error rather than throwing', () => {
    const { server } = harness();
    const client = fakeConnection(1);
    greet(server, client.connection);
    send(server, 1, REQUEST.attach, { seq: 1, sessionId: 'nope' });

    const reply = client.replies()[1];
    expect(reply?.kind).toBe(RESPONSE.err);
    expect((reply?.json as { value: { code: string } }).value.code).toBe('unknown-session');
  });
});
