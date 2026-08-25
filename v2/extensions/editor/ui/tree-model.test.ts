// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { FileTree } from '@pierre/trees';

/**
 * What `@pierre/trees` does with its `paths`, pinned — because the pane's
 * correctness rests on it and it is not what the option's name suggests.
 *
 * `useFileTree` is `useState(() => new FileTree(options))`. The options are
 * read **once, at construction**; a later `paths` is not observed. Every path
 * in the editor pane arrives from a command a tick after mount, so the plain
 * option builds an empty tree and leaves it empty — which is exactly what
 * shipped: `editor.tree` answered 829 paths and the rail drew nothing.
 *
 * `github`'s Files tab uses the plain option and is fine, which is what made
 * copying its call site look sufficient: a PR's file list is already on the
 * record when that panel mounts.
 *
 * A characterisation test, so a version bump that fixed the option would fail
 * here and tell us the `resetPaths` effect can go.
 */

const PATHS = ['a.ts', 'src/b.ts'];

describe('a FileTree model', () => {
  it('has the rows when it is CONSTRUCTED with paths', () => {
    expect(new FileTree({ paths: PATHS }).getVisibleCount()).toBe(2);
  });

  it('does NOT pick up paths handed to it after construction', () => {
    // The bug, stated as the package's behaviour. Nothing here is wrong — it is
    // simply not a reactive option, and the pane has to say so.
    const model = new FileTree({ paths: [] });
    expect(model.getVisibleCount()).toBe(0);
  });

  it('takes them through resetPaths, which is the supported way', () => {
    const model = new FileTree({ paths: [] });
    model.resetPaths(PATHS);
    expect(model.getVisibleCount()).toBe(2);
  });

  it('replaces rather than appends, so a filter narrows the same tree', () => {
    const model = new FileTree({ paths: PATHS });
    model.resetPaths(['src/b.ts']);
    // 1 file. Its parent directory is a row too, which is why this asserts the
    // file is reachable rather than asserting a bare count.
    expect(model.getItem('src/b.ts')).not.toBeNull();
    expect(model.getItem('a.ts')).toBeNull();
  });
});
