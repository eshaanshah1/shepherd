import { describe, expect, it } from 'vitest';
import { readRowFacts } from './row-facts.ts';
import {
  TRIAGE_ORDER,
  liveCount,
  needsYou,
  nextNeeding,
  triage,
  triageOf,
  type TriageEntry,
} from './triage.ts';

const entry = (over: Partial<TriageEntry> & { id: string }): TriageEntry => ({
  label: over.id,
  rowId: over.id,
  mark: 'ready',
  place: false,
  facts: {},
  viewType: 'tasks.tree',
  ...over,
});

const withDiff = (id: string, mark: TriageEntry['mark'] = 'ready'): TriageEntry =>
  entry({ id, mark, facts: { diff: { added: 9, removed: 2, files: 1 } } });

describe('triageOf', () => {
  it.each([
    ['waiting', 'needs'],
    ['failed', 'needs'],
    ['ready', 'needs'],
    ['working', 'running'],
    ['shipped', 'shipped'],
  ] as const)('files a %s task under %s', (mark, group) => {
    expect(triageOf(entry({ id: mark, mark }))).toBe(group);
  });

  it('files an idle task under Needs you whether or not it changed anything', () => {
    /*
     * The two used to be `Ready to ship` and `Resting`, split on whether git
     * found bytes. That is a fact about the row and not a kind of ownership —
     * one line written by an agent that then stopped earned the heading — and
     * both are the same answer to the only question this file asks: nobody is
     * working on it and nobody deferred it, so it is yours.
     */
    expect(triageOf(withDiff('landed'))).toBe('needs');
    expect(triageOf(entry({ id: 'asleep' }))).toBe('needs');
  });

  it('leaves a WORKING task in Running whatever it has written so far', () => {
    expect(triageOf(withDiff('mid-turn', 'working'))).toBe('running');
  });

  it('files a row whose state nothing could name under Needs you', () => {
    // No `mark` in the facts and a tint this build does not map. If the shell
    // cannot say what is happening, looking is the user's move.
    expect(triageOf(entry({ id: 'mystery', mark: undefined }))).toBe('needs');
  });

  it('lets a snooze outrank the state it is sleeping on', () => {
    const snoozed = entry({
      id: 'flake',
      mark: 'waiting',
      facts: { snooze: { label: 'later today' } },
    });
    expect(triageOf(snoozed)).toBe('later');
    // …and that is the whole of "not now": the row is still in the list.
    expect(triage([snoozed]).flatMap((section) => section.entries)).toEqual([snoozed]);
  });

  it('keeps a shell out of every lifecycle region, whatever its mark says', () => {
    /*
     * A loose terminal has no lifecycle and never enters the queue — but an
     * agent CAN be running in one, so it can arrive tinted. Reading the mark
     * first would have put a shell in `Needs you`.
     */
    for (const mark of ['working', 'waiting', 'failed', 'ready', 'later'] as const) {
      expect(triageOf(entry({ id: `sh-${mark}`, mark, place: true })), mark).toBe('shells');
    }
  });

  it('keeps a shipped task out of Later even when it was snoozed', () => {
    const shipped = entry({ id: 'ship1', mark: 'shipped', facts: { snooze: { label: 'tomorrow' } } });
    expect(triageOf(shipped)).toBe('shipped');
  });
});

describe('triage', () => {
  it('orders the regions by how much attention they are entitled to', () => {
    const sections = triage([
      entry({ id: 'ship1', mark: 'shipped' }),
      entry({ id: 'sh', place: true }),
      entry({ id: 'snoozed', mark: 'later', facts: { snooze: { label: 'tomorrow' } } }),
      entry({ id: 'run', mark: 'working' }),
      entry({ id: 'ask', mark: 'waiting' }),
    ]);
    expect(sections.map((section) => section.group)).toEqual([...TRIAGE_ORDER]);
  });

  it('hides a region with nothing in it', () => {
    const sections = triage([entry({ id: 'run', mark: 'working' })]);
    expect(sections.map((section) => section.group)).toEqual(['running']);
  });

  it('draws exactly one region loud, and it is Needs you', () => {
    const sections = triage([entry({ id: 'ask', mark: 'waiting' }), entry({ id: 'run', mark: 'working' })]);
    expect(sections.filter((section) => section.loud).map((s) => s.group)).toEqual(['needs']);
  });

  it('loses nothing: every entry lands in exactly one region', () => {
    const entries = [
      entry({ id: 'a', mark: 'waiting' }),
      entry({ id: 'b', mark: 'working' }),
      entry({ id: 'c' }),
      withDiff('d'),
      entry({ id: 'e', facts: { snooze: { label: 'later today' } } }),
      entry({ id: 'f', place: true }),
      entry({ id: 'g', mark: 'shipped' }),
    ];
    const placed = triage(entries).flatMap((section) => section.entries.map((each) => each.id));
    expect(placed.sort()).toEqual(entries.map((each) => each.id).sort());
    expect(new Set(placed).size).toBe(entries.length);
  });

  it('keeps a region’s rows in the order they arrived', () => {
    const sections = triage([
      entry({ id: 'second', mark: 'working' }),
      entry({ id: 'first', mark: 'waiting' }),
      entry({ id: 'third', mark: 'working' }),
    ]);
    const running = sections.find((section) => section.group === 'running');
    expect(running?.entries.map((each) => each.id)).toEqual(['second', 'third']);
  });
});

