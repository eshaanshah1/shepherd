import type { PaneAction, PaneID, PaneView } from '@shepherd/sdk';
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
 * The cut between the fields is what SURVIVES A RELAUNCH, not what is useful:
 * `userTitle` and `cwd` persist because a person chose them; `title`,
 * `initialCommand`, `icon` and `actions` do not, because a running thing
 * produced them and will produce them again. `serialize.ts` is where that is
 * enforced, and it is enforced by a separate DTO rather than by anyone
 * remembering.
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
  /**
   * This pane shows a captured screen and NEVER gets a session.
   *
   * The one case where a pane with no session binding is correct rather than a
   * failure: an archived task's tabs are rendered from what was on screen when
   * it was shelved, and provisioning a worktree to look at old work is the cost
   * this exists to avoid. Persisted, unlike the two live fields above — a
   * snapshot is not work in flight, it is what the pane *is*.
   */
  readonly readOnly: boolean;
  /**
   * Where the bytes it replays live. Absolute, and read by MAIN, not here.
   *
   * A path and nothing more: the kernel does not learn that these came from an
   * archive, or that a task exists. Whoever wrote the file named it.
   */
  readonly snapshotFile: string | null;
  /**
   * This pane shows a contributed VIEW rather than a terminal, and so never
   * gets a session either (ADR 0044).
   *
   * The second pane that is not a pty, after `readOnly` — and deliberately a
   * separate field rather than a widening of it, because the two are absent for
   * opposite reasons. A read-only pane HAD a session and is replaying what it
   * printed; a view pane never had one and never will. Folding them into one
   * flag would make "no session" mean two things, and the renderer would then
   * need a second field to tell them apart, which is this one.
   *
   * Persisted, like `readOnly` and unlike `initialCommand`: a review tab is a
   * place the user put something, not work in flight, so a relaunch owes them
   * the tab back. What it does NOT owe them is the view's contents — `state`
   * names a subject and the view re-reads it, so a stale PR is re-fetched rather
   * than restored.
   *
   * The kernel does not resolve `type` and must not: the renderer matches it
   * against the contributions an extension registered, so a pane whose extension
   * is not loaded yet draws the empty slot and fills in when it is. That is also
   * what keeps this field from being a component name — see `PaneView`.
   */
  readonly view: PaneView | null;
  /**
   * The glyph this pane is currently wearing, by NAME, or `null` for whatever its
   * view type declared.
   *
   * A view type's `icon` is one glyph for every pane of that type, which is right
   * for a pull request and wrong for a scratch pane: the same view is a notepad or
   * a skill depending on what is written in it. So a pane may override it, and the
   * renderer prefers this over the contribution's.
   *
   * **Live, never persisted** (`serialize.ts`), and that is the same cut `title`
   * is on: a value derived from a running thing's contents, which the thing
   * re-publishes when it mounts. `userTitle` persists because a person typed it.
   *
   * A NAME rather than anything drawable, for ADR 0033's reason: it resolves
   * through the renderer's own allow-list, so a pane cannot reach the page with a
   * glyph the build never saw.
   */
  readonly icon: string | null;
  /**
   * What this pane is offering right now, drawn at the trailing edge of the tab
   * strip when it is the focused one.
   *
   * Live and never persisted, more strongly than `icon` is: an action names a
   * command, and a command exists only while the extension that registered it is
   * active. A restored action would draw a button that invokes nothing.
   *
   * Empty is the resting state, and the common one — a terminal offers nothing.
   */
  readonly actions: readonly PaneAction[];
}

export interface PaneInit {
  id?: PaneID;
  title?: string;
  userTitle?: string | null;
  cwd?: string | null;
  initialCommand?: string | null;
  readOnly?: boolean;
  snapshotFile?: string | null;
  view?: PaneView | null;
  icon?: string | null;
  actions?: readonly PaneAction[];
}

export function makePane(init: PaneInit = {}, random?: RandomId): Pane {
  return {
    id: init.id ?? newPaneId(random),
    title: init.title ?? '',
    userTitle: init.userTitle ?? null,
    cwd: init.cwd ?? null,
    initialCommand: init.initialCommand ?? null,
    readOnly: init.readOnly ?? false,
    snapshotFile: init.snapshotFile ?? null,
    view: init.view ?? null,
    icon: init.icon ?? null,
    actions: init.actions ?? [],
  };
}

/** What a pane with nothing to say for itself is called. */
export const DEFAULT_PANE_TITLE = 'term';

/**
 * What the sidebar and the tab strip show: the user's name, else the program's
 * own title, else `term`.
 *
 * **The cwd is deliberately not in this chain**, and it used to be its last
 * link. A label that is a path says where you are and says what is running
 * nowhere; the sidebar row already names the task, whose name is where you are.
 * (The pane head used to print the directory beside the name — that bar is gone
 * now, and the cwd with it.) A shell's own idle title
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
