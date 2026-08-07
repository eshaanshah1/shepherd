import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { chmod } from 'node:fs/promises';
import { err, ok, toDisposable, type Disposable, type Logger, type Result } from '@shepherd/sdk';
import { reclaimSocketPath } from './socket-path.ts';

/**
 * HTTP over a unix socket — the transport both ingresses share.
 *
 * v1's hook channel did one blocking `read()` inline on the accept thread, with
 * an 8KB buffer, no timeout and no read-to-EOF loop. Three consequences, all of
 * them real:
 *
 *   - a short read (legal at any size on a stream socket) or an oversized
 *     `AskUserQuestion` payload **silently dropped the whole event** — the pane
 *     never went blocked, no banner, no push;
 *   - a client that connected and wrote nothing wedged the accept loop
 *     **forever**, freezing state for every pane in the app;
 *   - and because hooks are synchronous, a wedged server hung the hook, which
 *     hung the agent's turn. **The observer stalled the observed.**
 *
 * `http.createServer` over a unix path is the fix and it is barely code: framing,
 * a real ack, a request timeout and a body cap all come for free, requests are
 * concurrent, and `curl --unix-socket` is far more universally present with
 * consistent flags than `nc -U`. The hook itself stays shell — node's ~40ms
 * startup would reintroduce the ordering bug ADR 0004 exists to prevent.
 */

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
/**
 * Time to receive a complete request. Deliberately short: every client is local,
 * and this is the timer that answers "a client connected and wrote nothing".
 * It bounds the REQUEST, not the response, so a long-lived NDJSON subscription
 * is unaffected.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

export interface RouteRequest {
  /** Parsed JSON body, or `undefined` for a GET / empty body. */
  readonly body: unknown;
  readonly query: URLSearchParams;
}

export type RouteResponse =
  | { readonly kind: 'json'; readonly status: number; readonly body: unknown }
  /**
   * A long-lived NDJSON stream. `open` receives a `write` and returns the
   * subscription to dispose when the client goes away.
   *
   * This is what makes `shepherd wait` a subscription rather than v1's 200ms
   * client-side poll — which issued up to 1,500 round-trips and, because it
   * *sampled states*, missed any transition faster than its own interval.
   */
  | { readonly kind: 'ndjson'; open(write: (payload: unknown) => void): Disposable };

export interface Route {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  handle(request: RouteRequest): Promise<RouteResponse> | RouteResponse;
}

export interface UnixHttpServerOptions {
  readonly path: string;
  readonly logger: Logger;
  readonly routes: readonly Route[];
  readonly maxBodyBytes?: number;
  readonly requestTimeoutMs?: number;
  /** For a log line, so two ingresses are distinguishable. */
  readonly name: string;
}

export class UnixHttpServer {
  readonly #options: UnixHttpServerOptions;
  readonly #log;
  readonly #maxBody: number;
  readonly #streams = new Set<Disposable>();
  #server: Server | undefined;

