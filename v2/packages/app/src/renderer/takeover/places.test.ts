import { describe, expect, it } from 'vitest';
import { filterPlaces, places } from './places.ts';
import type { TriageEntry } from './triage.ts';

const entry = (over: Partial<TriageEntry> & { id: string }): TriageEntry => ({
  label: over.id,
  rowId: over.id,
  mark: 'ready',
  place: false,
  facts: {},
  viewType: 'tasks.tree',
  ...over,
});

describe('places', () => {
  it('opens on the three standing places, before any work', () => {
    /*
     * A switcher that listed only your tasks could not take you to the screen
     * that lists your tasks — and the two commonest jumps in a session are
     * "back to the flock" and "start something".
     */
    const items = places([entry({ id: 'relay', mark: 'working' })]);
    expect(items.slice(0, 3).map((item) => item.name)).toEqual(['Overview', 'New task', 'Shells']);
    expect(items.slice(0, 3).map((item) => item.where)).toEqual(['H', 'N', '0']);
  });

  it('says the region a task is in, in the words Home uses', () => {
    // The switcher and Home must not have two opinions about your morning.
    const items = places([
      entry({ id: 'ask', label: 'Relay', mark: 'waiting' }),
      entry({ id: 'run', label: 'Sync', mark: 'working' }),
    ]);
    expect(items.map((item) => item.where).slice(3)).toEqual(['needs you', 'running']);
  });

  it('lists Shells once as a place, never as N terminal rows', () => {
    // ADR 0047 made the loose terminals ONE destination with several panes in
    // it. Three rows called `zsh` would be three ways to reach the same screen.
    const items = places([
      entry({ id: 'a', place: true }),
      entry({ id: 'b', place: true }),
      entry({ id: 'task', mark: 'working' }),
    ]);
    expect(items.filter((item) => item.kind === 'task')).toHaveLength(1);
    expect(items.filter((item) => item.name === 'Shells')).toHaveLength(1);
  });

  it('carries the mark the row had, so a hit looks like its row', () => {
    const items = places([entry({ id: 'ask', mark: 'waiting' })]);
    expect(items.at(-1)?.mark).toBe('waiting');
    // A standing place has no state to report, and draws the empty slot.
    expect(items[0]?.mark).toBeUndefined();
  });
});

describe('filterPlaces', () => {
  const items = places([
    entry({ id: 'relay', label: 'Relay retry storm', mark: 'working' }),
    entry({ id: 'save', label: 'Save-conflict dialog', mark: 'waiting' }),
  ]);

  it('keeps the standing order for an empty query, so enter means Home', () => {
    expect(filterPlaces(items, '   ').map((item) => item.name)).toEqual(items.map((item) => item.name));
  });

  it('ranks the way the palette ranks, rather than filtering by substring', () => {
    // `rrs` matches "Relay Retry Storm" by initials and nothing by substring.
    expect(filterPlaces(items, 'rrs').map((item) => item.name)).toEqual(['Relay retry storm']);
  });

  it('answers nothing rather than everything for a query that matches none', () => {
    expect(filterPlaces(items, 'zzzz')).toEqual([]);
  });
});
