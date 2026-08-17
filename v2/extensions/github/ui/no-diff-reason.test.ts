import { describe, expect, it } from 'vitest';
import { noDiffReason } from './pr-panels.tsx';

/**
 * Every patchless file used to say "the diff for this file has not been
 * fetched", and for most of them that was false. `shepherd#4` renamed a
 * directory and carried six files across unchanged; GitHub sends no patch for
 * those because there is no diff to send, and the pane told you to wait for one.
 */
describe('noDiffReason', () => {
  it('says a rename is a rename, and where it came from', () => {
    expect(
      noDiffReason({
        path: 'v2/extensions/transcripts/src/index.test.ts',
        added: 0,
        removed: 0,
        status: 'renamed',
        previousPath: 'v2/extensions/recall/src/index.test.ts',
      }),
    ).toBe(
      'Renamed from v2/extensions/recall/src/index.test.ts. Its contents did not change, so there is no diff.',
    );
  });

  it('still says rename when GitHub did not send the old path', () => {
    const said = noDiffReason({ path: 'a.ts', added: 0, removed: 0, status: 'renamed' });
    expect(said).toContain('Renamed');
    expect(said).not.toContain('undefined');
  });

  it('does not claim a rename for an empty file that was not renamed', () => {
    const said = noDiffReason({ path: 'a.ts', added: 0, removed: 0, status: 'modified' });
    expect(said).not.toContain('Renamed');
    expect(said).toContain('identical');
  });

  it('sends you to GitHub only when GitHub is withholding a diff it has', () => {
    // Binary, or over the per-file limit — the one case where the trip is worth
    // it, and the only one that should mention leaving.
    const said = noDiffReason({ path: 'logo.png', added: 12, removed: 3, status: 'modified' });
    expect(said).toContain('Open it on GitHub');
  });

  it('never tells anybody to wait for a fetch', () => {
    const files = [
      { path: 'a', added: 0, removed: 0, status: 'renamed' as const },
      { path: 'b', added: 0, removed: 0 },
      { path: 'c', added: 1, removed: 1 },
    ];
    for (const file of files) expect(noDiffReason(file)).not.toContain('fetched');
  });
});