  constructor(options: UnixHttpServerOptions) {
    this.#options = options;
    this.#log = options.logger.child('ingress');
    this.#maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  }

  async start(): Promise<Result<void, string>> {
    const reclaimed = await reclaimSocketPath(this.#options.path, this.#options.logger);
    if (!reclaimed.ok) return err(reclaimed.error);

    const server = createServer((request, response) => {
      void this.#dispatch(request, response);
    });

    // Bounds "connected and wrote nothing" without touching response duration.
    server.headersTimeout = this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    server.requestTimeout = this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    // A per-connection error must never reach the process. v1's accept loops
    // `break`d on any non-EINTR failure, leaving the listening fd open with
    // nobody accepting — the socket file looks healthy, the backlog fills, and
    // every later client gets ECONNREFUSED for the rest of the app's life.
    server.on('clientError', (error, socket) => {
      this.#log.warn(`${this.#options.name}: malformed request: ${messageOf(error)}`);
      socket.destroy();
    });
    server.on('error', (error) => {
      this.#log.error(`${this.#options.name}: server error: ${messageOf(error)}`);
    });

    const listening = await listen(server, this.#options.path);
    if (!listening.ok) {
      this.#log.error(`${this.#options.name}: could not listen on ${this.#options.path}: ${listening.error}`);
      return listening;
    }

    // The socket is the app's control surface; anyone who can open it can drive
    // it. 0600 is the difference between "local user" and "any process on a
    // shared machine".
    try {
      await chmod(this.#options.path, 0o600);
    } catch (error) {
      this.#log.warn(`${this.#options.name}: could not chmod ${this.#options.path}: ${messageOf(error)}`);
    }

    this.#server = server;
    this.#log.info(`${this.#options.name} listening on ${this.#options.path}`);
    return ok(undefined);
  }

  async stop(): Promise<void> {
    for (const stream of [...this.#streams]) stream.dispose();
    this.#streams.clear();
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // `close` waits for open connections, and an NDJSON subscriber has one by
      // definition. The sockets were disposed above; this ends the rest.
      server.closeAllConnections();
    });
  }

  async #dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // A socket error mid-request is normal (the client went away) and must not
    // become an unhandled 'error' event.
    request.on('error', (error) => this.#log.debug(`${this.#options.name}: request socket: ${messageOf(error)}`));
    response.on('error', (error) => this.#log.debug(`${this.#options.name}: response socket: ${messageOf(error)}`));

    const url = new URL(request.url ?? '/', 'http://unix');
    const route = this.#options.routes.find(
      (candidate) => candidate.method === request.method && candidate.path === url.pathname,
    );
    if (!route) {
      // Never a silent 200. An unknown path is a caller bug and must read as one.
      this.#log.warn(`${this.#options.name}: no route for ${request.method} ${url.pathname}`);
      return sendJson(response, 404, { ok: false, error: { code: 'no-route', message: `no ${request.method} ${url.pathname}` } });
    }

    const read = await readBody(request, this.#maxBody);
    if (!read.ok) {
      this.#log.warn(`${this.#options.name}: ${url.pathname}: ${read.error.message}`);
      return sendJson(response, read.error.status, { ok: false, error: { code: read.error.code, message: read.error.message } });
    }

    let result: RouteResponse;
    try {
      result = await route.handle({ body: read.value, query: url.searchParams });
    } catch (error) {
      // A route that throws is a bug in us, not in the caller. It gets a 500 and
      // a log line, and the server stays up.
      this.#log.error(`${this.#options.name}: ${url.pathname} threw: ${messageOf(error)}`);
      return sendJson(response, 500, { ok: false, error: { code: 'internal', message: messageOf(error) } });
    }

    if (result.kind === 'json') return sendJson(response, result.status, result.body);
    this.#openStream(result, response);
  }

  #openStream(result: Extract<RouteResponse, { kind: 'ndjson' }>, response: ServerResponse): void {
    response.writeHead(200, {
      'content-type': 'application/x-ndjson',
      // A subscription that gets buffered is a subscription that reports a
      // transition after it stopped mattering.
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    // `writeHead` only *stages* the head — node flushes it on the first `write`.
    // Without this the client receives nothing until the first event arrives, so
    // it cannot tell "subscribed, nothing has happened yet" from "still
    // connecting", and a `shepherd wait` on a quiet pane looks like a hang. It
    // also deadlocks any caller that waits for the response before triggering
    // the thing it is waiting for.
    response.flushHeaders();

    const subscription = result.open((payload) => {
      if (response.writableEnded) return;
      response.write(`${JSON.stringify(payload)}\n`);
    });

    const cleanup = toDisposable(() => {
      subscription.dispose();
      this.#streams.delete(cleanup);
      if (!response.writableEnded) response.end();
    });
    this.#streams.add(cleanup);
    response.on('close', () => cleanup.dispose());
  }
}

interface BodyError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

/**
 * Reads to EOF with a cap, then parses.
 *
 * The cap is enforced **as bytes arrive**, not after: a client that streams
 * gigabytes must be cut off rather than buffered first. And an empty body is
 * `undefined` rather than an error, because a GET has none and a command with no
 * arguments legitimately sends none.
 */
function readBody(request: IncomingMessage, maxBytes: number): Promise<Result<unknown, BodyError>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;

    const finish = (result: Result<unknown, BodyError>): void => {
      if (done) return;
      done = true;
      resolve(result);
    };

    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        finish(err({ status: 413, code: 'body-too-large', message: `body exceeds ${maxBytes} bytes` }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') return finish(ok(undefined));
      try {
        finish(ok(JSON.parse(text)));
      } catch (error) {
        finish(err({ status: 400, code: 'bad-json', message: `body is not JSON: ${messageOf(error)}` }));
      }
    });

    request.on('error', (error) => {
      finish(err({ status: 400, code: 'read-failed', message: `could not read body: ${messageOf(error)}` }));
    });
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return;
  const text = JSON.stringify(body ?? null);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

function listen(server: Server, path: string): Promise<Result<void, string>> {
  return new Promise((resolve) => {
    const onError = (error: unknown): void => {
      server.removeListener('listening', onListening);
      resolve(err(messageOf(error)));
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve(ok(undefined));
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ path });
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
