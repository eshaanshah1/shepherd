import { describe, expect, it } from 'vitest';
import { absorbLines, bestTitle, emptyDigest, isEmptyDigest } from './session.ts';

const line = (rec: unknown): string => `${JSON.stringify(rec)}\n`;

const user = (text: string, ts = '2026-08-13T10:00:00.000Z'): string =>
  line({
    type: 'user',
    timestamp: ts,
    cwd: '/w/task',
    gitBranch: 'main',
    message: { role: 'user', content: text },
  });

const assistant = (text: string, ts = '2026-08-13T10:01:00.000Z'): string =>
  line({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'text', text }] } });

describe('absorbLines', () => {
  it('counts turns and collects their text in order', () => {
    const d = absorbLines(emptyDigest('abc'), user('hello') + assistant('hi back'));
    expect(d.userTurns).toBe(1);
    expect(d.assistantTurns).toBe(1);
    expect(d.turns.map((t) => [t.source, t.text])).toEqual([
      ['user', 'hello'],
      ['assistant', 'hi back'],
    ]);
  });

  it('is incremental — folding two chunks equals folding one', () => {
    const whole = absorbLines(emptyDigest('abc'), user('one') + assistant('two'));
    const split = absorbLines(absorbLines(emptyDigest('abc'), user('one')), assistant('two'));
    expect(split).toEqual(whole);
  });

  it('takes cwd and branch from the first record that carries them', () => {
    const d = absorbLines(emptyDigest('abc'), user('hello'));
    expect(d.cwd).toBe('/w/task');
    expect(d.gitBranch).toBe('main');
  });

  it('tracks the first and last timestamp across chunks', () => {
    const d = absorbLines(
      emptyDigest('abc'),
      user('early', '2026-08-13T09:00:00.000Z') + assistant('late', '2026-08-13T11:00:00.000Z'),
    );
    expect(d.firstTs).toBe(Date.parse('2026-08-13T09:00:00.000Z'));
    expect(d.lastTs).toBe(Date.parse('2026-08-13T11:00:00.000Z'));
  });

  it('keeps the newest recap when a session has several', () => {
    const chunk =
      line({
        type: 'system',
        subtype: 'away_summary',
        timestamp: '2026-08-13T10:00:00.000Z',
        content: 'older',
      }) +
      line({
        type: 'system',
        subtype: 'away_summary',
        timestamp: '2026-08-13T12:00:00.000Z',
        content: 'newer',
      });
    expect(absorbLines(emptyDigest('abc'), chunk).recap).toBe('newer');
  });

  it('records a recap as a searchable turn as well', () => {
    const chunk = line({ type: 'system', subtype: 'away_summary', content: 'shipped it' });
    expect(absorbLines(emptyDigest('abc'), chunk).turns).toEqual([
      { source: 'recap', ts: null, text: 'shipped it' },
    ]);
  });

  it('reads the title records', () => {
    const chunk = line({ type: 'ai-title', aiTitle: 'A' }) + line({ type: 'agent-name', agentName: 'orch' });
    const d = absorbLines(emptyDigest('abc'), chunk);
    expect(d.aiTitle).toBe('A');
    expect(d.agentName).toBe('orch');
  });

  it('skips malformed lines instead of throwing', () => {
    const d = absorbLines(emptyDigest('abc'), `not json\n${user('real')}{"broken":\n`);
    expect(d.userTurns).toBe(1);
  });

  it('ignores a trailing partial line so a growing file is not half-parsed', () => {
    // A file being appended to can end mid-record. The absent newline after it is
    // the only signal that it is incomplete.
    const d = absorbLines(emptyDigest('abc'), `${user('complete')}{"type":"user","mess`);
    expect(d.userTurns).toBe(1);
  });
});

describe('bestTitle', () => {
  it('prefers a custom title over the AI one', () => {
    expect(bestTitle({ ...emptyDigest('abc'), aiTitle: 'ai', customTitle: 'mine' })).toBe('mine');
  });

  it('falls back to the AI title, then to null', () => {
    expect(bestTitle({ ...emptyDigest('abc'), aiTitle: 'ai' })).toBe('ai');
    expect(bestTitle(emptyDigest('abc'))).toBeNull();
  });
});

describe('isEmptyDigest', () => {
  it('is true for a session with no turns, titles or recap', () => {
    expect(isEmptyDigest(emptyDigest('abc'))).toBe(true);
    expect(isEmptyDigest(absorbLines(emptyDigest('abc'), user('x')))).toBe(false);
  });
});
