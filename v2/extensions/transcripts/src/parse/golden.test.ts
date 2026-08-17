import { describe, expect, it } from 'vitest';
import { FIXTURES, readFixture } from '../fixtures.ts';
import { absorb, emptySession } from './session.ts';
import { digestOf } from './digest.ts';

/**
 * Whole digests, pinned.
 *
 * Recorded first against the parser this replaced, then repointed here — so the
 * snapshot diff at that moment WAS the review of the rewrite. Four differences
 * were intended and blessed:
 *
 *   1. `markup-prompt` gains its user turn. The old filter stripped every paired
 *      tag and dropped a turn if nothing survived, so a pasted `<code>` block
 *      was deleted from the index outright.
 *   2. `interrupt` loses `[Request interrupted by user]` as a user turn. Nobody
 *      typed it and nobody searches for it.
 *   3. `compaction`'s summary moves from `user` to `recap`. Its text is kept —
 *      after a compaction it is the only copy of the earlier conversation — but
 *      attributing it to the user was always wrong.
 *   4. Every digest gains `models`, `usage`, and a `seq` on each turn.
 *
 * A fifth kind of difference is a regression. The first review of this diff
 * turned one up: the compact summary was being dropped ENTIRELY rather than
 * reattributed, which would have deleted a session's pre-compaction history from
 * the index. Re-bless deliberately or not at all.
 */
describe('digest golden', () => {
  for (const name of FIXTURES) {
    it(`${name} folds to a stable digest`, () => {
      expect(
        digestOf(absorb(emptySession(name, `/x/${name}.jsonl`), readFixture(name))),
      ).toMatchSnapshot();
    });
  }
});
