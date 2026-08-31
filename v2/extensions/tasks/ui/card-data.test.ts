import { describe, expect, it } from 'vitest';
import { readCardData } from './card-data.ts';

/**
 * This value crossed an IPC port and arrives as `unknown`. Every case here is a
 * way a malformed contribution could otherwise throw inside React's render —
 * and this renders in the rail, so the throw takes the whole window.
 */
describe('readCardData', () => {
  it('reads a full card', () => {
    expect(
      readCardData({
        mark: 'working',
        summary: 'running the suite',
        diff: { added: 142, removed: 38, files: 7 },
        suite: { total: 4, passed: 3 },
        repos: [{ name: 'api', mark: 'repo1' }],
        tabs: ['working', 'ready'],
      }),
    ).toEqual({
      mark: 'working',
      summary: 'running the suite',
      diff: { added: 142, removed: 38, files: 7 },
      suite: { total: 4, passed: 3 },
      repos: [{ name: 'api', mark: 'repo1' }],
      tabs: ['working', 'ready'],
      question: undefined,
      exitCode: undefined,
    });
  });

  it('refuses a card with no readable MARK', () => {
    // The one field with no honest default: it is the whole point of the row,
    // and guessing `resting` would say "nothing is happening" about a task that
    // might be waiting on you.
    for (const bad of [null, undefined, 42, 'working', {}, { mark: 'busy' }, { mark: 7 }]) {
      expect(readCardData(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('drops a diff that is all zeroes rather than drawing `+0 −0`', () => {
    expect(readCardData({ mark: 'ready', diff: { added: 0, removed: 0, files: 0 } })?.diff).toBeUndefined();
  });

  it('drops a partial diff rather than defaulting the missing half to zero', () => {
    // A card that omits a fact is honest; one that invents a zero is not.
    expect(readCardData({ mark: 'ready', diff: { added: 5 } })?.diff).toBeUndefined();
    expect(readCardData({ mark: 'ready', diff: 'lots' })?.diff).toBeUndefined();
  });

  it('takes two answers or NONE, never one', () => {
    // A card with one button is a card whose other option is invisible. The
    // `check →` door is the honest shape for anything that is not a clean pair.
    const one = readCardData({
      mark: 'waiting',
      question: { text: 'Allow?', answers: [{ label: 'Allow', command: 'a' }] },
    });
    expect(one?.question?.text).toBe('Allow?');
    expect(one?.question?.answers).toBeUndefined();

    const three = readCardData({
      mark: 'waiting',
      question: {
        text: 'Which?',
        answers: [
          { label: 'A', command: 'a' },
          { label: 'B', command: 'b' },
          { label: 'C', command: 'c' },
        ],
      },
    });
    expect(three?.question?.answers).toBeUndefined();
  });

  it('drops an answer with no verb — a button that does nothing is worse than none', () => {
    const data = readCardData({
      mark: 'waiting',
      question: { text: 'Allow?', answers: [{ label: 'Allow' }, { label: 'Deny', command: 'd' }] },
    });
    expect(data?.question?.answers).toBeUndefined();
  });

  it('keeps a clean pair, with its keys', () => {
    const data = readCardData({
      mark: 'waiting',
      question: {
        text: 'Allow',
        subject: 'rm -rf build',
        answers: [
          { label: 'Allow', command: 'tasks.allow', key: 'y' },
          { label: 'Deny', command: 'tasks.deny', key: 'n' },
        ],
      },
    });
    expect(data?.question?.subject).toBe('rm -rf build');
    expect(data?.question?.answers?.map((a) => a.key)).toEqual(['y', 'n']);
  });

  it('skips junk inside a list instead of failing the whole card', () => {
    const data = readCardData({
      mark: 'ready',
      repos: [{ name: 'api', mark: 'repo1' }, 'nonsense', { name: 'no-mark' }, null],
      tabs: ['working', 'nope', 42, 'ready'],
    });
    expect(data?.repos).toEqual([{ name: 'api', mark: 'repo1' }]);
    expect(data?.tabs).toEqual(['working', 'ready']);
  });

  it('treats an empty list as absent, so nothing renders an empty strip', () => {
    const data = readCardData({ mark: 'ready', repos: [], tabs: [] });
    expect(data?.repos).toBeUndefined();
    expect(data?.tabs).toBeUndefined();
  });

  it('drops a suite with no tests — SuiteMeter would draw nothing anyway', () => {
    expect(readCardData({ mark: 'ready', suite: { total: 0, passed: 0 } })?.suite).toBeUndefined();
    expect(readCardData({ mark: 'ready', suite: { total: 4 } })?.suite).toBeUndefined();
  });

  it('reads a duplicate count only above one, and only on shipped work', () => {
    /*
     * The row that stands for more than one task. `1` is not a duplicate and `0` is
     * not a count, so both arrive absent and the card's test is presence.
     *
     * The `shipped` gate is a refusal, not a tidy-up: two LIVE tasks of the same
     * name are two things you are separately doing, and one row standing for both
     * would hide one that might be waiting on you.
     */
    expect(readCardData({ mark: 'shipped', shipped: true, dupe: 2 })?.dupe).toBe(2);
    expect(readCardData({ mark: 'shipped', shipped: true, dupe: 1 })?.dupe).toBeUndefined();
    expect(readCardData({ mark: 'shipped', shipped: true, dupe: 0 })?.dupe).toBeUndefined();
    expect(readCardData({ mark: 'shipped', shipped: true, dupe: 'two' })?.dupe).toBeUndefined();
    expect(readCardData({ mark: 'working', dupe: 2 })?.dupe).toBeUndefined();
  });

  it('never throws, whatever it is handed', () => {
    const nasty: unknown[] = [
      { mark: 'ready', repos: 'not a list', tabs: {}, question: 5, suite: [], diff: [] },
      { mark: 'failed', exitCode: 'one', summary: '' },
      { mark: 'waiting', question: { text: '' } },
      { mark: 'waiting', question: { answers: [] } },
    ];
    for (const value of nasty) expect(() => readCardData(value)).not.toThrow();
  });
});

describe('facts, which come from an extension this code has never seen', () => {
  const read = (facts: unknown): unknown => readCardData({ mark: 'working', facts })?.facts;

  it('keeps a well-formed fact whole', () => {
    expect(read([{ icon: 'pull-request', label: '#44', tone: 'negative', title: 'a check failed' }])).toEqual([
      { icon: 'pull-request', label: '#44', tone: 'negative', title: 'a check failed' },
    ]);
  });

  it('drops one bad fact and keeps its neighbours', () => {
    // A point any extension may register with must not let one contribution
    // take the whole cell — or the rail.
    expect(
      read([
        { title: 'no content at all' },
        7,
        null,
        { icon: 'pull-request' },
        { icon: 'pull-request', title: 'kept' },
      ]),
    ).toEqual([{ icon: 'pull-request', tone: 'quiet', title: 'kept' }]);
  });

  it('reads an unrecognised tone as quiet rather than refusing the fact', () => {
    expect(read([{ label: '#1', title: 'x', tone: 'chartreuse' }])).toEqual([
      { label: '#1', tone: 'quiet', title: 'x' },
    ]);
  });

  it('drops a command with no id, since a cell that looks clickable must do something', () => {
    expect(read([{ label: '#1', title: 'x', command: { args: { a: 1 } } }])).toEqual([
      { label: '#1', tone: 'quiet', title: 'x' },
    ]);
    expect(read([{ label: '#1', title: 'x', command: { id: 'github.review' } }])).toEqual([
      { label: '#1', tone: 'quiet', title: 'x', command: { id: 'github.review', args: undefined } },
    ]);
  });

  it('is absent, not empty, when nothing was contributed', () => {
    expect(readCardData({ mark: 'working' })?.facts).toBeUndefined();
    expect(read('not an array')).toBeUndefined();
  });
});

describe('an incognito task', () => {
  it('reads the flag through, so the card can say the session leaves nothing behind', () => {
    expect(readCardData({ mark: 'ready', incognito: true })?.incognito).toBe(true);
  });

  it('is absent on an ordinary task rather than false', () => {
    expect(readCardData({ mark: 'ready' })).not.toHaveProperty('incognito');
  });
});
