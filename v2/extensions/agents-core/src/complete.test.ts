import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Clock, ExecErr, ExecOk, ExecOptions, ProcessAPI } from '@shepherd/sdk';
import type { HeadlessHalf } from './kind.ts';
import { childEnv, limiter, runComplete, MAX_STDOUT_BYTES } from './complete.ts';
import type { QuickTarget } from './quick-model.ts';

/**
 * The one file in this extension that runs a program.
 *
 * Every assertion here is about the MECHANISM rather than about a vendor: what
 * the child is handed, how long it may take, how much it may say, and how many
 * may run at once. What it says is `claude-code`'s test.
 */

let dataDir: string;

beforeEach(() => {
  dataDir = join(mkdtempSync(join(tmpdir(), 'shepherd-quick-')), 'not-yet-there');
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const headless = (over: Partial<HeadlessHalf> = {}): HeadlessHalf => ({
  quickModel: 'model-q',
  argv: ({ prompt, model }) => ['fake-agent', '-p', prompt, '--model', model],
  parse: (out) => out.trim(),
  ...over,
});

const target = (over: Partial<HeadlessHalf> = {}): QuickTarget => ({
  kind: {
    id: 'fake',
    topics: [],
    reduce: () => ({ kind: 'ignore' as const, why: 'not under test' }),
    headless: headless(over),
  },
  model: 'model-q',
});

interface Seen {
  cmd?: readonly string[];
  opts?: ExecOptions;
  calls: number;
}

function fakeProcess(answer: ExecOk | ExecErr | (() => Promise<ExecOk | ExecErr>), seen: Seen): ProcessAPI {
  return {
    exec: (cmd, opts) => {
      seen.cmd = cmd;
      seen.opts = opts;
      seen.calls += 1;
      return typeof answer === 'function' ? answer() : Promise.resolve(answer);
    },
    gitRead: () => Promise.resolve({ ok: true, stdout: '', stderr: '' }),
    gitWrite: () => Promise.resolve({ ok: true, stdout: '', stderr: '' }),
  };
}

/** Reads off a script, so elapsed time is a fact of the test rather than a race. */
const clockAt = (times: readonly number[]): Clock => {
  let index = 0;
  return {
    now: () => times[Math.min(index++, times.length - 1)] ?? 0,
  } as Clock;
};

const seenNow = (): Seen => ({ calls: 0 });

const deps = (process_: ProcessAPI, clock: Clock = clockAt([0, 1])) => ({
  process: process_,
  clock,
  dataDir,
  homeDir: '/Users/ada',
  userName: 'ada',
});

describe('childEnv', () => {
  it('is an allow-list of exactly HOME and USER', () => {
    // Measured: `runExec` REPLACES the environment (only `runGit` merges), so a
    // child inherits nothing unless named here — and handed only HOME, a vendor
    // CLI reports itself logged out in ~2s, which reads exactly like a machine
    // nobody ever signed in on. LOGNAME is not a substitute for USER.
    expect(childEnv('/Users/ada', 'ada')).toEqual({ HOME: '/Users/ada', USER: 'ada' });
  });

  it('carries nothing that could correlate this call with a pane', () => {
    // The nested call must not be able to report its lifecycle as some pane's.
    // With an allow-list that is true by construction rather than by a deny-list
    // somebody has to remember to extend.
    const env = childEnv('/Users/ada', 'ada');
    expect(Object.keys(env).sort()).toEqual(['HOME', 'USER']);
  });
});

describe('runComplete', () => {
  it('passes the kind its own argv, in the extension dataDir, with the allow-list env', async () => {
    const seen = seenNow();
    const answer = await runComplete(
      deps(fakeProcess({ ok: true, stdout: 'a-good-name\n', stderr: '' }, seen)),
      target(),
      { prompt: 'name this' },
    );
    expect(answer).toEqual({ ok: true, text: 'a-good-name' });
    expect(seen.cmd).toEqual(['fake-agent', '-p', 'name this', '--model', 'model-q']);
    expect(seen.opts?.cwd).toBe(dataDir);
    expect(seen.opts?.env).toEqual({ HOME: '/Users/ada', USER: 'ada' });
    expect(seen.opts?.timeoutMs).toBe(30_000);
  });

  it('creates its own dataDir, which the host does not create for it', async () => {
    const seen = seenNow();
    await runComplete(deps(fakeProcess({ ok: true, stdout: 'x', stderr: '' }, seen)), target(), { prompt: 'p' });
    // A cwd that does not exist fails inside spawn with an errno rather than a
    // sentence, which is a bad way to learn about `ExtensionContext.dataDir`.
    const { existsSync } = await import('node:fs');
    expect(existsSync(dataDir)).toBe(true);
  });

  it('honours a caller deadline', async () => {
    const seen = seenNow();
    await runComplete(deps(fakeProcess({ ok: true, stdout: 'x', stderr: '' }, seen)), target(), {
      prompt: 'p',
      timeoutMs: 4_000,
    });
    expect(seen.opts?.timeoutMs).toBe(4_000);
  });

  it('passes a system prompt through only when there is one', async () => {
    const seen = seenNow();
    let sawSystem: string | undefined = 'untouched';
    await runComplete(
      deps(fakeProcess({ ok: true, stdout: 'x', stderr: '' }, seen)),
      target({
        argv: (input) => {
          sawSystem = input.system;
          return ['fake-agent'];
        },
      }),
      { prompt: 'p' },
    );
    expect(sawSystem).toBeUndefined();
  });

  it('calls a slow failure a timeout and a quick one a failure', async () => {
    // A killed-on-deadline child and a crashed one arrive as the same ExecErr, so
    // elapsed time is the only thing left that can tell them apart — and they are
    // worth telling apart: one means "the model is slow", the other "the binary
    // is broken".
    const slow = await runComplete(
      { ...deps(fakeProcess({ ok: false, code: -1, stdout: '', stderr: '' }, seenNow())), clock: clockAt([0, 30_000]) },
      target(),
      { prompt: 'p' },
    );
    expect(slow).toMatchObject({ ok: false, reason: 'timeout' });

    const quick = await runComplete(
      { ...deps(fakeProcess({ ok: false, code: 1, stdout: '', stderr: 'boom' }, seenNow())), clock: clockAt([0, 12]) },
      target(),
      { prompt: 'p' },
    );
    expect(quick).toMatchObject({ ok: false, reason: 'failed', message: 'boom' });
  });

  it('names the program when a failure said nothing', async () => {
    const answer = await runComplete(
      { ...deps(fakeProcess({ ok: false, code: 127, stdout: '', stderr: '' }, seenNow())), clock: clockAt([0, 5]) },
      target(),
      { prompt: 'p' },
    );
    expect(answer).toMatchObject({ ok: false, reason: 'failed', message: 'fake-agent exited 127' });
  });

  it('calls an unusable answer empty rather than returning it', async () => {
    const blank = await runComplete(
      deps(fakeProcess({ ok: true, stdout: '   \n', stderr: '' }, seenNow())),
      target(),
      { prompt: 'p' },
    );
    expect(blank).toMatchObject({ ok: false, reason: 'empty' });

    const none = await runComplete(
      deps(fakeProcess({ ok: true, stdout: 'anything', stderr: '' }, seenNow())),
      target({ parse: () => undefined }),
      { prompt: 'p' },
    );
    expect(none).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('caps what parse is shown, so a runaway answer cannot be held whole', async () => {
    let shown = -1;
    await runComplete(
      deps(fakeProcess({ ok: true, stdout: 'x'.repeat(MAX_STDOUT_BYTES * 3), stderr: '' }, seenNow())),
      target({
        parse: (out) => {
          shown = out.length;
          return 'ok';
        },
      }),
      { prompt: 'p' },
    );
    expect(shown).toBe(MAX_STDOUT_BYTES);
  });
});

describe('limiter', () => {
  it('runs no more than the cap at once and still finishes everything', async () => {
    const gate = limiter(2);
    let active = 0;
    let peak = 0;
    const job = async (): Promise<void> => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
    };
    await Promise.all([gate(job), gate(job), gate(job), gate(job), gate(job)]);
    expect(peak).toBeLessThanOrEqual(2);
    expect(active).toBe(0);
  });

  it('releases its slot when a job throws', async () => {
    // A cap that leaked a slot on failure would throttle to nothing after a few
    // broken calls, and the symptom would be a feature that stops working later.
    const gate = limiter(1);
    await expect(gate(() => Promise.reject(new Error('nope')))).rejects.toThrow('nope');
    await expect(gate(() => Promise.resolve('after'))).resolves.toBe('after');
  });
});
