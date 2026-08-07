import {
  disposeAll,
  paneId as toPaneId,
  rootId as toRootId,
  s,
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
} as const;

export function registerLayoutCommands(options: LayoutCommandsOptions): Disposable {
  const { store, registry, onLastPaneClosed } = options;

  /** The root a command acts on: the named one, else the only one there is. */
  const resolveRoot = (root: string | undefined): RootID | undefined => {
    if (root !== undefined) return toRootId(root);
    const roots = store.roots();
    return roots.length === 1 ? roots[0] : undefined;
  };

  const resolvePane = (pane: string | undefined, root: RootID | undefined): PaneID | null => {
    if (pane !== undefined) return toPaneId(pane);
    return root === undefined ? null : store.focused(root);
  };

  const subscriptions: Disposable[] = [
    registry.register(LAYOUT_COMMANDS.split, {
      title: 'Split Pane',
      permission: 'layout',
      schema: s.object({ axis: AXIS, root: s.optional(s.string()), cwd: s.optional(s.string()) }),
      handler: (args) => {
        const root = resolveRoot(args.root);
        if (root === undefined) return unwrap(errNoRoot(args.root));
        return unwrap(store.split(root, args.axis, args.cwd === undefined ? {} : { cwd: args.cwd }));
      },
    }),

    registry.register(LAYOUT_COMMANDS.focusDirection, {
      title: 'Focus Pane in Direction',
      permission: 'layout',
      schema: s.object({ direction: DIRECTION, root: s.optional(s.string()) }),
      handler: (args) => {
        const root = resolveRoot(args.root);
        if (root === undefined) return unwrap(errNoRoot(args.root));
        // `null` = the edge of the layout. A legitimate answer, not a failure.
        return { focused: unwrap(store.focusDirection(root, args.direction)) };
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
        const root = resolveRoot(args.root);
        const pane = resolvePane(args.pane, root);
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
        const root = resolveRoot(args.root);
        if (root === undefined) return unwrap(errNoRoot(args.root));
        unwrap(store.setRatio(root, args.path, args.ratio));
        return { ok: true };
      },
    }),

    registry.register(LAYOUT_COMMANDS.zoom, {
      title: 'Toggle Zoom',
      permission: 'layout',
      schema: s.object({ pane: s.optional(s.string()), root: s.optional(s.string()) }),
      handler: (args) => {
        const root = resolveRoot(args.root);
        const pane = resolvePane(args.pane, root);
        unwrap(store.zoom(pane, root));
        return { zoomed: root === undefined ? null : store.zoomed(root) };
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
  return {
    ok: false,
    error:
      named === undefined
        ? 'no root given and there is not exactly one open — name it explicitly'
        : `no root ${named}`,
  };
}
