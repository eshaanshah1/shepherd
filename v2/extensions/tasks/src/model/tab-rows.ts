import { ROLLUP_PRIORITY, type TaskAgentState } from './agent-rollup.ts';

/**
 * A task's tabs → the rows its sidebar entry shows.
 *
 * **Capped**, and the cap is why this is a function rather than a `.map`. A task
 * with eight tabs would push every other task off the screen, and the sidebar's
 * job is the list of TASKS. Past the cap it shows some of them and says how many
 * it is not showing, which is a count you can act on rather than a list you have
 * to scroll.
 *
 * **The ones it shows are the ones that WANT YOU.** An agent that has finished
 * its turn, a shell command that completed while you were looking somewhere
 * else: those are the rows worth having, and a cap that kept tab 1 and tab 2
 * would hide exactly what the sidebar exists to surface. Ranked by
 * `ROLLUP_PRIORITY`, with creation order as the tie-break so a quiet task still
 * reads top to bottom and only a loud one reorders.
 *
 * **Drawn identically for one tab.** The shape of a task's entry does not change
 * as tabs are added — one tab is one row, not a special case that grows into a
 * list later.
 *
 * Pure and total, the same shape as `agent-rollup.ts` beside it: no layout, no
 * store, no running app.
 */

/** Three rows under a task, the overflow row included when there is one. */
export const TAB_ROW_CAP = 3;

export interface TabRow {
  readonly root: string;
  readonly label: string;
  /**
   * The rollup over the panes in THIS root — the state itself, not the tint it
   * is drawn as. Ranking on the state keeps this file from having to know how a
   * state is spelled for the renderer (`needsCheck` → `needs-check`), which is
   * `tintFor`'s business and changes on its own schedule.
   */
  readonly state: TaskAgentState;
}

/** The overflow row, and the way back from it. */
export type CappedRow =
  | TabRow
  | { readonly kind: 'more'; readonly count: number }
  | { readonly kind: 'less' };

export function capTabRows(tabs: readonly TabRow[], expanded: boolean): readonly CappedRow[] {
  if (tabs.length <= TAB_ROW_CAP) return [...tabs];

  /*
   * Expanded shows all of them, in CREATION order, plus the way back.
   *
   * It deliberately does not promote: a full list has no room problem to solve,
   * and one that reshuffled itself as agents finished would be unreadable — the
   * row you were reaching for would move under the cursor. Without the `less`
   * row the expansion would also be one-way, and a sidebar you can only make
   * taller ends up all one task.
   */
  if (expanded) return [...tabs, { kind: 'less' }];

  /*
   * An unrecognised state ranks AS `idle`, not below it.
   *
   * These words crossed a port from an extension this code has never seen, and
   * `rollUp` already folds anything it does not recognise into `idle` — "no
   * agent" and "a word I do not know" being the same grey case. Ranking them
   * below idle instead would be a second, quieter class that exists nowhere in
   * the model.
   */
  const quiet = ROLLUP_PRIORITY.indexOf('idle');
  const loudness = (row: TabRow): number => {
    const rank = ROLLUP_PRIORITY.indexOf(row.state);
    return rank === -1 ? quiet : rank;
  };

  const shown = tabs
    .map((row, index) => ({ row, index }))
    .sort((a, b) => loudness(a.row) - loudness(b.row) || a.index - b.index)
    .slice(0, TAB_ROW_CAP - 1)
    .map((entry) => entry.row);

  return [...shown, { kind: 'more', count: tabs.length - shown.length }];
}
