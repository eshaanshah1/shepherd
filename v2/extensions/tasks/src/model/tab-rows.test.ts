import { describe, expect, it } from 'vitest';
import { capTabRows, type TabRow } from './tab-rows.ts';

const tab = (n: number, state: TabRow['state'] = 'idle'): TabRow => ({
  root: `task:t1/tab-${n}`,
  label: `tab ${n}`,
  state,
});

describe('capTabRows', () => {
  it('shows a single tab, because the entry must not change shape as tabs appear', () => {
    expect(capTabRows([tab(1)], false)).toEqual([tab(1)]);
  });

  it('has no rows at all for a task that never spawned', () => {
    expect(capTabRows([], false)).toEqual([]);
  });

  it('shows three tabs in full', () => {
    expect(capTabRows([tab(1), tab(2), tab(3)], false)).toEqual([tab(1), tab(2), tab(3)]);
  });

  it('shows two and an overflow row past three', () => {
    expect(capTabRows([tab(1), tab(2), tab(3), tab(4), tab(5)], false)).toEqual([
      tab(1),
      tab(2),
      { kind: 'more', count: 3 },
    ]);
  });

  it('shows the tabs that WANT YOU when it cannot show them all', () => {
    // The point of the cap. A finished agent, or a command that completed while
    // you were looking elsewhere, is the row worth having — and keeping tabs 1
    // and 2 would hide exactly what the sidebar exists to surface.
    expect(capTabRows([tab(1), tab(2), tab(3), tab(4, 'needsCheck'), tab(5)], false)).toEqual([
      tab(4, 'needsCheck'),
      tab(1),
      { kind: 'more', count: 3 },
    ]);
  });

  it('ranks a blocked tab over a merely finished one', () => {
    // `ROLLUP_PRIORITY`'s order, unchanged: anything WAITING on you outranks
    // anything that has merely stopped.
    expect(capTabRows([tab(1, 'needsCheck'), tab(2), tab(3), tab(4, 'blocked')], false)).toEqual([
      tab(4, 'blocked'),
      tab(1, 'needsCheck'),
      { kind: 'more', count: 2 },
    ]);
  });

  it('keeps creation order among tabs that are equally loud', () => {
    expect(capTabRows([tab(1), tab(2), tab(3), tab(4)], false)).toEqual([
      tab(1),
      tab(2),
      { kind: 'more', count: 2 },
    ]);
  });

  it('treats a state it does not recognise as the quiet case', () => {
    // These words crossed a port from an extension this code has never seen.
    const odd = { root: 'task:t1/tab-9', label: 'odd', state: 'flurgle' } as unknown as TabRow;
    expect(capTabRows([odd, tab(2, 'needsCheck'), tab(3), tab(4)], false)).toEqual([
      tab(2, 'needsCheck'),
      odd,
      { kind: 'more', count: 2 },
    ]);
  });

  it('lists every tab in creation order once expanded, however loud', () => {
    // Promotion is what the CAP needs. A full list has no room problem, and one
    // that reshuffled as agents finished would move the row you were reaching for.
    expect(capTabRows([tab(1), tab(2), tab(3), tab(4, 'needsCheck')], true)).toEqual([
      tab(1),
      tab(2),
      tab(3),
      tab(4, 'needsCheck'),
      { kind: 'less' },
    ]);
  });

  it('offers no way back when expanding changed nothing', () => {
    expect(capTabRows([tab(1), tab(2)], true)).toEqual([tab(1), tab(2)]);
  });
});
