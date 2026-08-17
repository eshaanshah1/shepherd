import { describe, expect, it } from 'vitest';
import { countMatches, matchesIn, snippetAround } from './search.ts';
import { type SessionDigest } from './session.ts';
import { absorb, emptySession } from '../parse/session.ts';
import { digestOf } from '../parse/digest.ts';

const line = (rec: unknown): string => `${JSON.stringify(rec)}\n`;
// Built through the real fold rather than by hand, so a change to what a digest
// contains reaches these tests instead of passing them by.
const withTurns = (...texts: string[]): SessionDigest =>
  digestOf(
    absorb(
      emptySession('abc', '/x/abc.jsonl'),
      texts
        .map((t, i) =>
          line({ type: 'user', uuid: `u${String(i)}`, message: { role: 'user', content: t } }),
        )
        .join(''),
    ),
  );

describe('snippetAround', () => {
  it('keeps the whole line when it is short', () => {
    const out = snippetAround('set band.rail to 264', 4, 8);
    expect(out.text).toBe('set band.rail to 264');
    expect(out.at).toEqual([4, 8]);
  });

  it('windows a long line and moves the range with it', () => {
    const text = `${'a'.repeat(200)}NEEDLE${'b'.repeat(200)}`;
    const out = snippetAround(text, 200, 206, 10);
    expect(out.text).toBe(`${'a'.repeat(10)}NEEDLE${'b'.repeat(10)}`);
    expect(out.at).toEqual([10, 16]);
    expect(out.text.slice(out.at[0], out.at[1])).toBe('NEEDLE');
  });

  it('collapses newlines so a snippet is one line', () => {
    const out = snippetAround('first\nsecond NEEDLE', 13, 19);
    expect(out.text).toBe('first second NEEDLE');
    expect(out.text.slice(out.at[0], out.at[1])).toBe('NEEDLE');
  });

  it('keeps the highlight correct when whitespace before the hit collapses', () => {
    const out = snippetAround('a     \n\n  b NEEDLE', 12, 18);
    expect(out.text.slice(out.at[0], out.at[1])).toBe('NEEDLE');
  });
});

describe('matchesIn', () => {
  it('finds a case-insensitive substring in a user turn', () => {
    const hits = matchesIn(withTurns('i wanna add Recall to shepherd'), 'recall');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.source).toBe('user');
    expect(hits[0]?.text.slice(hits[0].at[0], hits[0].at[1])).toBe('Recall');
  });

  it('returns nothing for a query that is absent', () => {
    expect(matchesIn(withTurns('nothing here'), 'recall')).toEqual([]);
  });

  it('treats regex metacharacters as literal text', () => {
    expect(matchesIn(withTurns('a.b'), 'a.b')).toHaveLength(1);
    expect(matchesIn(withTurns('axb'), 'a.b')).toEqual([]);
  });

  it('caps at max and defaults that cap to 3', () => {
    const many = withTurns('recall', 'recall', 'recall', 'recall', 'recall');
    expect(matchesIn(many, 'recall')).toHaveLength(3);
    expect(matchesIn(many, 'recall', 2)).toHaveLength(2);
  });

  it('puts side-field matches before body matches, recall-style', () => {
    const digest: SessionDigest = { ...withTurns('recall in a turn'), aiTitle: 'recall in the title' };
    const hits = matchesIn(digest, 'recall');
    expect(hits[0]?.source).toBe('title');
    expect(hits.at(-1)?.source).toBe('user');
  });

  it('matches the recap and the agent name', () => {
    const digest: SessionDigest = {
      ...withTurns(),
      recap: 'ported recall',
      agentName: 'recall-bot',
    };
    expect(matchesIn(digest, 'recall').map((m) => m.source)).toEqual(['recap', 'agent']);
  });

  it('returns nothing for an empty query rather than everything', () => {
    expect(matchesIn(withTurns('recall'), '   ')).toEqual([]);
  });

  it('finds only the FIRST match within one turn, so one turn is one row', () => {
    expect(matchesIn(withTurns('recall and recall again'), 'recall')).toHaveLength(1);
  });
});

describe('countMatches', () => {
  it('counts every matching turn, ignoring the per-session cap', () => {
    const many = withTurns('recall', 'recall', 'recall', 'recall', 'recall');
    expect(countMatches(many, 'recall')).toBe(5);
  });

  it('counts side fields too', () => {
    const digest: SessionDigest = { ...withTurns('recall'), recap: 'recall' };
    expect(countMatches(digest, 'recall')).toBe(2);
  });

  it('is zero for an empty query', () => {
    expect(countMatches(withTurns('recall'), '')).toBe(0);
  });
});
