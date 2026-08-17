import { describe, expect, it } from 'vitest';
import { bestTitle, isEmptyDigest, type SessionDigest } from './session.ts';
import { emptyRollup } from './usage.ts';
import { absorb, emptySession } from '../parse/session.ts';
import { digestOf } from '../parse/digest.ts';

/**
 * What is left of this file is the two derivations that stayed here.
 *
 * The fold it used to test moved to `parse/session.ts` and is covered by
 * `parse/session.test.ts` (the fold itself) and `parse/digest.test.ts` (this
 * shape). A digest is a projection now; there is nothing here that builds one.
 */

const blank: SessionDigest = {
  sessionId: 'abc',
  cwd: null,
  gitBranch: null,
  aiTitle: null,
  customTitle: null,
  agentName: null,
  recap: null,
  recapTs: null,
  firstTs: null,
  lastTs: null,
  userTurns: 0,
  assistantTurns: 0,
  turns: [],
  models: [],
  usage: emptyRollup(),
};

describe('bestTitle', () => {
  it('prefers a custom title over the AI one', () => {
    expect(bestTitle({ ...blank, aiTitle: 'ai', customTitle: 'mine' })).toBe('mine');
  });

  it('falls back to the AI title, then to null', () => {
    expect(bestTitle({ ...blank, aiTitle: 'ai' })).toBe('ai');
    expect(bestTitle(blank)).toBeNull();
  });
});

describe('isEmptyDigest', () => {
  it('is true for a session with no turns, titles or recap', () => {
    expect(isEmptyDigest(blank)).toBe(true);
  });

  it('is false once somebody has said something', () => {
    const said = digestOf(
      absorb(
        emptySession('abc', '/x'),
        `${JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'x' } })}\n`,
      ),
    );
    expect(isEmptyDigest(said)).toBe(false);
  });
});
