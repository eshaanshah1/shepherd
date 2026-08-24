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
import { displayTitle } from './pane.ts';
import { panes as panesOf } from './tree.ts';
import { serializeNode, type PersistedNode } from './serialize.ts';
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

/**
 * A contributed view, as a caller asks for one (ADR 0044).
 *
 * Declared once and shared by `split` and `newTab` for `PLACEHOLDER`'s reason:
 * the two are the same fact arriving by two gestures, and a caller writing
 * against one must not find the other's shape different.
 *
 * `state` is `s.unknown()` and that is the point rather than a gap — it belongs
 * to whichever extension registered `type`, and a kernel that validated it
 * would have to know what a pull request is. The view is what checks it, on the
 * far side of a port that already delivers `unknown`.
 */
const VIEW = s.object({ type: s.string(), state: s.optional(s.unknown()) });

/**
 * What an empty root says about itself — see `RootPlaceholder`.
 *
 * Declared once and used by both `openRoot` and `setPlaceholder`, because those
 * two are the same fact arriving at two moments (at the mint, and again as the
 * work moves) and a caller writing against one must not find the other's shape
 * different.
 */
const PLACEHOLDER = s.object({
  line: s.string(),
  names: s.optional(s.array(s.string())),
  /** The one verb the shell offers with it. `RootPlaceholder.action` documents it. */
  action: s.optional(s.object({ command: s.string(), label: s.string(), args: s.optional(s.unknown()) })),
});

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
  setPlaceholder: 'layout.setPlaceholder',
  closeRoot: 'layout.closeRoot',
  newTab: 'layout.newTab',
  closeGroup: 'layout.closeGroup',
  listRoots: 'layout.listRoots',
  seedPane: 'layout.seedPane',
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

  /**
   * Hand a freshly minted pane the screen it should be born showing.
   *
   * Decoded HERE rather than at the store: base64 is a property of the envelope
   * a command arrives in, and the store's seam takes bytes.
   */
  const stageSeed = (root: RootID, seed: string | undefined): void => {
    if (seed === undefined || seed === '') return;
    const pane = store.focused(root);
    if (pane === null) return;
    store.setInitialSeed(pane, new Uint8Array(Buffer.from(seed, 'base64')));
  };

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
        /** A captured screen, base64 — `layout.openRoot` documents it. */
        seed: s.optional(s.string()),
        /**
         * Open a contributed VIEW here instead of a terminal (ADR 0044).
         *
         * Exclusive with `initialCommand` in practice and not enforced to be:
         * a view pane never gets a session, so the command has nothing to be
         * typed into and is simply never read. Refusing the pair would be a
         * second rule to remember for a combination nobody writes on purpose.
         */
        view: s.optional(VIEW),
      }),
      handler: (args) => {
        const root = resolveRoot(args.root);
        const pane = unwrap(
          store.split(root, args.axis, {
            ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
            ...(args.initialCommand === undefined ? {} : { initialCommand: args.initialCommand }),
            ...(args.view === undefined ? {} : { view: args.view }),
          }),
        );
        stageSeed(root, args.seed);
        return pane;
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

    /**
     * The pane's label, its glyph and what it currently offers.
     *
     * The verb is now wider than its name, and that is a deliberate trade rather
     * than an oversight. A pane reporting on itself does all three in one write
     * (`store.rename` says why a sibling `setIcon` would tear), and renaming this
     * to `layout.present` is a migration across a palette entry, a keybinding and
     * a CLI verb — worth doing, and not worth doing inside a feature.
     *
     * `icon` and `actions` are OPTIONAL and absent means leave alone, so ⌘⇧R's
     * title-only call cannot wipe a glyph it knows nothing about.
     */
    registry.register(LAYOUT_COMMANDS.rename, {
      title: 'Rename Pane',
      permission: 'layout',
      schema: s.object({
        pane: s.string(),
        title: s.union(s.string(), s.literal(null as unknown as string)),
        icon: s.optional(s.union(s.string(), s.literal(null as unknown as string))),
        actions: s.optional(
          s.array(
            s.object({
              id: s.string(),
              label: s.string(),
              glyph: s.string(),
            }),
          ),
        ),
      }),
      handler: (args) => {
        unwrap(
          store.rename(toPaneId(args.pane), args.title, {
            ...(args.icon === undefined ? {} : { icon: args.icon }),
            ...(args.actions === undefined ? {} : { actions: args.actions }),
          }),
        );
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
        /**
         * The pane group this root is a tab of. Defaults to the root's own id.
         *
         * Applies to the MINT only, like every other field here: a root that
         * already exists belongs to whatever group it was opened in, and this
         * verb being idempotent is precisely why it must not re-decide that —
         * the second caller would move a root out from under the first.
         */
        group: s.optional(s.string()),
        /**
         * A previously captured screen, base64, put into this pane's session
         * before its pty says anything — a restored tab's history.
         *
         * Base64 because it arrives through a command envelope, which is JSON.
         * One-shot and never persisted, exactly like `initialCommand`: a pane
         * whose session dies and is replaced must not replay a screen from
         * before the task was shelved.
         */
        seed: s.optional(s.string()),
        /**
         * Mint it with NO PANE, and say why it is empty.
         *
         * For a caller that wants the root to EXIST — so the window can be
         * switched to it and the sidebar row can highlight — while what belongs
         * in it is still being built. Without this the only way to make a root
         * was to put a shell in it, and a shell nobody asked for is one that
         * outlives the wait: whatever fills the root later finds a pane already
         * there and splits beside it.
         *
         * `created` is **always false** here, and that is the honest answer
         * rather than a quirk: it reports whether this call put a PANE in the
         * root, every caller branches on it to decide whether it still has to,
         * and this call never does. The root itself is created if it was
         * missing, idempotently, exactly as the ordinary path is.
         *
         * `cwd`, `initialCommand`, `title` and `session` shape a pane, so they
         * are ignored here for the reason `OpenOptions.empty` documents: there
         * is no pane to shape, and failing instead would break a caller that
         * simply stopped needing a first pane.
         */
        empty: s.optional(s.boolean()),
        /** The line an empty root shows. `layout.setPlaceholder` documents it. */
        placeholder: s.optional(PLACEHOLDER),
        /**
         * The shape to mint this root with, in `serialize.ts`'s own vocabulary —
         * what `layout.listRoots` hands out as `tree`.
         *
         * `s.unknown()` rather than a schema of its own: `deserializeNode` is
         * already the validator for this format, and a second one here is a
         * second thing to keep in step with it. It runs inside `store.open`.
         *
         * Ignored when the root already has panes, like every other
         * pane-shaping argument on this verb.
         */
        tree: s.optional(s.unknown()),
        /**
         * Mint the pane showing a FILE rather than a session (`Pane.readOnly`).
         *
         * For the flat fallback alone — a caller with a `tree` puts these on the
         * leaves. Without it, a tab archived before shapes were stored would
         * come back as a live shell in a directory the archive deleted.
         */
        readOnly: s.optional(s.boolean()),
        snapshotFile: s.optional(s.string()),
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

        /*
         * The paneless mint, BEFORE the seeding paths below — this is the branch
         * that must not fall through to them, since every one of them ends in a
         * pane. `store.open` is idempotent, so a root that is already here and
         * already empty is returned untouched and only its line is refreshed.
         */
        if (args.empty === true) {
          store.open(args.root, undefined, {
            empty: true,
            ...(args.group === undefined ? {} : { group: args.group }),
          });
          if (args.placeholder !== undefined) unwrap(store.setPlaceholder(root, args.placeholder));
          return { root: args.root, pane: null, created: false };
        }

        const init = {
          ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
          ...(args.initialCommand === undefined ? {} : { initialCommand: args.initialCommand }),
          ...(args.session === undefined ? {} : { session: toSessionId(args.session) }),
          ...(args.readOnly === undefined ? {} : { readOnly: args.readOnly }),
          ...(args.snapshotFile === undefined ? {} : { snapshotFile: args.snapshotFile }),
          // A title given here is the USER's name for the pane, not an OSC one:
          // the caller is naming the thing it just made, and a program's own
          // title must still be able to lose to it.
          ...(args.title === undefined ? {} : { userTitle: args.title }),
        };

        if (store.hasRoot(root)) {
          unwrap(store.split(root, 'row', init));
          stageSeed(root, args.seed);
          return { root: args.root, pane: store.focused(root), created: true };
        }

        store.open(args.root, init, {
          ...(args.group === undefined ? {} : { group: args.group }),
          ...(args.tree === undefined ? {} : { tree: args.tree as PersistedNode }),
        });
        stageSeed(root, args.seed);
        return { root: args.root, pane: store.focused(root), created: true };
      },
    }),

    registry.register(LAYOUT_COMMANDS.setPlaceholder, {
      title: 'Set Root Placeholder',
      permission: 'layout',
      schema: s.object({
        root: s.optional(s.string()),
        /** Absent stops the root saying anything, which is how a wait ENDS. */
        placeholder: s.optional(PLACEHOLDER),
      }),
      /**
       * Say why an empty root is empty, while it still is.
       *
       * A separate verb from `openRoot` rather than a field on it, because the
       * two answer different questions and only one of them repeats: `openRoot`
       * is idempotent and returns early for a root that exists, so a caller
       * updating its line every few seconds could not reach it through that door.
       *
       * **A root that is not open is a no-op, not a failure**, and `placed` is how
       * you tell the two apart. The caller is a slow job reporting its own
       * progress against a root that may not exist yet, may never exist, or may
       * have been filled while the message was in flight — none of which is
       * something it did wrong, and all of which the store answers `no root` to.
       * Left as a refusal, the ordinary case logged a dispatcher WARNING per
       * provisioning step: a task nobody clicked on produced a wall of failures
       * for work that succeeded. Measured in `smoke:m3`, which is the only place
       * it could have been seen.
       *
       * Not silence, though — `placed: false` is in the answer, so a caller with
       * a genuinely wrong root id can still find out, and a test can assert it.
       */
      handler: (args) => {
        const root = resolveRoot(args.root);
        if (!store.hasRoot(root)) return { root: String(root), placed: false };
        unwrap(store.setPlaceholder(root, args.placeholder));
        return { root: String(root), placed: true };
      },
    }),

    /**
     * The three GROUP verbs — a group being the set of roots the window shows
     * as tabs of one thing.
     *
     * They are commands for the reason everything else here is: `tasks`, the
     * tab strip, ⌘⇧T and the CLI all make tabs, and four implementations of
     * "and now switch to it" is what this file exists to prevent.
     */
    registry.register(LAYOUT_COMMANDS.newTab, {
      title: 'New Tab',
      permission: 'layout',
      schema: s.object({
        group: s.optional(s.string()),
        cwd: s.optional(s.string()),
        /** One line, typed once into the new tab's pane. `layout.split` documents why. */
        initialCommand: s.optional(s.string()),
        /** A contributed view instead of a terminal — `layout.split` documents it. */
        view: s.optional(VIEW),
        /**
         * What the tab strip calls it.
         *
         * A terminal tab needs no name here — it takes one from the program that
         * runs in it, by OSC. A view pane has no program, so without this every
         * contributed tab would be called `term`, and `userTitle` is the field
         * that already means "a name that beats the OSC title".
         */
        title: s.optional(s.string()),
      }),
      /**
       * Another tab of the group you are looking at.
       *
       * Both defaults are one idea a level apart: an unqualified gesture means
       * "here". The group defaults to the ACTIVE root's, and the cwd to the pane
       * you were looking at — which is what makes ⌘⇧T inside a task land in that
       * task's worktree without the kernel knowing what a worktree is.
       */
      handler: (args) => {
        const from = resolveRoot(undefined);
        const group = args.group ?? store.groupOf(from) ?? String(from);
        const focused = store.focused(from);
        const inherited = args.cwd ?? (focused === null ? undefined : (store.pane(focused)?.cwd ?? undefined));
        const root = unwrap(
          store.newTab(group, {
            ...(inherited === undefined || inherited === null ? {} : { cwd: inherited }),
            ...(args.initialCommand === undefined ? {} : { initialCommand: args.initialCommand }),
            ...(args.view === undefined ? {} : { view: args.view }),
            ...(args.title === undefined ? {} : { userTitle: args.title }),
          }),
        );
        // And LAND you in it. A tab you have to go and find is a tab the gesture
        // did not finish making.
        onSwitchRoot(root);
        return { root: String(root), pane: store.focused(root) };
      },
    }),

    registry.register(LAYOUT_COMMANDS.closeGroup, {
      title: 'Close Tab Group',
      permission: 'layout',
      schema: s.object({ group: s.string() }),
      /**
       * Every tab of a group, closed — what finishing with a task means.
       *
       * Each pane goes through `store.close`, which is the ONE terminator (ADR
       * 0022) and the only thing that ends a pty. Dropping the roots without
       * draining them would leak a live session per pane with nothing left
       * pointing at it.
       *
       * The home root is skipped rather than refused, for the reason
       * `closeRoot` refuses it outright: it is what everything falls back to.
       * Skipping rather than failing matters because the home root's group also
       * holds ordinary tabs, and a group whose first member cannot be closed
       * must not make the other members uncloseable.
       */
      handler: (args) => {
        const roots = store.rootsInGroup(args.group);
        if (roots.length === 0) return unwrap(fail(`no group ${args.group}`));
        let closedPanes = 0;
        let closedRoots = 0;
        for (const root of roots) {
          if (root === homeRoot) continue;
          for (const pane of store.panes(root)) {
            unwrap(store.close(pane));
            closedPanes += 1;
          }
          unwrap(store.removeRoot(root));
          closedRoots += 1;
        }
        // A window drawing a root that no longer exists draws nothing at all.
        if (!store.hasRoot(activeRoot())) onSwitchRoot(homeRoot);
        return { group: args.group, closedRoots, closedPanes };
      },
    }),

    registry.register(LAYOUT_COMMANDS.seedPane, {
      // No title: not a palette verb. Its whole effect is on a pane that has not
      // started yet.
      permission: 'layout',
      schema: s.object({
        pane: s.string(),
        seed: s.optional(s.string()),
        initialCommand: s.optional(s.string()),
      }),
      /**
       * Hand a pane that ALREADY EXISTS the screen and the line it should be born
       * with — the tree-shaped counterpart of `openRoot`'s `seed`.
       *
       * `openRoot` can seed one pane, the focused one, because that is the pane
       * it just minted. A tree-shaped open mints SEVERAL at once and there is no
       * moment at which each of them is the focused one, so a restore that
       * rebuilt a five-pane tab could seed exactly one of its panes.
       *
       * Both stagings are still one-shot at the store (`takeInitialSeed` /
       * `takeInitialInput`), so this adds a caller rather than a second
       * mechanism — and the "exactly one initial input per pane" invariant is
       * untouched.
       */
      handler: (args) => {
        const pane = toPaneId(args.pane);
        if (store.rootOf(pane) === undefined) throw new Error(`no pane ${args.pane}`);
        if (args.seed !== undefined && args.seed !== '') {
          store.setInitialSeed(pane, new Uint8Array(Buffer.from(args.seed, 'base64')));
        }
        if (args.initialCommand !== undefined && args.initialCommand !== '') {
          store.setInitialInput(pane, args.initialCommand);
        }
        return { pane: args.pane };
      },
    }),

    registry.register(LAYOUT_COMMANDS.listRoots, {
      // No title: not a palette verb. It is the read an extension makes because
      // `LayoutAPI`'s synchronous getters cannot cross a port.
      permission: 'layout',
      schema: s.object({ group: s.optional(s.string()) }),
      handler: (args) => {
        const roots = args.group === undefined ? store.roots() : store.rootsInGroup(args.group);
        return roots.map((root) => {
          const pane = store.focused(root);
          const found = pane === null ? null : store.pane(pane);
          const tree = store.tree(root);
          return {
            root: String(root),
            group: store.groupOf(root) ?? String(root),
            /*
             * ONE label, resolved HERE.
             *
             * `displayTitle` is what the sidebar and the tab strip both show —
             * its own doc comment says so — and resolving it in each consumer
             * instead is exactly the hand-synced pair this codebase keeps
             * getting bitten by. The home is empty because a caller that wants
             * `~` for it can say so; core does not read the environment.
             */
            label: found === null ? '' : displayTitle(found),
            /*
             * The focused pane's own glyph, beside its label and for the same
             * reason.
             *
             * `label` is resolved HERE because two consumers drawing it apart
             * would drift, and a glyph is the other half of that label — the rail
             * and the tab strip both draw a row for a root, and both need the
             * same answer. Whoever draws it resolves the NAME through their own
             * allow-list, which is what keeps this a string.
             *
             * `null` for a pane that publishes none, which is every terminal:
             * a glyph is what a pane falls back on when it has no state to
             * report, and a terminal always has one.
             */
            icon: found === null ? null : found.icon,
            focusedPane: pane === null ? null : String(pane),
            focusedSession: pane === null ? null : (store.sessionFor(pane) ?? null),
            /*
             * The split shape and every pane in it — what a caller needs to put
             * this root BACK.
             *
             * `serializeNode`'s own format, which is the one the layout will
             * rebuild from: handing out a second shape would be two descriptions
             * of one tree, and the restore would be reading whichever of them
             * had last been kept in step.
             */
            tree: tree === undefined ? null : serializeNode(tree, () => undefined),
            panes: (tree === undefined ? [] : panesOf(tree)).map((leafPane) => ({
              pane: String(leafPane.id),
              cwd: leafPane.cwd,
              userTitle: leafPane.userTitle,
              session: store.sessionFor(leafPane.id) ?? null,
              /*
               * …and what it was showing if that session has since EXITED.
               *
               * A separate field rather than a fallback inside `session`,
               * because the two answer different questions: `session` is what to
               * attach to, and a caller handed a dead id there would open a
               * stream to nothing. This one is what to CAPTURE — an agent that
               * finished leaves a pane full of what it did, and a tab archived
               * off `session` alone came back blank for exactly that pane.
               */
              lastSession: store.lastSessionFor(leafPane.id) ?? null,
            })),
          };
        });
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
        // Captured BEFORE the root is drained: afterwards there is no root left
        // to ask, and `groupOf` would answer undefined.
        const group = store.groupOf(root) ?? String(root);

        const panes = store.panes(root);
        for (const pane of panes) unwrap(store.close(pane));
        unwrap(store.removeRoot(root));

        /*
         * A window showing a root that no longer exists draws nothing at all —
         * so it goes somewhere, and where is a SIBLING TAB first.
         *
         * Falling straight home would mean closing tab 2 of a task threw you out
         * of the task, when the tab you were not looking at is right there and
         * is the same pane group you were working in. Home is what is left when
         * the group is finished.
         */
        if (activeRoot() === root) {
          const sibling = store.rootsInGroup(group).find((candidate) => candidate !== root);
          onSwitchRoot(sibling ?? homeRoot);
        }
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
