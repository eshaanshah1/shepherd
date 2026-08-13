import type { PaneID } from '@shepherd/sdk';
import { newPaneId, type RandomId } from '../identity.ts';

/**
 * A leaf of the layout tree — one terminal view, one session.
 *
 * Deliberately narrow. v1's `Pane` accumulated agent state, a stowing kind, a
 * provisioning flag and a remote ref, and every one of them was a field the
 * persistence layer then had to remember NOT to write. Here the rule is
 * structural: **a pane carries what the layout needs and what survives a
 * relaunch, and nothing else.** Anything an extension owns (agent state,
 * attention, tasks) hangs off the pane id in that extension's own store — which
 * is the whole point of M1's registry and is why the field never comes back.
 *
 * Of the four fields, two persist (`userTitle`, `cwd`) and two do not:
 * `title` is whatever the running program set by OSC, and `initialCommand` is
 * typed into the pty once on mount. `serialize.ts` is where that is enforced.
 */
export interface Pane {
  readonly id: PaneID;
  /** The OSC title the running program set. Live only — never persisted. */
  readonly title: string;
  /** A name the user typed. Beats the OSC title. Persisted. */
  readonly userTitle: string | null;
  /** Last-known working directory. Persisted — a restored pane opens here. */
  readonly cwd: string | null;
  /** Typed into the pty once on mount. Transient; never persisted. */
  readonly initialCommand: string | null;
}

export interface PaneInit {
  id?: PaneID;
  title?: string;
  userTitle?: string | null;
  cwd?: string | null;
  initialCommand?: string | null;
}

export function makePane(init: PaneInit = {}, random?: RandomId): Pane {
  return {
    id: init.id ?? newPaneId(random),
    title: init.title ?? '',
    userTitle: init.userTitle ?? null,
    cwd: init.cwd ?? null,
    initialCommand: init.initialCommand ?? null,
  };
}

/** What a pane with nothing to say for itself is called. */
export const DEFAULT_PANE_TITLE = 'term';

/**
 * What the sidebar and the tab strip show: the user's name, else the program's
 * own title, else `term`.
 *
 * **The cwd is deliberately not in this chain**, and it used to be its last
 * link. It is drawn *beside* the name now rather than as it, because a label
 * that is a path says where you are twice — the pane head already prints the
 * directory — and says what is running nowhere. A shell's own idle title
 * (`%n@%m:%~`) is dropped one layer down for the same reason, in
 * `isShellPromptTitle`, which is what leaves a plain shell landing here.
 *
 * It took no `home` argument in the end. Three of its four callers were already
 * passing `''`, which is what said the cwd did not belong here.
 */
export function displayTitle(pane: Pane): string {
  if (pane.userTitle !== null && pane.userTitle !== '') return pane.userTitle;
  if (pane.title !== '') return pane.title;
  return DEFAULT_PANE_TITLE;
}
