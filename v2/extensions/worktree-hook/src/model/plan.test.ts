import { describe, expect, it } from 'vitest';
import { describeOutcomes, matchSets, planHooks, tail } from './plan.ts';

describe('planHooks', () => {
  it('runs nothing when neither is set', () => {
    expect(planHooks({})).toEqual([]);
  });

  it('runs the global hook FIRST, then the repo hook', () => {
    // The order is the only interesting decision here: the global hook is
    // machine setup a repo's own hook may depend on.
    expect(planHooks({ global: 'echo g', repo: 'echo r' })).toEqual([
      { kind: 'global', script: 'echo g' },
      { kind: 'repo', script: 'echo r' },
    ]);
  });

  it('runs just one when just one is set', () => {
    expect(planHooks({ global: 'echo g' })).toEqual([{ kind: 'global', script: 'echo g' }]);
    expect(planHooks({ repo: 'echo r' })).toEqual([{ kind: 'repo', script: 'echo r' }]);
  });

  it('treats a whitespace-only script as no script at all', () => {
    expect(planHooks({ global: '   \n ', repo: 'echo r' })).toEqual([{ kind: 'repo', script: 'echo r' }]);
  });
});

describe('describeOutcomes', () => {
  it('is ok when nothing ran', () => {
    expect(describeOutcomes([])).toEqual({ ok: true });
  });

  it('is ok when everything succeeded', () => {
    expect(
      describeOutcomes([
        { kind: 'global', ok: true, detail: '' },
        { kind: 'repo', ok: true, detail: '' },
      ]),
    ).toEqual({ ok: true });
  });

  it('names which hook failed and carries its output', () => {
    // "the hook failed" with no output is the message that sends you looking
    // through logs for the half that mattered.
    expect(describeOutcomes([{ kind: 'repo', ok: false, detail: 'exited 3\ncp: no such file' }])).toEqual({
      ok: false,
      message: 'the repo hook failed — exited 3\ncp: no such file',
    });
  });

  it('says the repo hook was skipped when the global one failed', () => {
    expect(describeOutcomes([{ kind: 'global', ok: false, detail: 'exited 1' }], { skippedRepoHook: true })).toEqual({
      ok: false,
      message: 'the global hook failed — exited 1\nthe repo hook was skipped because the global hook failed',
    });
  });

  it('does not mention skipping when nothing was skipped', () => {
    expect(describeOutcomes([{ kind: 'global', ok: false, detail: 'exited 1' }])).toEqual({
      ok: false,
      message: 'the global hook failed — exited 1',
    });
  });

  it('names WHICH set failed, because "the set hook failed" twice says nothing', () => {
    expect(describeOutcomes([{ kind: 'set', ok: false, detail: 'exited 1', scope: 'alpha + beta' }])).toEqual({
      ok: false,
      message: 'the set hook alpha + beta failed — exited 1',
    });
  });
});

describe('matchSets', () => {
  const set = (paths: readonly string[], script = `echo ${paths.join('+')}`) => ({ paths, script });

  it('matches nothing when there are no sets', () => {
    expect(matchSets([], ['/src/alpha'])).toEqual([]);
  });

  it('fires a set whose every repo is on the task', () => {
    expect(matchSets([set(['/src/alpha', '/src/beta'])], ['/src/alpha', '/src/beta'])).toEqual([
      { kind: 'set', script: 'echo /src/alpha+/src/beta', paths: ['/src/alpha', '/src/beta'] },
    ]);
  });

  it('is SUBSET, not exact — a third repo does not silence a pair', () => {
    // The whole reason subset was chosen: wiring between two checkouts is still
    // exactly as necessary when a third repo joins the task.
    const runs = matchSets([set(['/src/alpha', '/src/beta'])], ['/src/alpha', '/src/beta', '/src/gamma']);
    expect(runs).toHaveLength(1);
  });

  it('does not fire a set with a repo the task does not have', () => {
    expect(matchSets([set(['/src/alpha', '/src/beta'])], ['/src/alpha'])).toEqual([]);
  });

  it('fires every matching set — a task of three repos fires all four subsets', () => {
    const runs = matchSets(
      [
        set(['/src/alpha', '/src/beta']),
        set(['/src/alpha', '/src/gamma']),
        set(['/src/beta', '/src/gamma']),
        set(['/src/alpha', '/src/beta', '/src/gamma']),
      ],
      ['/src/alpha', '/src/beta', '/src/gamma'],
    );
    expect(runs).toHaveLength(4);
  });

  it('orders by set SIZE first, so the basic wiring runs before what builds on it', () => {
    const runs = matchSets(
      [set(['/src/alpha', '/src/beta', '/src/gamma'], 'three'), set(['/src/alpha', '/src/beta'], 'two')],
      ['/src/alpha', '/src/beta', '/src/gamma'],
    );
    expect(runs.map((run) => run.script)).toEqual(['two', 'three']);
  });

  it('breaks a size tie by key, so the order is reproducible', () => {
    const runs = matchSets(
      [set(['/src/beta', '/src/gamma'], 'bg'), set(['/src/alpha', '/src/beta'], 'ab')],
      ['/src/alpha', '/src/beta', '/src/gamma'],
    );
    expect(runs.map((run) => run.script)).toEqual(['ab', 'bg']);
  });

  it('fires a one-repo set — it is not a spelling of the repo hook', () => {
    // Different cwd (the task root), different moment (after every repo), and
    // it runs once rather than per worktree.
    expect(matchSets([set(['/src/alpha'])], ['/src/alpha', '/src/beta'])).toHaveLength(1);
  });

  it('ignores a set with no repos, which would otherwise match everything', () => {
    // The store refuses to write one; this is the second line of defence, and
    // the one that holds for a key written by another build.
    expect(matchSets([set([], 'echo everywhere')], ['/src/alpha'])).toEqual([]);
  });

  it('ignores a whitespace-only script', () => {
    expect(matchSets([set(['/src/alpha'], '  \n ')], ['/src/alpha'])).toEqual([]);
  });

  it('matches nothing when the task has no ready repos at all', () => {
    // Every repo failed to provision. Every set hook is correctly silent.
    expect(matchSets([set(['/src/alpha'])], [])).toEqual([]);
  });
});

describe('tail', () => {
  it('keeps the last N lines and SAYS how many it dropped', () => {
    // The count is the addition to v1's plain tail: output that begins
    // mid-sentence reads as the whole failure, and you go looking for the rest.
    const text = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join('\n');
    const kept = tail(text, 20);
    expect(kept.split('\n')[0]).toBe('… 5 earlier line(s)');
    expect(kept.endsWith('line 25')).toBe(true);
    expect(kept.split('\n')).toHaveLength(21);
  });

  it('returns short output unchanged', () => {
    expect(tail('one\ntwo', 20)).toBe('one\ntwo');
  });

  it('returns output of exactly N lines unchanged', () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    expect(tail(text, 20)).toBe(text);
  });
});
