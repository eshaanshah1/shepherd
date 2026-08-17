import { describe, expect, it } from 'vitest';
import { FIXTURES, readFixture } from '../fixtures.ts';
import { absorbLines, emptyDigest } from '../model/session.ts';

/**
 * The baseline, recorded against the parser as it stands.
 *
 * It exists so the rewrite has something to be judged against. Every difference
 * the rewrite produces must be one somebody looked at and intended — the danger
 * in replacing a parser is not the change you meant, it is the three you did
 * not notice underneath it.
 *
 * This file is repointed at the new fold in Task 9, and the diff at that moment
 * IS the review.
 */
describe('digest golden', () => {
  for (const name of FIXTURES) {
    it(`${name} folds to a stable digest`, () => {
      expect(absorbLines(emptyDigest(name), readFixture(name))).toMatchSnapshot();
    });
  }
});
