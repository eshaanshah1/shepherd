import { describe, expect, it } from 'vitest';
import { branchTaken, mintName, pickBranch } from './mint.ts';
import type { RepoRefs } from './branch.ts';
import { slugify } from './slug.ts';

/** A `random` that walks a fixed sequence, so a name is a value a test can name. */
function sequence(values: readonly number[]): () => number {
  let index = 0;
  return () => values[index++ % values.length] ?? 0;
}

describe('mintName', () => {
  it('is a colour and a breed, joined by one hyphen', () => {
    expect(mintName(sequence([0, 0]))).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it('is reproducible from its randomness, so a test can assert on one', () => {
    expect(mintName(sequence([0, 0]))).toBe(mintName(sequence([0, 0])));
  });

  it('walks both lists, so the pair is not one name repeated', () => {
    expect(mintName(sequence([0, 0]))).not.toBe(mintName(sequence([0.5, 0.5])));
  });

  // It becomes a directory and a branch, so `slugify` must have nothing to fix.
  it('survives slugify unchanged', () => {
    for (let n = 0; n < 200; n += 1) {
      const name = mintName(Math.random);
      expect(slugify(name)).toBe(name);
    }
  });

  // A `random` answering exactly 1 indexes one past the end of the list.
  it('answers a name when random returns its upper bound', () => {
    expect(mintName(() => 1)).toMatch(/^[a-z]+-[a-z]+$/);
  });
});

const refs = (over: Partial<RepoRefs> = {}): RepoRefs => ({
  localBranches: [],
  remoteBranches: [],
  checkedOutBranches: [],
  defaultBase: undefined,
  ...over,
});

describe('branchTaken', () => {
  it('sees a local branch', () => {
    expect(branchTaken('slate-merino', [refs({ localBranches: ['slate-merino'] })])).toBe(true);
  });

  // Matched by suffix and exactly, the way `resolveBranch` matches it — so any
  // remote counts and `merino` does not match `origin/slate-merino`.
  it('sees a branch that exists only on a remote, under any remote name', () => {
    expect(branchTaken('slate-merino', [refs({ remoteBranches: ['upstream/slate-merino'] })])).toBe(true);
    expect(branchTaken('merino', [refs({ remoteBranches: ['origin/slate-merino'] })])).toBe(false);
  });

  it('sees a branch another worktree already holds', () => {
    expect(branchTaken('slate-merino', [refs({ checkedOutBranches: ['slate-merino'] })])).toBe(true);
  });

  it('is taken if ANY repo of the task has it', () => {
    expect(branchTaken('slate-merino', [refs(), refs({ localBranches: ['slate-merino'] })])).toBe(true);
  });

  it('is free when nothing has it', () => {
    expect(branchTaken('slate-merino', [refs(), refs()])).toBe(false);
  });
});

describe('pickBranch', () => {
  it('keeps the minted name when it is free everywhere', () => {
    expect(pickBranch('slate-merino', [refs()], () => 'never-called')).toBe('slate-merino');
  });

  it('re-mints when the name is taken in one of the repos', () => {
    const free = pickBranch('slate-merino', [refs(), refs({ localBranches: ['slate-merino'] })], () => 'amber-soay');
    expect(free).toBe('amber-soay');
  });

  it('keeps re-minting until one is free', () => {
    const names = ['ash-jacob', 'amber-soay'];
    let n = 0;
    const taken = refs({ localBranches: ['slate-merino', 'ash-jacob'] });
    expect(pickBranch('slate-merino', [taken], () => names[n++] ?? 'ash-jacob')).toBe('amber-soay');
  });

  // A bound rather than a loop: the failure this guards is not "unlucky", it is
  // "this repo has 1,300 branches", and a loop there does not terminate.
  it('falls back to a numbered suffix when every attempt collides', () => {
    const taken = refs({ localBranches: ['slate-merino', 'ash-jacob', 'ash-jacob-2'] });
    expect(pickBranch('slate-merino', [taken], () => 'ash-jacob', 2)).toBe('ash-jacob-3');
  });
});