describe('the count and the jump', () => {
  const entries = [
    entry({ id: 'ask', mark: 'waiting' }),
    entry({ id: 'broke', mark: 'failed' }),
    entry({ id: 'run', mark: 'working' }),
    entry({ id: 'sh', place: true }),
    entry({ id: 'ship1', mark: 'shipped' }),
  ];

  it('counts as LIVE everything that is neither a record nor a place', () => {
    expect(liveCount(entries)).toBe(3);
  });

  it('counts an idle task, because an idle task is one of the things needing you', () => {
    // The number in the header moved when `Resting` folded into `Needs you`, and
    // it moved on purpose: a task nobody is working on is a task waiting on you,
    // and a count that excluded it was reporting a smaller morning than you had.
    expect(liveCount([...entries, entry({ id: 'asleep' })])).toBe(4);
    expect(needsYou([...entries, entry({ id: 'asleep' })]).map((each) => each.id)).toEqual([
      'ask',
      'broke',
      'asleep',
    ]);
  });

  it('walks the same queue Home draws, in the same order', () => {
    expect(needsYou(entries).map((each) => each.id)).toEqual(['ask', 'broke']);
    expect(nextNeeding(entries)?.id).toBe('ask');
  });

  it('skips the one you are already looking at, so J moves', () => {
    expect(nextNeeding(entries, 'ask')?.id).toBe('broke');
    expect(nextNeeding(entries, 'broke')?.id).toBe('ask');
  });

  it('answers nothing when nothing needs you', () => {
    expect(nextNeeding([entry({ id: 'run', mark: 'working' })])).toBeUndefined();
  });
});

describe('readRowFacts', () => {
  it('answers an empty set for a row that carries no data at all', () => {
    expect(readRowFacts(undefined)).toEqual({});
    expect(readRowFacts('a string that crossed the port')).toEqual({});
  });

  it('reads the facts a card publishes', () => {
    const facts = readRowFacts({
      mark: 'waiting',
      elapsed: '14m',
      summary: 'Plan approval',
      diff: { added: 64, removed: 18, files: 3 },
      repos: [{ name: 'shepherd', mark: 'repo1' }],
      question: {
        text: 'Replace the fixed retry with backoff?',
        answers: [
          { label: 'Approve', command: 'tasks.answer', args: { yes: true }, key: 'Y' },
          { label: 'Revise', command: 'tasks.answer', args: { yes: false }, key: 'N' },
        ],
      },
      snooze: { label: 'later today', wakeAt: 1_700_000_000_000 },
    });
    expect(facts.mark).toBe('waiting');
    expect(facts.diff).toEqual({ added: 64, removed: 18, files: 3 });
    expect(facts.question?.answers?.[1]?.key).toBe('N');
    expect(facts.snooze).toEqual({ label: 'later today', wakeAt: 1_700_000_000_000 });
  });

  it('drops a shape it cannot use rather than throwing on it', () => {
    // A third-party tree is exactly what this reader exists for, and a cast is
    // not a check — the crash it prevents took the whole rail down once already.
    const facts = readRowFacts({
      mark: 'exploded',
      diff: { added: '64' },
      repos: 'shepherd',
      question: { answers: [] },
      snooze: {},
    });
    expect(facts).toEqual({});
  });

  it('draws no diff line for a task that changed nothing', () => {
    expect(readRowFacts({ diff: { added: 0, removed: 0, files: 0 } }).diff).toBeUndefined();
  });

  it('refuses a question with one usable answer, because the other would be invisible', () => {
    const facts = readRowFacts({
      question: { text: 'Allow?', answers: [{ label: 'Allow', command: 'x' }, { label: 'Deny' }] },
    });
    expect(facts.question?.text).toBe('Allow?');
    expect(facts.question?.answers).toBeUndefined();
  });
});
