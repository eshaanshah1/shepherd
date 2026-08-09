import { describe, expect, it } from 'vitest';
import { describeOutcomes, planHooks, tail } from './plan.ts';

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
