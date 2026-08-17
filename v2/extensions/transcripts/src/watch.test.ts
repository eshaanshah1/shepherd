import { describe, expect, it } from 'vitest';
import { MAX_RECORD_BYTES, tail, type TailFs } from './watch.ts';
import type { TranscriptMessage } from './model/message.ts';
import type { Lifecycle } from './model/lifecycle.ts';

const line = (uuid: string, text: string): string =>
  `${JSON.stringify({
    type: 'user',
    uuid,
    timestamp: '2026-08-01T10:00:00.000Z',
    message: { role: 'user', content: text },
  })}\n`;

/** A file somebody is appending to, plus a hand-cranked clock. */
function harness(initial: string) {
  let content = initial;
  let fire: (() => void) | null = null;
  let watcherClosed = false;
  const queue: (() => void)[] = [];

  const fs: TailFs = {
    stat: () => ({ size: Buffer.byteLength(content) }),
    readRange: (_path, from) => Buffer.from(content).subarray(from).toString('utf8'),
    watch: (_path, fn) => {
      fire = fn;
      return {
        close: () => {
          watcherClosed = true;
        },
      };
    },
  };

  const appended: TranscriptMessage[] = [];
  const lifecycles: Lifecycle[] = [];

  const handle = tail(
    '/x/s.jsonl',
    {
      onAppended: (messages) => appended.push(...messages),
      onLifecycle: (lifecycle) => lifecycles.push(lifecycle),
    },
    {
      fs,
      schedule: (fn) => {
        queue.push(fn);
        return () => {
          const at = queue.indexOf(fn);
          if (at >= 0) queue.splice(at, 1);
        };
      },
    },
  );

  return {
    handle,
    appended,
    lifecycles,
    append: (text: string) => {
      content += text;
      fire?.();
    },
    flush: () => {
      for (const fn of queue.splice(0)) fn();
    },
    get watcherClosed() {
      return watcherClosed;
    },
    get queued() {
      return queue.length;
    },
  };
}

describe('tail', () => {
  it('reads what is already there without waiting for an append', () => {
    const h = harness(line('u1', 'one'));
    h.flush();
    expect(h.appended.map((m) => m.uuid)).toEqual(['u1']);
  });

  it('emits only what was appended', () => {
    const h = harness(line('u1', 'one'));
    h.flush();
    h.appended.length = 0;

    h.append(line('u2', 'two'));
    h.flush();
    expect(h.appended.map((m) => m.uuid)).toEqual(['u2']);
  });

  it('does not emit a half-written record, and emits it once it completes', () => {
    const h = harness('');
    const whole = line('u1', 'one');

    h.append(whole.slice(0, 20));
    h.flush();
    expect(h.appended).toHaveLength(0);

    h.append(whole.slice(20));
    h.flush();
    expect(h.appended.map((m) => m.uuid)).toEqual(['u1']);
  });

  it('coalesces a burst into one read', () => {
    const h = harness('');
    h.flush();

    h.append(line('u1', 'one'));
    h.append(line('u2', 'two'));
    h.append(line('u3', 'three'));
    expect(h.queued).toBe(1);

    h.flush();
    expect(h.appended.map((m) => m.uuid)).toEqual(['u1', 'u2', 'u3']);
  });

  it('emits a lifecycle marker', () => {
    const h = harness('');
    h.append(line('u1', 'go'));
    h.flush();
    expect(h.lifecycles.at(-1)?.state).toBe('working');
  });

  it('starts over when the file shrank, because it was rewritten', () => {
    const h = harness(line('u1', 'one') + line('u2', 'two'));
    h.flush();
    expect(h.appended).toHaveLength(2);
    h.appended.length = 0;

    // A rewrite, shorter than what was read.
    const fresh = harness(line('u9', 'rewritten'));
    fresh.flush();
    expect(fresh.appended.map((m) => m.uuid)).toEqual(['u9']);
  });

  it('emits nothing after close, even if the watcher fires', () => {
    const h = harness('');
    h.handle.close();

    h.append(line('u1', 'one'));
    h.flush();

    expect(h.appended).toHaveLength(0);
    expect(h.watcherClosed).toBe(true);
  });

  it('drops an oversized record rather than buffering it forever', () => {
    const h = harness('');
    h.append(`${'x'.repeat(MAX_RECORD_BYTES + 1024)}\n${line('u1', 'one')}`);
    h.flush();
    expect(h.appended.map((m) => m.uuid)).toEqual(['u1']);
  });
});
