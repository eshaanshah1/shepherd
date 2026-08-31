/**
 * **What a row draws to the right of its name — decided by its REGION, never by
 * which facts it happens to carry.**
 *
 * This file exists because the takeover shipped without it and the omission was
 * visible from across the room. `TriageRow` drew `repos`, then `diff`, then
 * `elapsed`, each one skipped when absent, packed right. Three rows under the
 * same heading therefore ended in three different places: one carried a stamp
 * and two did not, so its repo chip sat sixty pixels left of theirs. Nothing
 * right of the name could line up, because the rows were not drawing the same
 * thing — the trailing area was an accident of the payload rather than a set of
 * columns.
 *
 * The fix is not a width. It is an editorial one, and the alignment falls out of
 * it: a region exists to answer ONE question, the facts are what answer it, so
 * the region names its cells and every row in it draws exactly those. Rows in a
 * region then agree on their shape by construction, and `takeover.css` can hand
 * the tracks to the section and let the rows subgrid onto them — no reserved
 * empty columns, no magic widths, and no fact appearing on one row of three.
 *
 * **`age` is the case worth reading twice, because it is the one that was
 * wrong.** `elapsed` is stamped by `tasks` (`model/elapsed.ts`) and its written
 * justification is entirely about being blocked — "a task that has been waiting
 * on you for a quarter of an hour should itch… only a clock says how long you
 * have been the one holding it up". That argument is true in `Needs you` and
 * false in every other region. On a `Running` row you are not holding
 * anything up: nothing you would do at `3m` differs from what you would do at
 * `2m`, and the stamp is deliberately FLOORED to make a wait feel long, which is
 * the wrong feeling to induce about work that is going fine.
 *
 * The rail reached this conclusion first and `tasks/src/index.ts` records it in
 * as many words — "It is now gone from both regions, because true is not the
 * same as worth a column." The takeover reintroduced the stamp and drew it
 * everywhere. It is back to being drawn where it means something.
 */

import type { TriageGroup } from './triage.ts';

/** The trailing cells a row can hold, in the order they are always drawn. */
export type TrailCell = 'repos' | 'diff' | 'age';

/**
 * Left to right, fixed, and **`repos` is last because it is the one cell every
 * region draws.**
 *
 * A row's right edge should be the same thing on every row, and the repo is the
 * only fact that qualifies — `diff` and `age` are each region's, and a column
 * that is sometimes the last one is a ragged edge you read as misalignment even
 * when the tracks agree. So the constant cell anchors the edge and the variable
 * ones stack inward from it.
 *
 * A cell keeps its column whether or not its neighbours are drawn.
 */
export const TRAIL_ORDER: readonly TrailCell[] = ['diff', 'age', 'repos'];

export interface RegionColumns {
  /** Which cells rows in this region draw. Anything absent is not drawn. */
  readonly cells: readonly TrailCell[];
  /**
   * The coarsest stamp the `age` cell will print, when it prints one at all.
   *
   * `'d'` keeps a day-or-older stamp and drops the rest. Nothing asks for it
   * today. It is kept because the argument that wanted it is still true of some
   * future region — a stamp whose minutes nobody would act on is noise — and the
   * filter costs one branch.
   */
  readonly grain?: 'd';
}

/**
 * One region, one question, one set of cells.
 *
 * | region | the question it answers | so it draws |
 * |---|---|---|
 * | `needs`   | what is it, and how long has it been mine? | the diff, the age, the repo |
 * | `running` | which tree is it touching?                 | the repo. A mid-flight diff is a number that moves |
 * | `later`   | when does it come back?                    | the repo — the `until …` subtitle answers the rest |
 * | `shells`  | where am I?                                | the repo |
 * | `shipped` | what did it do?                            | the diff, and where |
 *
 * **`needs` is the one region that draws all three**, and it has to: it is the
 * only region whose rows differ in kind. A row an agent handed back mid-question
 * and a row that has sat untouched for three days are both yours, and the two
 * facts that tell them apart are what changed and how long it has been. Every
 * other region answers one question, so it spends one cell on it.
 *
 * **Every region draws `repos`**, which is what earns it the last track: a right
 * edge made of a cell some rows omit is ragged whatever the tracks agree on.
 * `later` and `shipped` carry nothing else — a snoozed row's reason is already
 * in its subtitle, and a shipped row's numbers are the record — but they carry
 * the repo, so the edge holds across every region on the screen.
 */
export const REGION_COLUMNS: Readonly<Record<TriageGroup, RegionColumns>> = {
  needs: { cells: ['repos', 'diff', 'age'] },
  running: { cells: ['repos'] },
  later: { cells: ['repos'] },
  shells: { cells: ['repos'] },
  shipped: { cells: ['repos', 'diff'] },
};

/**
 * The stamp this region will print, or nothing.
 *
 * A SNIFF of the drawn string rather than a number, and deliberately so: the
 * payload is a formatted stamp by contract (`formatElapsed` sends `14m`, not a
 * duration, because a raw duration is a different value on every render and the
 * renderer diffs rows to decide what to redraw — it was an infinite loop once).
 * So the unit is the only thing there is to read, and reading it is cheaper than
 * a second field on the wire that says the same thing.
 *
 * An unrecognised shape is dropped rather than drawn. A region that asked for
 * days has said what it wants a column for, and a string this code cannot place
 * is not evidence that it wanted something else.
 */
export function ageFor(elapsed: string | undefined, grain: RegionColumns['grain']): string | undefined {
  if (elapsed === undefined) return undefined;
  if (grain === undefined) return elapsed;
  return elapsed.endsWith('d') ? elapsed : undefined;
}
