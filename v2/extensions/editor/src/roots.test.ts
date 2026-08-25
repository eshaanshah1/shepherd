import { describe, expect, it } from 'vitest';
import { activeCwd, activeGroup, openEditorRoot, readRoots } from './roots.ts';

/** One row of `layout.listRoots`, as much of it as this module reads. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    root: 'task:t1',
    group: 'task:t1',
    active: false,
    focusedPane: 'p1',
    panes: [{ pane: 'p1', cwd: '/repo' }],
    tree: null,
    ...over,
  };
}

describe('readRoots', () => {
  it('reads the fields this extension needs', () => {
    expect(readRoots([row({ active: true })])).toEqual([
      {
        root: 'task:t1',
        group: 'task:t1',
        active: true,
        focusedPane: 'p1',
        panes: [{ pane: 'p1', cwd: '/repo' }],
        editorRoots: [],
      },
    ]);
  });

  it('drops a row with no root, rather than inventing one', () => {
    // `ok` says a call succeeded, never that a value has a shape — and an
    // invented root would open the tree on somebody else's directory.
    expect(readRoots([{ group: 'x' }, row()])).toHaveLength(1);
  });

  it('is empty for a non-array answer', () => {
    expect(readRoots(undefined)).toEqual([]);
    expect(readRoots({ roots: [] })).toEqual([]);
  });

  it('finds the editor panes in a persisted tree, at any depth', () => {
    const tree = {
      kind: 'split',
      first: { kind: 'leaf', pane: { view: { type: 'editor.workspace', state: { root: '/a' } } } },
      second: {
        kind: 'split',
        first: { kind: 'leaf', pane: {} },
        second: {
          kind: 'leaf',
          pane: { view: { type: 'editor.workspace', state: { root: '/b' } } },
        },
      },
    };
    expect(readRoots([row({ tree })])[0]?.editorRoots).toEqual(['/a', '/b']);
  });

  it('ignores another extension s view pane', () => {
    const tree = { kind: 'leaf', pane: { view: { type: 'github.review', state: { task: 't' } } } };
    expect(readRoots([row({ tree })])[0]?.editorRoots).toEqual([]);
  });

  it('ignores an editor pane whose state names no root', () => {
    const tree = { kind: 'leaf', pane: { view: { type: 'editor.workspace', state: {} } } };
    expect(readRoots([row({ tree })])[0]?.editorRoots).toEqual([]);
  });
});

describe('activeCwd', () => {
  it('is the focused pane s cwd of the active root', () => {
    const roots = readRoots([
      row({ root: 'other', panes: [{ pane: 'p9', cwd: '/elsewhere' }], focusedPane: 'p9' }),
      row({ active: true }),
    ]);
    expect(activeCwd(roots)).toBe('/repo');
  });

  it('is undefined when the active root s focused pane has no cwd', () => {
    // A view pane has no cwd, and a tab holding only one is a real state.
    const roots = readRoots([row({ active: true, panes: [{ pane: 'p1' }] })]);
    expect(activeCwd(roots)).toBeUndefined();
  });

  it('is undefined when nothing is active', () => {
    expect(activeCwd(readRoots([row()]))).toBeUndefined();
  });
});

describe('openEditorRoot', () => {
  const tree = {
    kind: 'leaf',
    pane: { view: { type: 'editor.workspace', state: { root: '/repo' } } },
  };

  it('finds the tab already showing this root', () => {
    // Asked of the LAYOUT rather than remembered: a record of our own would be
    // wrong the moment the user closed the tab, and wrong across a relaunch.
    expect(openEditorRoot(readRoots([row({ tree })]), '/repo')).toBe('task:t1');
  });

  it('is undefined for a root no tab is on', () => {
    expect(openEditorRoot(readRoots([row({ tree })]), '/other')).toBeUndefined();
  });
});

describe('activeGroup', () => {
  it('is the pane group the user is in', () => {
    // `task:<id>` is what identifies which task a tab belongs to, and so which
    // task root the editor should open on.
    expect(activeGroup(readRoots([row({ active: true })]))).toBe('task:t1');
  });

  it('is undefined when nothing is active', () => {
    expect(activeGroup(readRoots([row()]))).toBeUndefined();
  });
});
