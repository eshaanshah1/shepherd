import type { AgentState } from '@shepherd/ext-agents-core/state';
import { URGENCY } from './state.ts';

/**
 * The shells of the home group → the rows the rail shows for them.
 *
 * **Capped**, and the cap is why this is a function rather than a `.map`. The
 * rail's job is the list of WORK; a region of eight abandoned one-off shells
 * pushing every task off the screen is the failure this feature would otherwise
 * introduce. Past the cap it shows some of them and says how many it is not
 * showing, which is a count you can act on rather than a list to scroll.
 *
 * Three rows including the overflow row, matching `tasks`' own cap: two regions
 * capped at different numbers would read as two rules.
 *
 * Pure and total, the same shape as `state.ts` beside it: no layout, no host, no
 * running app.
 */
export const SHELL_ROW_CAP = 3;

export interface ShellRow {
  /** The layout root this row stands for. */
  readonly root: string;
  /** Resolved by `layout.listRoots`, never derived here. */
  readonly label: string;
  /**
   * The state of whatever is running in it, absent when nothing is.
   *
   * A shell usually has none — that is what makes it a shell rather than an
   * agent — so this is the one field that is normally missing.
   */
  readonly state?: AgentState;
}

/** The overflow row, and the way back from it. */
export type CappedRow =
  | ShellRow
  | { readonly kind: 'more'; readonly count: number }
  | { readonly kind: 'less' };

/**
 * An unrecognised state ranks AS the quiet case, not below it.
 *
 * `rollUp` already folds anything it does not recognise in with "nothing is
 * happening", and a second, quieter class exists nowhere in the model.
 */
function loudness(row: ShellRow): number {
  if (row.state === undefined) return URGENCY.idle;
  return URGENCY[row.state] ?? URGENCY.idle;
}

export function capRows(shells: readonly ShellRow[], expanded: boolean): readonly CappedRow[] {
  if (shells.length <= SHELL_ROW_CAP) return [...shells];

  /*
   * Expanded shows all of them in CREATION order, plus the way back.
   *
   * It deliberately does not promote: a full list has no room problem to solve,
   * and one that reshuffled itself as agents finished would be unreadable — the
   * row you were reaching for would move under the cursor. Without the `less`
   * row the expansion is also one-way, and a rail you can only make taller ends
   * up all one region.
   */
  if (expanded) return [...shells, { kind: 'less' }];

  const shown = shells
    .map((row, index) => ({ row, index }))
    .sort((a, b) => loudness(a.row) - loudness(b.row) || a.index - b.index)
    .slice(0, SHELL_ROW_CAP - 1)
    .map((entry) => entry.row);

  return [...shown, { kind: 'more', count: shells.length - shown.length }];
}
