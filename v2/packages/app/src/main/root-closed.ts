import type { RootID } from '@shepherd/sdk';

/**
 * What running a root out of panes MEANS — as a value, decided in one place.
 *
 * It is three lines, and it is extracted anyway, because those three lines are
 * the sharpest correctness edge tabs introduced. `tasks` archives a task when it
 * hears that the task's pane group closed; with several roots per task, a
 * consumer told only the ROOT id would archive a task the moment its first tab
 * emptied — while another tab sat there with a live agent in it. That failure is
 * invisible in the app until you have lost work, and it cannot be unit-tested at
 * all while the decision lives inside main's Electron wiring.
 *
 * Pure and total: no store, no bus, no window. The caller supplies what the
 * layout says and applies what this returns.
 */

export interface RootClosedInput {
  /** The root that just ran out of panes. */
  readonly root: RootID;
  /** Its group — the caller reads this BEFORE removing the root. */
  readonly group: string;
  /** Every root of that group, the removed one included. */
  readonly groupRoots: readonly RootID[];
  /** What the window falls back to when the group is finished. */
  readonly homeRoot: RootID;
}

export interface RootClosedFallout {
  /**
   * Where the window goes: a SIBLING TAB first, home only when there is none.
   *
   * A window drawing a root that no longer exists draws nothing at all, so it
   * always goes somewhere — but closing one tab of a task must not throw you out
   * of the task when the other tab is right there.
   */
  readonly nextRoot: RootID;
  /** The announcement's payload, verbatim. */
  readonly announcement: {
    readonly root: string;
    readonly group: string;
    /**
     * Whether that was the group's LAST root — i.e. whether the thing the group
     * stands for is finished with, rather than merely one tab of it.
     */
    readonly groupEmpty: boolean;
  };
}

export function rootClosedFallout(input: RootClosedInput): RootClosedFallout {
  const siblings = input.groupRoots.filter((candidate) => candidate !== input.root);
  return {
    nextRoot: siblings[0] ?? input.homeRoot,
    announcement: {
      root: String(input.root),
      group: input.group,
      groupEmpty: siblings.length === 0,
    },
  };
}
