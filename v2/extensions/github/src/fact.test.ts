import { describe, expect, it } from 'vitest';
import { FACT } from './model/card-fact.ts';
import { REASONS, rollUp, type TaskPrState } from './model/index.ts';

/** The sentence the glyph's tooltip ends in, for one state. */
const rollUpSaidFor = (state: Exclude<TaskPrState, 'none'>): string => REASONS[state];

/**
 * What the rail's PR glyph looks like, per rollup state.
 *
 * This mapping is only worth a test because the fact is **drawn at rest** now.
 * While it was revealed on hover its tooltip carried the whole meaning and the
 * glyph was decoration; on a rail you scan, it is the meaning.
 */
describe('the rail glyph, per rollup state', () => {
  const states: readonly TaskPrState[] = [
    'failed',
    'waiting',
    'blocked',
    'running',
    'approved',
    'open',
    'merged',
    'closed',
    'none',
  ];

  it('covers every rollup state, so a new one fails the build', () => {
    // `rollUp` is the only producer, and a state with no entry here would draw
    // `undefined` — which `NAMED_GLYPHS` resolves to nothing at all.
    for (const state of states) expect(FACT[state], state).toBeDefined();
    expect(Object.keys(FACT).sort()).toEqual([...states].sort());
  });

  it('names glyphs from the pull-request family and nothing else', () => {
    /*
     * A NAME, never an SVG, and this file cannot check that the name resolves —
     * the allow-list is the renderer's and an extension may import
     * `@shepherd/sdk` alone, which is the boundary working rather than a gap.
     * The renderer's own test asserts every name here is one it carries.
     *
     * What this side can hold is that the glyph stays inside the family a reader
     * already knows on sight. A state drawn with some other mark would be us
     * teaching a private vocabulary for a noun every forge in the world draws
     * the same way.
     */
    for (const state of states) {
      expect(FACT[state].icon, state).toMatch(/^pull-request(-closed|-draft|-merged)?$/);
    }
  });

  it('lets exactly two PAIRS share a reading, and says which', () => {
    /*
     * Two states may look identical, and two do. That is a decision, not a gap:
     * `glyphs.ts` carries four pull-request shapes because a forge's own family
     * already means something to a reader on sight, and there is no shape in it
     * for "a human asked for changes". Inventing a fifth would be teaching our
     * own mark instead of using the one everybody knows.
     *
     * What makes the pairs affordable is that each pair is ONE decision:
     *
     *   failed / waiting  — red, and both mean "this cannot merge until you do
     *                       something", so you go to the same place either way.
     *   blocked / running — honey, and both mean "not yet".
     *
     * The pairs are listed here rather than derived, so a THIRD state joining
     * one of them fails this test — which is where it stops being a decision and
     * starts being a colour doing too much work.
     */
    const pairs = [
      ['failed', 'waiting'],
      ['blocked', 'running'],
    ] as const;

    const reading = (state: TaskPrState): string => `${FACT[state].tone ?? 'quiet'}/${FACT[state].icon}`;
    for (const [a, b] of pairs) expect(reading(a), `${a} vs ${b}`).toBe(reading(b));

    const groups = new Map<string, TaskPrState[]>();
    for (const state of states.filter((candidate) => candidate !== 'none')) {
      groups.set(reading(state), [...(groups.get(reading(state)) ?? []), state]);
    }
    const collisions = [...groups.values()].filter((group) => group.length > 1);
    expect(collisions.map((group) => group.join('/')).sort()).toEqual(['blocked/running', 'failed/waiting']);
  });

  it('separates every pair by WORDS, since two of them are not separated by sight', () => {
    /*
     * §5's real requirement, and the half that carries the two pairs above: every
     * mark states its meaning as its accessible name and its tooltip. A fact
     * whose only content is a colour cannot be read out, searched, or asserted
     * on — so the sentence is the thing that must be unique, and it is.
     */
    const said = states
      .filter((candidate) => candidate !== 'none')
      .map((state) => rollUpSaidFor(state as Exclude<TaskPrState, 'none'>));
    expect(new Set(said).size, said.join(' | ')).toBe(said.length);
  });

  it('gives the two states that used to collide their own readings', () => {
    // `running` and `open` were both `sky`; `merged` and a fact that is not
    // asking for anything were both quiet grey.
    expect(FACT.running.tone).toBe('pending');
    expect(FACT.open.tone).toBe('neutral');
    expect(FACT.merged.tone).toBe('done');
    expect(FACT.merged.icon).toBe('pull-request-merged');
    /*
     * And `open` keeps the PLAIN glyph. The draft mark belongs to a PR opened as
     * a draft, and `cardFact` also draws it for a task with NO pull request —
     * so claiming it here would put two unrelated meanings one tone apart.
     */
    expect(FACT.open.icon).toBe('pull-request');
  });

  it('draws nothing for a task with no PRs — via rollUp, not via FACT', () => {
    // `none`'s entry exists only so the record is exhaustive. The provider
    // returns before reading it, because a glyph there would claim a state.
    expect(rollUp([])).toBe('none');
  });
});
