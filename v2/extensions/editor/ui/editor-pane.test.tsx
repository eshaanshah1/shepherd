import { describe, expect, it } from 'vitest';
import { readEditorState, readTree } from './editor-pane.tsx';

describe('readEditorState', () => {
  it('reads a root', () => {
    expect(readEditorState({ root: '/repo' })).toEqual({ root: '/repo', doc: undefined });
  });

  it('reads the document that was open', () => {
    expect(readEditorState({ root: '/repo', doc: 'src/a.ts' })).toEqual({
      root: '/repo',
      doc: 'src/a.ts',
    });
  });

  it('is undefined for a state with no root', () => {
    // `state` crossed a port and reaches the component as `unknown` (ADR 0044).
    // A pane with no root has nothing to list, and inventing one would open the
    // tree on a directory nobody named.
    expect(readEditorState({})).toBeUndefined();
    expect(readEditorState(null)).toBeUndefined();
    expect(readEditorState('/repo')).toBeUndefined();
    expect(readEditorState({ root: 42 })).toBeUndefined();
    expect(readEditorState({ root: '' })).toBeUndefined();
  });

  it('ignores a non-string doc rather than refusing the pane', () => {
    // The root is the subject; the doc is a convenience. Losing the second is
    // not worth losing the first.
    expect(readEditorState({ root: '/repo', doc: 7 })).toEqual({ root: '/repo', doc: undefined });
  });
});

describe('readTree', () => {
  it('reads paths, marks and the truncation flag', () => {
    expect(
      readTree({
        paths: ['a.ts', 'b.ts'],
        status: [{ path: 'a.ts', status: 'modified' }],
        truncated: true,
      }),
    ).toEqual({
      paths: ['a.ts', 'b.ts'],
      status: [{ path: 'a.ts', status: 'modified' }],
      truncated: true,
      notes: [],
    });
  });

  it('drops a path that is not a string, rather than rendering a blank row', () => {
    expect(readTree({ paths: ['a.ts', 7, null] }).paths).toEqual(['a.ts']);
  });

  it('drops a malformed status row rather than defaulting its mark', () => {
    expect(readTree({ status: [{ path: 'a.ts' }, { path: 'b.ts', status: 'modified' }] }).status)
      .toEqual([{ path: 'b.ts', status: 'modified' }]);
  });

  it('is an empty tree for an answer it cannot read', () => {
    const empty = { paths: [], status: [], truncated: false, notes: [] };
    expect(readTree(undefined)).toEqual(empty);
    expect(readTree('nope')).toEqual(empty);
  });

  it('reads the notes, and has none when scratch answered nothing', () => {
    expect(readTree({ notes: [{ id: 'scr_a', title: 'One' }] }).notes).toEqual([
      { id: 'scr_a', title: 'One' },
    ]);
    // A build with no scratch extension is a real state: no Notes root, and the
    // rest of the tree is unaffected.
    expect(readTree({ paths: ['a.ts'] }).notes).toEqual([]);
  });

  it('does not claim truncation for a missing flag', () => {
    expect(readTree({ paths: [] }).truncated).toBe(false);
  });
});

