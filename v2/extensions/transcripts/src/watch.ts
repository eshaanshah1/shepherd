import { readFileSync, statSync, watch as fsWatch } from 'node:fs';
import type { Lifecycle } from './model/lifecycle.ts';
import type { TranscriptMessage } from './model/message.ts';
import { absorb, completeBytes, emptySession, type ParsedSession } from './parse/session.ts';

/**
 * Following a transcript an agent is writing right now.
 *
 * It runs the SAME fold as a cold read. A tailer with its own parser is the
 * drift this module exists to prevent, in miniature — and worse than the
 * search-vs-render case, because the two would disagree about a file that is
 * still moving.
 *
 * What it adds is an offset, a debounce, and two guards that are about failure
 * rather than success.
 *
 * This runs on the extension host's own thread, which also serves the sidebar
 * (`worker_threads` is denied to extensions), so the debounce is not a nicety:
 * an agent mid-turn appends many times a second.
 */

export const DEBOUNCE_MS = 150;

/**
 * A single record past this is skipped rather than buffered.
 *
 * The failure it prevents is unbounded: without it, one pathological line with
 * no newline after it grows the pending buffer until the host dies.
 */
export const MAX_RECORD_BYTES = 4 * 1024 * 1024;

export interface TailFs {
  stat(path: string): { readonly size: number } | null;
  readRange(path: string, from: number): string;
  watch(path: string, fn: () => void): { close(): void };
}

export interface TailEvents {
  onAppended(messages: readonly TranscriptMessage[]): void;
  onLifecycle(lifecycle: Lifecycle): void;
}

export interface Tail {
  close(): void;
}

export const nodeTailFs: TailFs = {
  stat: (path) => {
    try {
      return { size: statSync(path).size };
    } catch {
      return null;
    }
  },
  readRange: (path, from) => {
    try {
      return readFileSync(path).subarray(from).toString('utf8');
    } catch {
      return '';
    }
  },
  watch: (path, fn) => {
    const watcher = fsWatch(path, { persistent: false }, () => {
      fn();
    });
    // A watcher that errors is a file that moved or vanished. The next stat
    // answers null and the tail idles — throwing here would take down the host's
    // thread from an event nobody is awaiting.
    watcher.on('error', () => {});
    return {
      close: () => {
        watcher.close();
      },
    };
  },
};

export function tail(
  path: string,
  events: TailEvents,
  opts: { fs?: TailFs; schedule: (fn: () => void, ms: number) => () => void },
): Tail {
  const fs = opts.fs ?? nodeTailFs;
  const sessionId = (path.split('/').at(-1) ?? path).replace(/\.jsonl$/i, '');

  let session: ParsedSession = emptySession(sessionId, path);
  let offset = 0;
  let closed = false;
  let cancel: (() => void) | null = null;

  const drain = (): void => {
    if (closed) return;

    const st = fs.stat(path);
    if (st === null) return;

    // A file that shrank was rewritten rather than appended to, so the parse
    // describes bytes that no longer exist. Start over.
    if (st.size < offset) {
      session = emptySession(sessionId, path);
      offset = 0;
    }
    if (st.size === offset) return;

    const chunk = fs.readRange(path, offset);
    const consumed = completeBytes(chunk);

    if (consumed === 0) {
      // No complete record yet, which is the ordinary mid-write case and costs
      // nothing to wait on. Only the unbounded case is acted upon: skip past the
      // oversized record so one bad line cannot hold the tail forever.
      if (Buffer.byteLength(chunk) > MAX_RECORD_BYTES) {
        const nextLine = chunk.indexOf('\n');
        offset += Buffer.byteLength(
          nextLine === -1 ? chunk : chunk.slice(0, nextLine + 1),
        );
      }
      return;
    }

    const before = session.messages.length;
    const previousLifecycle = session.lifecycle;

    session = absorb(session, chunk);
    offset += consumed;

    const appended = session.messages.slice(before);
    if (appended.length > 0) events.onAppended(appended);
    if (session.lifecycle !== null && session.lifecycle !== previousLifecycle) {
      events.onLifecycle(session.lifecycle);
    }
  };

  const watcher = fs.watch(path, () => {
    if (closed) return;
    // Cancel first: a burst of appends must collapse into one read, not queue a
    // read per append.
    cancel?.();
    cancel = opts.schedule(drain, DEBOUNCE_MS);
  });

  // The first read is immediate. A caller that just opened a session should not
  // wait for the agent's next keystroke to see what is already there.
  cancel = opts.schedule(drain, 0);

  return {
    close: () => {
      closed = true;
      cancel?.();
      watcher.close();
    },
  };
}
