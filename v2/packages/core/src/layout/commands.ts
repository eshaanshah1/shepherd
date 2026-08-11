import {
  disposeAll,
  paneId as toPaneId,
  rootId as toRootId,
  s,
  sessionId as toSessionId,
  type Disposable,
  type PaneID,
  type RootID,
} from '@shepherd/sdk';
import type { CommandRegistry } from '../commands/registry.ts';
import type { LayoutStore } from './store.ts';

/**
 * Every layout mutation, as commands.
 *
 * This file is the reason ⌘D, a palette entry, `shepherd pane split`, and an
 * extension all mean the same thing: they are four transports into these
 * handlers. Nothing else may mutate the store — a second path is how v1 ended up
 * with three implementations of "and now fix up the focus" that disagreed.
 *
 * Two conventions the whole table follows:
 *
 *   - **`pane` is optional and defaults to the focused pane.** A keystroke means
 *     "the pane I am looking at"; a CLI or an extension names one. Both arrive
 *     here as the same call.
 *   - **`root` is optional and defaults to the ACTIVE root.** Same reason, one
 *     level up: a keystroke means "the root I am looking at", and the shell is
 *     what knows which that is. It used to mean "the only root there is", which
 *     was true right up until a second root existed and then made every menu
 *     gesture fail — ⌘D and ⌘W deliberately send no `root`.
 *   - **A no-op is a value, not an error.** ⌘⌥← at the left edge, or un-zooming
 *     when nothing is zoomed, returns a result saying nothing moved. Reporting a
 *     failure would make the CLI print an error for a gesture that behaved
 *     exactly as intended.
 */

export interface LayoutCommandsOptions {
  readonly store: LayoutStore;
  readonly registry: CommandRegistry;
  /**
   * What to do when the last pane of a root closes. Core does not know what a
   * window is; the shell does, and passing it in keeps ⌘W's fall-through in one
   * place instead of every caller re-deciding.
   */
  readonly onLastPaneClosed: (root: RootID) => void;
  /**
   * Which root an unqualified gesture means. A getter, not a value: the shell
   * changes it whenever the user switches, and a snapshot taken at registration
   * would pin every menu command to whatever was active when the app started.
   */
  readonly activeRoot: () => RootID;
  /**
   * The root the window falls back to — the one that always exists. Closing it
   * is refused (there would be nothing left to show), and closing any other
   * root lands here.
   */
  readonly homeRoot: RootID;
  /**
   * Make a root the active one. The shell owns what "active" means (which
   * snapshot the window draws, whose panes count as being looked at), so core
   * validates the request and hands it over rather than deciding.
   */
  readonly onSwitchRoot: (root: RootID) => void;
}

const AXIS = s.enumOf(['row', 'column'] as const);
const DIRECTION = s.enumOf(['left', 'right', 'up', 'down'] as const);

/** `row` = ⌘D = panes SIDE BY SIDE. `column` = ⌘⇧D = stacked. Read it here. */
export const LAYOUT_COMMANDS = {
  split: 'layout.split',
  focusDirection: 'layout.focusDirection',
  focusPane: 'layout.focusPane',
  close: 'layout.close',
  setRatio: 'layout.setRatio',
  zoom: 'layout.zoom',
  rename: 'layout.rename',
  switchRoot: 'layout.switchRoot',
  openRoot: 'layout.openRoot',
  closeRoot: 'layout.closeRoot',
} as const;

