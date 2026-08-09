import { describe, expect, it } from 'vitest';
import type { ExecErr, ExecOk, ExecOptions, ProcessAPI } from '@shepherd/sdk';
import type { RepoProvisionedFact } from '@shepherd/ext-tasks/manifest';
import { HOOK_TIMEOUT_MS, hookEnv, runHooks } from './runner.ts';

const FACT: RepoProvisionedFact = {
  repo: { path: '/src/alpha', name: 'alpha' },
  worktree: '/tasks/fix-thing/alpha',
  branch: 'fix-thing',
  task: { slug: 'fix-thing', root: '/tasks/fix-thing' },
};

const OK: ExecOk = { ok: true, stdout: '', stderr: '' };

interface ExecCall {
  readonly cmd: readonly string[];
  readonly opts: ExecOptions;
}

/**
 * The one seam this file has, faked. `exec` is what the whole feature is, so a
 * test that spawned a real bash would be testing bash — and `boundaries.js`
 * forbids it in an extension test for exactly that reason.
 */
function fakeProcess(reply: (call: ExecCall) => ExecOk | ExecErr = () => OK): {
  api: ProcessAPI;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const api: ProcessAPI = {
    exec: (cmd, opts) => {
      const call = { cmd, opts };
      calls.push(call);
      return Promise.resolve(reply(call));
    },
    gitRead: () => Promise.resolve(OK),
    gitWrite: () => Promise.resolve(OK),
  };
  return { api, calls };
}

describe('hookEnv', () => {
  it("carries v1's names, so a script written against v1 runs unchanged", () => {
    // The five unprefixed names are a compatibility promise, not a style choice:
    // `scripts/worktree-hook.sh` in this repo is written against them.
    expect(hookEnv(FACT)).toEqual({
      WORKTREE_DIR: '/tasks/fix-thing/alpha',
      WORKTREE_SRC: '/src/alpha',
      WORKTREE_BRANCH: 'fix-thing',
      WORKTREE_NAME: 'alpha',
      REPO_NAME: 'alpha',
      TASK_SLUG: 'fix-thing',
      TASK_ROOT: '/tasks/fix-thing',
    });
  });
});

describe('runHooks', () => {
  it('spawns nothing when no hook is set', async () => {
    const { api, calls } = fakeProcess();
    expect(await runHooks(api, { scripts: {}, fact: FACT })).toEqual({ ok: true });
    expect(calls).toHaveLength(0);
  });

  it('runs bash -lc in the worktree, with the hook env and the hook timeout', async () => {
    const { api, calls } = fakeProcess();
    await runHooks(api, { scripts: { repo: 'cp ~/.env .' }, fact: FACT });

    expect(calls).toHaveLength(1);
    // An argv, never an interpolated string: v2's exec reaches `execFile` and
    // never a shell, so the script is one argument and nothing re-parses it.
    expect(calls[0]?.cmd).toEqual(['/bin/bash', '-lc', 'cp ~/.env .']);
    expect(calls[0]?.opts.cwd).toBe('/tasks/fix-thing/alpha');
    expect(calls[0]?.opts.timeoutMs).toBe(HOOK_TIMEOUT_MS);
    expect(calls[0]?.opts.env).toEqual(hookEnv(FACT));
  });

  it('runs the global hook before the repo hook', async () => {
    const { api, calls } = fakeProcess();
    await runHooks(api, { scripts: { global: 'echo g', repo: 'echo r' }, fact: FACT });
    expect(calls.map((call) => call.cmd[2])).toEqual(['echo g', 'echo r']);
  });

  it('merges stdout and stderr into the failure message', async () => {
    // A hook's diagnosis is usually split across both streams, and reading
    // either alone is reading half of it.
    const { api } = fakeProcess(() => ({ ok: false, code: 3, stdout: 'copying', stderr: 'cp: no such file' }));
    const result = await runHooks(api, { scripts: { repo: 'cp nope .' }, fact: FACT });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('exited 3');
    expect(result.message).toContain('copying');
    expect(result.message).toContain('cp: no such file');
  });

  it('says the timeout out loud when a hook fails with no output at all', async () => {
    // What a killed hook looks like from here: a non-zero exit and two empty
    // streams. Without the wording that is an unexplained failure.
    const { api } = fakeProcess(() => ({ ok: false, code: 143, stdout: '', stderr: '' }));
    const result = await runHooks(api, { scripts: { repo: 'sleep 999' }, fact: FACT });
    expect(result.message).toContain('600s');
  });

  it('skips the repo hook when the global one fails, and says so', async () => {
    const { api, calls } = fakeProcess((call) =>
      call.cmd[2] === 'echo g' ? { ok: false, code: 1, stdout: '', stderr: 'nope' } : OK,
    );
    const result = await runHooks(api, { scripts: { global: 'echo g', repo: 'echo r' }, fact: FACT });

    expect(calls).toHaveLength(1);
    expect(result.message).toContain('the repo hook was skipped because the global hook failed');
  });

  it('still runs the repo hook when the global one succeeded', async () => {
    const { api, calls } = fakeProcess();
    const result = await runHooks(api, { scripts: { global: 'echo g', repo: 'echo r' }, fact: FACT });
    expect(calls).toHaveLength(2);
    expect(result).toEqual({ ok: true });
  });

  it('keeps only the last 20 lines of output', async () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
    const { api } = fakeProcess(() => ({ ok: false, code: 1, stdout: long, stderr: '' }));
    const result = await runHooks(api, { scripts: { repo: 'noisy' }, fact: FACT });

    expect(result.message).toContain('earlier line(s)');
    expect(result.message).toContain('line 40');
    expect(result.message).not.toContain('line 1\n');
  });

  it('reports a throw from exec as a failure rather than throwing', async () => {
    // A hook that cannot even be launched is still the hook's problem, and it
    // must not become the task's — this runs inside somebody's provisioning.
    const api: ProcessAPI = {
      exec: () => Promise.reject(new Error('spawn EACCES')),
      gitRead: () => Promise.resolve(OK),
      gitWrite: () => Promise.resolve(OK),
    };
    const result = await runHooks(api, { scripts: { repo: 'anything' }, fact: FACT });
    expect(result).toEqual({ ok: false, message: expect.stringContaining('spawn EACCES') });
  });
});
