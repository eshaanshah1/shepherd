import { describe, expect, it } from 'vitest';
import { fuzzyFilter, fuzzyMatch, fuzzyScore } from './fuzzy.ts';

const titles = (items: readonly string[]): readonly string[] => items;
const filter = (query: string, items: readonly string[]): readonly string[] =>
  fuzzyFilter(query, titles(items), (item) => item);

describe('fuzzyScore', () => {
  it('matches a subsequence, not only a prefix', () => {
    // The property that makes a palette faster than a menu: you type the shape
    // of the thing, not the start of its name.
    expect(fuzzyScore('lz', 'layout.zoom')).not.toBeNull();
    expect(fuzzyScore('tc', 'Tasks: Create')).not.toBeNull();
    expect(fuzzyScore('zoom', 'layout.zoom')).not.toBeNull();
  });

  it('returns null for a miss, which is not the same as a score of zero', () => {
    // Conflating the two is how an empty query filters everything out.
    expect(fuzzyScore('xyz', 'layout.zoom')).toBeNull();
    expect(fuzzyScore('', 'layout.zoom')).toBe(0);
  });

  it('requires the characters IN ORDER', () => {
    expect(fuzzyScore('zl', 'layout.zoom')).toBeNull();
  });

  it('ignores case in both directions', () => {
    expect(fuzzyScore('TASKS', 'tasks.create')).not.toBeNull();
    expect(fuzzyScore('tasks', 'TASKS: CREATE')).not.toBeNull();
  });

  it('scores a word start above a buried letter', () => {
    const wordStart = fuzzyScore('tc', 'Tasks: Create');
    const buried = fuzzyScore('tc', 'Tasks: Archive');
    expect(wordStart).not.toBeNull();
    expect(buried).not.toBeNull();
    expect(wordStart ?? 0).toBeGreaterThan(buried ?? 0);
  });

  it('scores an unbroken run above the same letters scattered', () => {
    // `l-a-y-o-u-t` is deliberately NOT the counter-example, and the first draft
    // of this test used it and failed: every letter there follows a hyphen, so
    // every one collects the word-start bonus and the scattered candidate wins.
    // That is the ranking working — a hyphenated id really is four word starts —
    // and it is worth knowing before reaching for a "scattered" string.
    const run = fuzzyScore('layo', 'layout.zoom');
    const scattered = fuzzyScore('layo', 'lazy shadow');
    expect(run ?? 0).toBeGreaterThan(scattered ?? 0);
  });
});

describe('fuzzyFilter', () => {
  it('returns everything, in the order given, for an empty query', () => {
    // A palette that has just opened is a list, not a search result.
    const all = ['layout.zoom', 'layout.rename', 'tasks.create'];
    expect(filter('', all)).toEqual(all);
    expect(filter('   ', all)).toEqual(all);
  });

  it('drops what does not match and ranks what does', () => {
    const found = filter('tc', ['layout.zoom', 'Tasks: Archive', 'Tasks: Create']);
    expect(found).toEqual(['Tasks: Create', 'Tasks: Archive']);
  });

  /**
   * MUTATION TARGET #2 (the ranking half). Removing any one of the three bonuses
   * collapses this to the input order and fails here — a ranking that is not
   * tested is a ranking nobody can tell from `filter()`.
   */
  it('puts the best match first, not merely the first match', () => {
    const commands = ['tasks.restore', 'tasks.create', 'layout.close'];
    expect(filter('tc', commands)[0]).toBe('tasks.create');
  });

  it('breaks a tie on the ORIGINAL order, never on the title', () => {
    // The registry's order is insertion order — the kernel's commands, then each
    // extension's — which is a grouping a user can learn. Alphabetising would
    // scatter `layout.*` through `tasks.*` for no gain.
    const commands = ['zeta.go', 'alpha.go'];
    expect(filter('go', commands)).toEqual(['zeta.go', 'alpha.go']);
  });

  it('is stable when nothing matches', () => {
    expect(filter('qqqq', ['layout.zoom', 'tasks.create'])).toEqual([]);
  });
});

describe('fuzzyMatch positions', () => {
  it('names the index of every matched character, in the candidate as given', () => {
    // Indices into the ORIGINAL casing, not the lowercased copy the matcher
    // works on — a highlighter slices the string the user is reading.
    const hit = fuzzyMatch('tc', 'Tasks: Create');
    expect(hit?.positions).toEqual([0, 7]);
  });

  it('emits one position per query character, ascending', () => {
    const hit = fuzzyMatch('layo', 'layout.zoom');
    expect(hit?.positions).toEqual([0, 1, 2, 3]);
  });

  it('has no positions for an empty query, and is still a match', () => {
    // The empty query matches everything at score 0 (that is what makes a list
    // a list rather than a search result), so it must not highlight anything.
    expect(fuzzyMatch('', 'layout.zoom')).toEqual({ score: 0, positions: [] });
  });

  it('is null for a miss, exactly as the score is', () => {
    expect(fuzzyMatch('zl', 'layout.zoom')).toBeNull();
  });

  it('agrees with fuzzyScore, because one is the other', () => {
    // The property that stops the ranker and the highlighter drifting: there is
    // one matcher, and `fuzzyScore` is a projection of it.
    expect(fuzzyMatch('tc', 'Tasks: Create')?.score).toBe(fuzzyScore('tc', 'Tasks: Create'));
  });
});