export function registerLayoutCommands(options: LayoutCommandsOptions): Disposable {
  const { store, registry, onLastPaneClosed, activeRoot, homeRoot, onSwitchRoot } = options;

  /**
   * The root a command acts on: the named one, else the one being looked at.
   *
   * Always answers with a root — a NAME, which may still be a root that does
   * not exist. That check belongs to the store (`no root <id>`), so a typo from
   * the CLI and a stale id from an extension produce the same one message
   * rather than two half-answers written in two places.
   */
  const resolveRoot = (root: string | undefined): RootID =>
    root === undefined ? activeRoot() : toRootId(root);

  const resolvePane = (pane: string | undefined, root: RootID): PaneID | null =>
    pane === undefined ? store.focused(root) : toPaneId(pane);

  const subscriptions: Disposable[] = [
    registry.register(LAYOUT_COMMANDS.split, {
      title: 'Split Pane',
      permission: 'layout',
      schema: s.object({
        axis: AXIS,
        root: s.optional(s.string()),
        cwd: s.optional(s.string()),
        /**
         * One line typed into the new pane's pty, once, when its session starts.
         *
         * `Pane` has carried this since M0 and nothing set it: it is how a
         * caller opens a pane that is already doing something — `tasks.spawn`
         * starting an agent in a worktree is the first. Transient by
         * construction (`serialize.ts` drops it), so a relaunch restores a pane,
         * never a command.
         *
         * It is **one line**. A newline is an Enter press, so a multi-line
         * prompt typed here would submit its first line and scatter the rest
         * into whatever is running next — v1's lesson, and the reason `tasks`
         * spills a prompt to a file and types a command that reads it back.
         */
        initialCommand: s.optional(s.string()),
      }),
      handler: (args) => {
        return unwrap(
          store.split(resolveRoot(args.root), args.axis, {
            ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
            ...(args.initialCommand === undefined ? {} : { initialCommand: args.initialCommand }),
          }),
        );
      },
    }),

    registry.register(LAYOUT_COMMANDS.focusDirection, {
      title: 'Focus Pane in Direction',
      permission: 'layout',
      schema: s.object({ direction: DIRECTION, root: s.optional(s.string()) }),
      handler: (args) => {
        // `null` = the edge of the layout. A legitimate answer, not a failure.
        return { focused: unwrap(store.focusDirection(resolveRoot(args.root), args.direction)) };
      },
    }),

    registry.register(LAYOUT_COMMANDS.focusPane, {
      title: 'Focus Pane',
      permission: 'layout',
      schema: s.object({ pane: s.string() }),
      handler: (args) => {
        unwrap(store.focusPane(toPaneId(args.pane)));
        return { focused: args.pane };
      },
    }),

    registry.register(LAYOUT_COMMANDS.close, {
      title: 'Close Pane',
      permission: 'layout',
      schema: s.object({ pane: s.optional(s.string()), root: s.optional(s.string()) }),
      handler: (args) => {
        const pane = resolvePane(args.pane, resolveRoot(args.root));
        if (pane === null) return unwrap(errNoRoot(args.root));

        const owning = store.rootOf(pane);
        const outcome = unwrap(store.close(pane));
        // The fall-through, in exactly one place: only the LAST pane reaches the
        // window. Any other pane closing a window is the classic Electron bug
        // where a split disappears because one of its panes was closed.
        if (outcome.wasLastPane && owning !== undefined) onLastPaneClosed(owning);
        return outcome;
      },
    }),

    registry.register(LAYOUT_COMMANDS.setRatio, {
      title: 'Resize Split',
      permission: 'layout',
      schema: s.object({ path: s.array(s.int()), ratio: s.number(), root: s.optional(s.string()) }),
      handler: (args) => {
        unwrap(store.setRatio(resolveRoot(args.root), args.path, args.ratio));
        return { ok: true };
      },
    }),

    registry.register(LAYOUT_COMMANDS.zoom, {
      title: 'Toggle Zoom',
      permission: 'layout',
      schema: s.object({ pane: s.optional(s.string()), root: s.optional(s.string()) }),
      handler: (args) => {
        const root = resolveRoot(args.root);
        unwrap(store.zoom(resolvePane(args.pane, root), root));
        return { zoomed: store.zoomed(root) };
      },
    }),

    registry.register(LAYOUT_COMMANDS.rename, {
      title: 'Rename Pane',
      permission: 'layout',
      schema: s.object({ pane: s.string(), title: s.union(s.string(), s.literal(null as unknown as string)) }),
      handler: (args) => {
        unwrap(store.rename(toPaneId(args.pane), args.title));
        return { ok: true };
      },
    }),

    /**
     * The three root-level verbs.
     *
     * A root is a pane group the window shows one of at a time — v1's workspace,
     * and what a task will own one of. They are commands for the same reason
     * every other mutation here is: the sidebar, the CLI and the `tasks`
     * extension all switch roots, and three implementations of "and now fix up
     * the focus and the presence" is exactly what this file exists to prevent.
     */
    registry.register(LAYOUT_COMMANDS.switchRoot, {
      title: 'Switch Root',
      permission: 'layout',
      schema: s.object({ root: s.string() }),
      handler: (args) => {
        const root = toRootId(args.root);
        // Named explicitly rather than left to the shell: switching to a root
        // that does not exist would leave the window drawing nothing, with the
        // failure visible only as a blank stage.
        //
        // `hasRoot`, not `tree(root) === undefined`, since a root may hold no
        // panes: the old spelling answered both questions with one value and now
        // refuses to switch to an EMPTY root, reporting "no root" about one that
        // is open and on which the window draws the empty state.
        if (!store.hasRoot(root)) return unwrap(errNoRoot(args.root));
        onSwitchRoot(root);
        return { root: args.root };
      },
    }),

    registry.register(LAYOUT_COMMANDS.openRoot, {
      title: 'Open Root',
      permission: 'layout',
      schema: s.object({
        root: s.string(),
        cwd: s.optional(s.string()),
        /** One line, typed once into the new root's pane. `layout.split` documents why. */
        initialCommand: s.optional(s.string()),
        title: s.optional(s.string()),
        /**
         * A session this root's pane should SHOW rather than start.
         *
         * The caller is another member's terminal: that pty is already running on
         * another machine, so the pane must be born already bound or the renderer
         * — which decides to create by looking for a binding in the snapshot —
         * starts a local shell in it first. See `PaneSeed.session`; the binding is
         * applied before the pane is announced, which is the whole point.
         *
         * Never `initialCommand`'s companion: one types into a session this pane
         * created, the other adopts one it did not.
         */
        session: s.optional(s.string()),
      }),
      handler: (args) => {
        const root = toRootId(args.root);
        /**
         * "Exists" means LIVE, not persisted.
         *
         * `store.open` restores a persisted root, which would report `created`
         * here for something the user had before — but the shell opens every
         * persisted root at launch, so by the time anything invokes this, a root
         * on disk is a root in the map.
         *
         * The check is **"has a pane"**, not "is in the map", and the difference
         * arrived with paneless roots. `openRoot` means "there is a root here
         * with something in it" — that is what every caller does with the answer
         * — so a root that exists and is EMPTY is one this verb still has work
         * to do on. Left as an existence check, the home root could be emptied
         * and never filled again: `openRoot` would report `created: false` with
         * `pane: null` forever, and the empty state would be a dead end for
         * every caller that is not the ⌘T composer.
         *
         * Filling one goes through `store.split`, which mints the first pane of
         * an empty root (see its own note) — so there is one mint path and not a
         * second one here that could shape a pane differently.
         */
        if (store.panes(root).length > 0) {
          return { root: args.root, pane: store.focused(root), created: false };
        }

        const init = {
          ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
          ...(args.initialCommand === undefined ? {} : { initialCommand: args.initialCommand }),
          ...(args.session === undefined ? {} : { session: toSessionId(args.session) }),
          // A title given here is the USER's name for the pane, not an OSC one:
          // the caller is naming the thing it just made, and a program's own
          // title must still be able to lose to it.
          ...(args.title === undefined ? {} : { userTitle: args.title }),
        };

        if (store.hasRoot(root)) {
          unwrap(store.split(root, 'row', init));
          return { root: args.root, pane: store.focused(root), created: true };
        }

        store.open(args.root, init);
        return { root: args.root, pane: store.focused(root), created: true };
      },
    }),

    registry.register(LAYOUT_COMMANDS.closeRoot, {
      title: 'Close Root',
      permission: 'layout',
      schema: s.object({ root: s.string() }),
      handler: (args) => {
        const root = toRootId(args.root);
        // `hasRoot`: an emptied root is still a root, and still closable.
        if (!store.hasRoot(root)) return unwrap(errNoRoot(args.root));
        // The home root is what everything falls back to. Closing it would
        // leave the window with no root to draw and no root to switch to.
        if (root === homeRoot) return unwrap(fail(`${args.root} is the home root and cannot be closed`));

        /**
         * Every pane goes through `store.close`, which is the ONE terminator
         * (ADR 0022) — that is what kills the ptys behind them. `removeRoot`
         * deliberately kills nothing, so dropping the root without draining it
         * would leak a live session per pane with nothing left pointing at it.
         *
         * `store.close` directly, not the `layout.close` command: the command
         * fires `onLastPaneClosed`, and having the shell react to the last pane
         * of a root we are already tearing down would race this handler.
         */
        const panes = store.panes(root);
        for (const pane of panes) unwrap(store.close(pane));
        unwrap(store.removeRoot(root));
        // A window showing a root that no longer exists draws nothing at all.
        if (activeRoot() === root) onSwitchRoot(homeRoot);
        return { root: args.root, closedPanes: panes.length };
      },
    }),
  ];

  return { dispose: () => disposeAll(subscriptions) };
}

/**
 * Store failures are `Result`s; a command handler reports failure by throwing,
 * which the registry turns into a typed `handler-failed` with the message intact.
 * So this is the one adapter between the two conventions, in one place rather
 * than seven copies of the same `if (!result.ok)`.
 */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (result.ok) return result.value;
  throw new Error(result.error);
}

function errNoRoot(named: string | undefined): { ok: false; error: string } {
  return fail(named === undefined ? 'the active root has no panes' : `no root ${named}`);
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}
