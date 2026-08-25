import { describe, expect, it } from 'vitest';
import { treePaths } from './paths.ts';

/*
 * Verbatim output from a real repo, captured while designing this:
 *   git ls-files --cached --others --exclude-standard
 *   git ls-files --others --ignored --exclude-standard --directory
 */
const TRACKED = '.gitignore\nnew.txt\nsrc/b.ts\na.txt\n';
const IGNORED = '.env\nnode_modules/\nrun.log\n';

describe('treePaths', () => {
  it('keeps ignored FILES and drops ignored DIRECTORIES', () => {
    const paths = treePaths(TRACKED, IGNORED);
    // The whole point: an ignored file is very often the file you opened the
    // editor to change.
    expect(paths).toContain('.env');
    expect(paths).toContain('run.log');
    // An ignored directory is one you never open, and enumerating it is what
    // makes an eager flat path list impossible.
    expect(paths).not.toContain('node_modules/');
    expect(paths.some((path) => path.startsWith('node_modules'))).toBe(false);
  });

  it('includes tracked and untracked-but-not-ignored files', () => {
    const paths = treePaths(TRACKED, IGNORED);
    expect(paths).toContain('src/b.ts');
    expect(paths).toContain('a.txt');
    expect(paths).toContain('new.txt');
  });

  it('sorts, and de-duplicates a path both lists name', () => {
    expect(treePaths('b.ts\na.ts\n', 'a.ts\n')).toEqual(['a.ts', 'b.ts']);
  });

  it('is empty for empty output rather than yielding one blank path', () => {
    // A trailing newline splits to a final '' — a row in the tree with no name.
    expect(treePaths('', '')).toEqual([]);
    expect(treePaths('\n', '\n')).toEqual([]);
  });

  it('drops a nested ignored directory too, not just a top-level one', () => {
    // `--directory` collapses at whatever depth the ignore matched.
    const paths = treePaths('src/a.ts\n', 'src/generated/\n');
    expect(paths).toEqual(['src/a.ts']);
  });
});
