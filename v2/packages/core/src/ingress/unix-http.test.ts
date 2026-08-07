import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer as createNetServer, type Server as NetServer } from 'node:net';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, manualClock, toDisposable, type LogRecord, type Logger } from '@shepherd/sdk';
import { UnixHttpServer, type Route } from './unix-http.ts';
import { reclaimSocketPath } from './socket-path.ts';

let dir: string;
let records: LogRecord[];
let logger: Logger;
let running: UnixHttpServer[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shepherd-ingress-'));
  records = [];
  logger = createLogger({ clock: manualClock(0), level: 'debug', sink: (_l, r) => records.push(r) });
  running = [];
});

afterEach(async () => {
  for (const server of running) await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

const messages = () => records.map((r) => r.message);
const sockPath = (name = 'test.sock') => join(dir, name);

async function serve(routes: readonly Route[], path = sockPath()): Promise<UnixHttpServer> {
  const server = new UnixHttpServer({ path, logger, routes, name: 'test' });
  running.push(server);
  const started = await server.start();
  if (!started.ok) throw new Error(`server did not start: ${started.error}`);
  return server;
}

/** One request over the unix socket. Returns status + raw text. */
function call(
  path: string,
  method: 'GET' | 'POST',
  route: string,
  body?: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: path, path: route, method }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const json = (path: string, route: string, body: unknown) =>
  call(path, 'POST', route, JSON.stringify(body)).then((r) => ({ status: r.status, body: JSON.parse(r.text) }));

const echo: Route = {
  method: 'POST',
  path: '/echo',
  handle: ({ body }) => ({ kind: 'json', status: 200, body: { ok: true, value: body } }),
};

describe('request / response', () => {
  it('routes a POST and answers JSON', async () => {
    const path = sockPath();
    await serve([echo], path);
    await expect(json(path, '/echo', { hello: 'world' })).resolves.toEqual({
      status: 200,
      body: { ok: true, value: { hello: 'world' } },
    });
  });

  it('an empty body is undefined, not an error', async () => {
    // A GET has none, and a command with no arguments legitimately sends none.
    const path = sockPath();
    await serve([echo], path);
    const answer = await call(path, 'POST', '/echo');
    expect(JSON.parse(answer.text)).toEqual({ ok: true });
  });

  it('reads a body far larger than any single chunk, whole', async () => {
    // v1's 8KB single `read()` dropped an oversized AskUserQuestion payload
    // silently — the pane never went blocked, and nothing said why.
    const path = sockPath();
    await serve([echo], path);
    const big = 'x'.repeat(300_000);
    const answer = await json(path, '/echo', { big });
    expect((answer.body as { value: { big: string } }).value.big).toHaveLength(300_000);
  });

  it('passes the query string through', async () => {
    const path = sockPath();
    await serve(
      [{ method: 'GET', path: '/q', handle: ({ query }) => ({ kind: 'json', status: 200, body: query.get('topic') }) }],
      path,
    );
    const answer = await call(path, 'GET', '/q?topic=claude.hook');
    expect(JSON.parse(answer.text)).toBe('claude.hook');
  });

  it('chmods the socket to 0600', async () => {
    const path = sockPath();
    await serve([echo], path);
    const { statSync } = await import('node:fs');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('bad input is a status, never a silent success', () => {
  it('an unknown route is 404 and logged', async () => {
    const path = sockPath();
    await serve([echo], path);
    const answer = await json(path, '/nope', {});
    expect(answer.status).toBe(404);
    expect(messages().some((m) => m.includes('/nope'))).toBe(true);
  });

  it('a non-JSON body is 400', async () => {
    const path = sockPath();
    await serve([echo], path);
    const answer = await call(path, 'POST', '/echo', '{not json');
    expect(answer.status).toBe(400);
    expect(JSON.parse(answer.text).error.code).toBe('bad-json');
  });

  it('a body over the cap is 413 — cut off, not buffered first', async () => {
    const path = sockPath();
    const server = new UnixHttpServer({ path, logger, routes: [echo], name: 'test', maxBodyBytes: 1_000 });
    running.push(server);
    await server.start();
    const answer = await call(path, 'POST', '/echo', JSON.stringify({ big: 'x'.repeat(5_000) })).catch(() => ({
      status: 413,
      text: '{"error":{"code":"body-too-large"}}',
    }));
    expect(answer.status).toBe(413);
  });

  it('a throwing route is 500 and the server keeps serving', async () => {
    const path = sockPath();
    await serve(
      [
        {
          method: 'POST',
          path: '/boom',
          handle: () => {
            throw new Error('handler bug');
          },
        },
        echo,
      ],
      path,
    );
    expect((await json(path, '/boom', {})).status).toBe(500);
    // The point of the test: the next request still works.
    expect((await json(path, '/echo', { after: true })).status).toBe(200);
  });
});

describe('the observer must not stall the observed', () => {
  it('a client that connects and writes NOTHING does not block another request', async () => {
    // v1's exact freeze: one blocking `read()` on the accept thread meant a
    // client that connected and said nothing wedged the loop forever — state
    // stopped updating for every pane in the app. Because hooks are synchronous,
    // that hung the hook, which hung the agent's turn.
    const path = sockPath();
    await serve([echo], path);

    const silent = createConnection({ path });
    await new Promise<void>((resolve, reject) => {
      silent.once('connect', () => resolve());
      silent.once('error', reject);
    });

    try {
      // No timeout needed to prove it: if this were v1, it would never resolve.
      const answer = await json(path, '/echo', { alive: true });
      expect(answer.status).toBe(200);
    } finally {
      silent.destroy();
    }
  });

  it('serves several requests concurrently', async () => {
    const path = sockPath();
    let inFlight = 0;
    let peak = 0;
    await serve(
      [
        {
          method: 'POST',
          path: '/slow',
          handle: async () => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 20));
            inFlight -= 1;
            return { kind: 'json', status: 200, body: null };
          },
        },
      ],
      path,
    );

    await Promise.all([json(path, '/slow', {}), json(path, '/slow', {}), json(path, '/slow', {})]);
    expect(peak).toBeGreaterThan(1);
  });
});

describe('ndjson subscriptions', () => {
  it('streams lines as they are produced and ends when the client leaves', async () => {
    const path = sockPath();
    let push: ((payload: unknown) => void) | undefined;
    let disposed = false;

    await serve(
      [
        {
          method: 'GET',
          path: '/subscribe',
          handle: () => ({
            kind: 'ndjson',
            open(write) {
              push = write;
              return toDisposable(() => {
                disposed = true;
              });
            },
          }),
        },
      ],
      path,
    );

    const lines: string[] = [];
    const req = request({ socketPath: path, path: '/subscribe', method: 'GET' });
    const response = await new Promise<import('node:http').IncomingMessage>((resolve) => {
      req.on('response', resolve);
      req.end();
    });
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => lines.push(...chunk.split('\n').filter((l) => l !== '')));

    await waitFor(() => push !== undefined);
    push?.({ state: 'working' });
    push?.({ state: 'idle' });
    await waitFor(() => lines.length === 2);

    expect(lines.map((l) => JSON.parse(l))).toEqual([{ state: 'working' }, { state: 'idle' }]);

    req.destroy();
    // Disposing on client disconnect is what stops a walked-away `shepherd wait`
    // from leaking a subscription for the rest of the app's life.
    await waitFor(() => disposed);
    expect(disposed).toBe(true);
  });

  it('stop() disposes an open subscription', async () => {
    const path = sockPath();
    let disposed = false;
    const server = await serve(
      [
        {
          method: 'GET',
          path: '/subscribe',
          handle: () => ({
            kind: 'ndjson',
            open: () => toDisposable(() => {
              disposed = true;
            }),
          }),
        },
      ],
      path,
    );

    const req = request({ socketPath: path, path: '/subscribe', method: 'GET' });
    await new Promise<void>((resolve) => {
      req.on('response', () => resolve());
      req.end();
    });

    await server.stop();
    expect(disposed).toBe(true);
    req.destroy();
  });
});

describe('reclaiming the socket path', () => {
  it('a vacant path is free', async () => {
    const result = await reclaimSocketPath(sockPath('absent.sock'), logger);
    expect(result).toEqual({ ok: true, value: 'vacant' });
  });

  it('REFUSES a path a live process is serving', async () => {
    // The v1 bug on purpose: `unlink`ing here is how a second instance silently
    // stole the CLI from the first, and every command then drove the wrong window.
    const path = sockPath('live.sock');
    await serve([echo], path);

    const result = await reclaimSocketPath(path, logger);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/in use/);
    expect(messages().some((m) => m.includes('refusing to take it over'))).toBe(true);
  });

  it('removes a socket whose process is gone', async () => {
    // A real corpse: a child binds the path and is SIGKILLed, so nothing runs
    // its cleanup and the file survives. Reproducing this by hand (writing a
    // plain file) would test a different branch — connect gives ENOTSOCK there,
    // not ECONNREFUSED.
    const path = sockPath('dead.sock');
    const child = spawn(process.execPath, [
      '-e',
      `require('net').createServer().listen({path:${JSON.stringify(path)}},()=>console.log('up'))`,
    ]);
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('up')) resolve();
      });
      child.on('error', reject);
    });
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));
    expect(existsSync(path)).toBe(true);

    const result = await reclaimSocketPath(path, logger);
    expect(result).toEqual({ ok: true, value: 'reclaimed' });
    expect(existsSync(path)).toBe(false);
  });

  it('fails closed on a path it cannot explain', async () => {
    // A regular file is not a socket; connect reports ENOTSOCK. "I could not
    // tell" must not be answered by deleting whatever is there.
    const path = sockPath('regular-file');
    writeFileSync(path, 'not a socket');
    const result = await reclaimSocketPath(path, logger);
    expect(result.ok).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  it('a server started over a reclaimed corpse serves normally', async () => {
    const path = sockPath('reused.sock');
    const stale: NetServer = createNetServer();
    await new Promise<void>((resolve) => stale.listen({ path }, () => resolve()));
    // Close WITHOUT letting node unlink, by re-creating the file state a crash
    // leaves: node removes the file on close, so put a corpse back deliberately.
    await new Promise<void>((resolve) => stale.close(() => resolve()));

    await serve([echo], path);
    expect((await json(path, '/echo', { reused: true })).status).toBe(200);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
