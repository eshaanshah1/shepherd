import { describe, expect, it } from 'vitest';
import { rootId } from '@shepherd/sdk';
import { rootClosedFallout } from './root-closed.ts';

const HOME = rootId('window-1');

describe('rootClosedFallout', () => {
  it('does NOT report the group empty while another tab of it lives', () => {
    // The whole reason `groupEmpty` exists: `tasks` archives on this
    // announcement, and archiving here would shelve a task with a live agent
    // running two tabs over.
    const fallout = rootClosedFallout({
      root: rootId('task:t1'),
      group: 'task:t1',
      groupRoots: [rootId('task:t1'), rootId('task:t1/tab-2')],
      homeRoot: HOME,
    });
    expect(fallout.announcement.groupEmpty).toBe(false);
  });

  it('reports the group empty when the last tab goes', () => {
    const fallout = rootClosedFallout({
      root: rootId('task:t1/tab-2'),
      group: 'task:t1',
      groupRoots: [rootId('task:t1/tab-2')],
      homeRoot: HOME,
    });
    expect(fallout.announcement).toEqual({
      root: 'task:t1/tab-2',
      group: 'task:t1',
      groupEmpty: true,
    });
  });

  it('lands on a sibling tab rather than throwing you out of the group', () => {
    const fallout = rootClosedFallout({
      root: rootId('task:t1'),
      group: 'task:t1',
      groupRoots: [rootId('task:t1'), rootId('task:t1/tab-2')],
      homeRoot: HOME,
    });
    expect(fallout.nextRoot).toBe(rootId('task:t1/tab-2'));
  });

  it('lands on home when the group is finished', () => {
    const fallout = rootClosedFallout({
      root: rootId('task:t1'),
      group: 'task:t1',
      groupRoots: [rootId('task:t1')],
      homeRoot: HOME,
    });
    expect(fallout.nextRoot).toBe(HOME);
  });

  it('treats an ungrouped root as its own group of one', () => {
    // Every root defaults to a group of itself, so this is the ordinary case for
    // anything nobody grouped — and it must behave exactly as it did before
    // groups existed.
    const fallout = rootClosedFallout({
      root: rootId('scratch'),
      group: 'scratch',
      groupRoots: [rootId('scratch')],
      homeRoot: HOME,
    });
    expect(fallout).toEqual({
      nextRoot: HOME,
      announcement: { root: 'scratch', group: 'scratch', groupEmpty: true },
    });
  });
});
