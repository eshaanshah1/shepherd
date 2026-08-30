import { describe, expect, it } from 'vitest';
import type { ViewContributionDTO } from '../../shared/index.ts';
import { claimedSlot, faceForKey, faceTabs, nearestFace } from './faces.ts';

const face = (type: string, slot: 'diff' | 'intent' | 'files', title?: string): ViewContributionDTO => ({
  extension: type.split('.')[0] ?? 'x',
  type,
  kind: 'component',
  component: type,
  surface: 'face',
  face: { slot, subject: 'task' },
  ...(title === undefined ? {} : { title }),
});

const DIFF = face('github.taskDiff', 'diff', 'Diff');
const INTENT = face('tasks.intent', 'intent', 'Intent');
const FILES = face('editor.taskFiles', 'files', 'Files');

describe('claimedSlot', () => {
  it('reads a slot only off a component that says it is a face', () => {
    expect(claimedSlot(DIFF)).toBe('diff');
    expect(claimedSlot({ ...DIFF, surface: 'pane' })).toBeUndefined();
    expect(claimedSlot({ extension: 'x', type: 'x.tree', kind: 'tree' })).toBeUndefined();
  });

  it('ignores a slot this build does not know', () => {
    // A newer extension naming a fifth slot gets no tab rather than a broken
    // one — the same rule an unknown glyph name gets.
    const odd = { ...DIFF, face: { slot: 'timeline', subject: 'task' } } as unknown as ViewContributionDTO;
    expect(claimedSlot(odd)).toBeUndefined();
  });
});

describe('faceTabs', () => {
  it('always offers Agents, because that one is the stage', () => {
    expect(faceTabs([]).map((tab) => tab.face)).toEqual(['agents']);
  });

  it('draws the spec’s order whatever order the claims arrived in', () => {
    const tabs = faceTabs([FILES, INTENT, DIFF]);
    expect(tabs.map((tab) => tab.face)).toEqual(['agents', 'diff', 'intent', 'files']);
    expect(tabs.map((tab) => tab.key)).toEqual(['1', '2', '3', '4']);
  });

  it('has no Diff tab in a build with no diff — the honest failure', () => {
    /*
     * The whole argument for a claimed slot. The alternative is the shell
     * resolving `diff` to a view type whose name it knows, which is the shell
     * having learned which extension it hired.
     */
    const tabs = faceTabs([INTENT, FILES]);
    expect(tabs.map((tab) => tab.face)).toEqual(['agents', 'intent', 'files']);
    // …and the numbers close up, so `2` still means the second tab.
    expect(tabs.map((tab) => tab.key)).toEqual(['1', '2', '3']);
  });

  it('keeps the FIRST claim on a contested slot', () => {
    // Two extensions both saying they are the diff cannot be settled on merit,
    // and taking the last would make the answer depend on activation order.
    const other = face('other.diff', 'diff', 'Theirs');
    expect(faceTabs([DIFF, other]).find((tab) => tab.face === 'diff')?.view?.type).toBe('github.taskDiff');
  });

  it('takes the label from the contribution, falling back to the slot’s word', () => {
    expect(faceTabs([face('x.d', 'diff')]).at(-1)?.label).toBe('Diff');
    expect(faceTabs([face('x.d', 'diff', 'Changes')]).at(-1)?.label).toBe('Changes');
  });
});

describe('the keys', () => {
  it('binds a POSITION, not a face', () => {
    // With no Diff tab, `2` is Intent — a key bound to a face that is not drawn
    // would be a keystroke that appears to do nothing.
    const tabs = faceTabs([INTENT, FILES]);
    expect(faceForKey(tabs, '2')).toBe('intent');
    expect(faceForKey(faceTabs([DIFF, INTENT, FILES]), '2')).toBe('diff');
    expect(faceForKey(tabs, '4')).toBeUndefined();
  });

  it('falls back to Agents for a face nothing claims', () => {
    // What `openingFace` asks after it says "a done task opens on Diff": with
    // no diff surface, it opens on the agents rather than on a blank tab.
    expect(nearestFace(faceTabs([INTENT]), 'diff')).toBe('agents');
    expect(nearestFace(faceTabs([DIFF]), 'diff')).toBe('diff');
  });
});
