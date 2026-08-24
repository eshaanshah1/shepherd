import { describe, expect, it } from 'vitest';
import { SHELL_ROW_CAP, capRows, type ShellRow } from './rows.ts';

const shell = (root: string, label: string, state?: ShellRow['state']): ShellRow => ({
  root,
  label,
  ...(state === undefined ? {} : { state }),
});

/** What a row reads as, for the assertions about ORDER below. */
const names = (rows: readonly ReturnType<typeof capRows>[number][]): string[] =>
  rows.map((row) => ('kind' in row ? row.kind : row.label));

describe('the cap on shell rows', () => {
  it('leaves a list at or under the cap alone, in creation order', () => {
    const given = [shell('window-1', 'zsh'), shell('window-1/tab-1', 'dev')];
    expect(capRows(given, false)).toEqual(given);
  });

  it('draws one shell identically to a list of one', () => {
    // The shape of the region does not change as shells are added.
    expect(capRows([shell('window-1', 'zsh')], false)).toEqual([shell('window-1', 'zsh')]);
  });

  it('says how many it is not showing rather than showing a list to scroll', () => {
    const capped = capRows(
      [
        shell('window-1', 'a'),
        shell('window-1/tab-1', 'b'),
        shell('window-1/tab-2', 'c'),
        shell('window-1/tab-3', 'd'),
      ],
      false,
    );
    expect(capped).toHaveLength(SHELL_ROW_CAP);
    expect(capped.at(-1)).toEqual({ kind: 'more', count: 2 });
  });

  it('keeps the shells that WANT YOU, not the first two', () => {
    // A cap that kept shell 1 and shell 2 would hide exactly what the rail
    // exists to surface.
    const capped = capRows(
      [
        shell('window-1', 'a'),
        shell('window-1/tab-1', 'b'),
        shell('window-1/tab-2', 'c', 'blocked'),
        shell('window-1/tab-3', 'd', 'working'),
      ],
      false,
    );
    expect(names(capped)).toEqual(['c', 'd', 'more']);
  });

  it('breaks a tie on creation order, so a quiet list reads top to bottom', () => {
    const capped = capRows([shell('r1', 'a'), shell('r2', 'b'), shell('r3', 'c'), shell('r4', 'd')], false);
    expect(names(capped)).toEqual(['a', 'b', 'more']);
  });

  it('shows all of them in CREATION order when expanded, plus the way back', () => {
    // Expanded deliberately does not promote: a full list has no room problem to
    // solve, and one that reshuffled as agents finished would move the row you
    // were reaching for out from under the cursor.
    const given = [shell('r1', 'a'), shell('r2', 'b'), shell('r3', 'c', 'blocked'), shell('r4', 'd')];
    expect(capRows(given, true)).toEqual([...given, { kind: 'less' }]);
  });

  it('does not add a way back to a list that never overflowed', () => {
    const given = [shell('r1', 'a')];
    expect(capRows(given, true)).toEqual(given);
  });

  it('ranks a state it does not recognise as the quiet case', () => {
    const capped = capRows(
      [
        shell('r1', 'a'),
        shell('r2', 'b'),
        // A word from an extension this code has never seen.
        shell('r3', 'c', 'sleeping' as ShellRow['state']),
        shell('r4', 'd', 'blocked'),
      ],
      false,
    );
    expect(names(capped)).toEqual(['d', 'a', 'more']);
  });

  it('is total on an empty list', () => {
    expect(capRows([], false)).toEqual([]);
  });
});
