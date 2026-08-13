import {
  err,
  nodeId,
  ok,
  rootId,
  toDisposable,
  type Clock,
  type Disposable,
  type KV,
  type LayoutNode as PublicNode,
  type LayoutRoot as PublicRoot,
  type Logger,
  type PaneID,
  type Rect,
  type Result,
  type RootID,
  type SessionID,
} from '@shepherd/sdk';
import type { RandomId } from '../identity.ts';
import { debounce, type Debounced } from '../util/debounce.ts';
import { makePane, type Pane, type PaneInit } from './pane.ts';
import {
  clampRatio,
  closing,
  containsPane,
  firstLeafId,
  findPane,
  leaf,
  leafIds,
  neighbor,
  setRatio,
  siblingLeaf,
  splitPane,
  updatePane,
  type FocusDirection,
  type SplitAxis,
  type SplitNode,
} from './tree.ts';
import { deserializeNode, serializeNode, type PersistedNode } from './serialize.ts';

/**
 * The layout, owned by the kernel.
 *
 * M0 kept the tree in the renderer, which was right for M0 and wrong from here:
 * `LayoutAPI`, attention aggregation and `isViewing` are all core concerns,
 * extensions read the tree, and — the load-bearing one — **`layout.close` has to
 * be what ends a session.** With the binding in a renderer, closing a pane over
 * the control socket leaks a live pty while the renderer's own close path
 * double-kills it. So the store owns the pane→session map and is constructed
 * with the thing that can end one; there is no way to build a store that forgets.
 *
 * Where the session binding is NOT: on `Pane`. That type documents itself as
 * carrying only what the layout needs and what survives a relaunch, and
 * `SplitTree` stays pure geometry (it is the one core subpath the renderer may
 * import). A live session id belongs to neither.
 *
 * Every mutation here is reached through a command (`commands.ts` in this
 * directory), so the invariants live in one normalizing funnel rather than at N
 * call sites — v1 grew three routing paths that each re-implemented "and now fix
 * up the focus", and they disagreed.
 */

/**
 * What can end a session, and what can say whether one is still alive.
 *
 * `isLive` arrives with R1 (ADR 0036). Sessions now outlive the app, so a
 * restored pane's persisted `sessionId` is a claim rather than a fact — and the
 * only thing that can settle it is the process that holds the ptys. Required
 * rather than optional, for the same reason `kill` is: a store built without it
 * would silently adopt bindings nobody checked, which is the failure mode the
 * whole verification exists to prevent.
 */
/**
 * A pane about to be minted, and optionally the session it is BORN SHOWING.
 *
 * `session` exists because a pane that is meant to display an EXISTING session
 * cannot be bound a moment after it appears. The renderer decides to create a
 * session by looking at the snapshot it was handed: a pane that arrives with no
 * binding is a pane it starts a pty for. So a binding applied after the pane was
 * announced is a race the renderer wins — it creates a second, local shell —
 * and the fix is not a faster bind but a pane that is never announced unbound.
 *
 * The first caller is another member's terminal: the session is already running
 * on another machine, and nothing here may start one. `tasks.spawn` does not want
 * it (its pane creates its own session, which is the ordinary path), and nothing
 * about it reaches disk — `serialize.ts` writes the BINDING, which this only
 * arrives at sooner.
 */
export interface PaneSeed extends PaneInit {
  readonly session?: SessionID;
}

export interface SessionSink {
  kill(id: SessionID): void;
  isLive(id: SessionID): boolean;
}

export interface LayoutStoreOptions {
  readonly logger: Logger;
  readonly clock: Clock;
  readonly sessions: SessionSink;
  /** Absent = nothing is persisted (a test, or a window with no store yet). */
  readonly storage?: KV;
  readonly newPane?: RandomId;
  readonly persistDebounceMs?: number;
}

/** How a root is minted. Nothing here applies to a root restored from storage. */
export interface OpenOptions {
  /**
   * Mint it with NO pane.
   *
   * The home root asks for this at launch. A shell minted for a window nobody
   * asked to put anything in is how "you have no tasks" came to be drawn as a
   * terminal sitting in a directory that had usually just been deleted.
   */
  readonly empty?: boolean;
  /**
   * The pane group this root is a tab of. Defaults to the root's own id.
   *
   * Applies only to the MINT, like `empty` and `init` above: a restored root
   * already belongs to whatever group it was in, and re-deciding that here
   * would let the second caller of `open` move a root out from under the first.
   */
  readonly group?: string;
}

export interface CloseOutcome {
  /** The pane that went away. */
  readonly closed: PaneID;
  /** The session it was showing, if any — already killed by the time you see this. */
  readonly endedSession?: SessionID;
  /**
   * True when that was the last pane of the root, which is now a fact about the
   * ROOT rather than an instruction about the window: the root is left open and
   * empty, and the shell decides what that means for each one (a task's root is
   * finished with; the home root becomes the empty state). Never a signal to
   * close the window on any OTHER pane — that is the classic Electron bug where
   * a split vanishes because one of its panes was closed.
   */
  readonly wasLastPane: boolean;
}

/** Persisted shape. `schemaVersion` rides IN the payload — review §Bad-8. */
export interface PersistedLayout {
  readonly schemaVersion: 1;
  readonly roots: readonly {
    readonly id: string;
    /**
     * `null` for a root the user left with no panes in it — which is a thing
     * they can now do, and which has to survive a relaunch or the empty state
     * would silently refill itself with a shell on the next launch.
     *
     * **Still `schemaVersion: 1`,** and that is a decision rather than an
     * oversight. An older build reading a null tree throws `LayoutDecodeError`
     * inside `#restore`, which already catches it and starts that root fresh —
     * so a downgrade loses an empty root and gains a pane, which is exactly what
     * the old build would have done anyway. Bumping the version would instead
     * discard the WHOLE payload, including every root that decodes perfectly.
     */
    readonly tree: PersistedNode | null;
    readonly focusedPaneId: string | null;
    /**
     * The pane group this root is a tab of.
     *
     * **Optional, and still `schemaVersion: 1`** — for the same reason the
     * nullable `tree` above is. An older build ignores a field it does not know
     * and gets N independent roots, which is precisely how it behaved before
     * groups existed; bumping the version would instead discard the WHOLE
     * payload, including every root that decodes perfectly. Absent on read means
     * the root is its own group, which is the same default the mint applies.
     */
    readonly group?: string;
  }[];
}

const STORAGE_KEY = 'layout';
const DEFAULT_PERSIST_DEBOUNCE_MS = 400;

interface RootState {
  readonly id: RootID;
  /**
   * Which pane group this root is a TAB OF.
   *
   * Defaults to the root's own id, so a root nobody grouped is a group of one
   * and behaves exactly as it did before groups existed — that default is what
   * makes tabs additive rather than a migration, here and in the persisted
   * payload both.
   *
   * An OPAQUE string the kernel never interprets: `tasks` names its group
   * `task:<id>`, the home root's is `window-1`, and nothing here learns what
   * either means (ADR 0031). Set at mint and never changed — a root does not
   * move between groups, because whatever owns the group is also what opened
   * the root, and a root that could be reparented would need an answer for what
   * happens to the group it left.
   */
  readonly group: string;
  /**
   * The pane tree, or **null for a root that holds no panes**.
   *
   * Nullable since the empty-state fix, and it is a real state rather than a
   * transient: closing the last pane of the home root leaves the root open and
   * empty rather than closing the window (v1 landed on exactly this — a
   * workspace may hold zero tabs, and `WorkspaceEmptyView` is what it draws).
   * Before, `close` left the last pane's tree INTACT and the shell closed the
   * window, so a zero-pane projection could not exist — and the app's empty
   * state was therefore unreachable, drawing only in the instant before main's
   * first push.
   *
   * `SplitNode` has no empty variant and must not grow one: an empty tree would
   * be a case every walk (`leafIds`, `frames`, `neighbor`, `closing`) has to
   * carry, to express something that is a property of the ROOT. Null here is one
   * check at the root, in the places that already ask whether there is anything
   * to draw.
   */
  tree: SplitNode | null;
  focusedPaneId: PaneID | null;
  /** Transient, never persisted — v1's rule for zoom, kept. */
  zoomedPaneId: PaneID | null;
  /**
   * The pane area, pushed by the renderer on resize rather than measured here.
   *
   * Core has no DOM, and `neighbor` needs a rect. v1 solved this the same way
   * ("feeds the content rect to the store so ⌘⌥-arrow focus moves can resolve
   * geometric neighbors"), and the consequence is the one that matters: a focus
   * command takes no rect argument, so the CLI and an extension can invoke it.
   */
  viewport: Rect;
}

export class LayoutStore {
  readonly #roots = new Map<RootID, RootState>();
  /**
   * Pending initial input, per pane. **In memory only** — `serialize.ts`
   * excludes `initialCommand` from the persisted shape precisely so a relaunch
   * does not re-run a command, and a map that reached disk would undo that.
   */
  readonly #initialInput = new Map<PaneID, string>();
  /**
   * A previously captured screen, per pane, waiting for that pane's session to
   * be created. **In memory only**, for the same reason `#initialInput` is: it
   * describes a session that does not exist yet, and a map that reached disk
   * would replay a restored screen on every launch forever.
   */
  readonly #initialSeed = new Map<PaneID, Uint8Array>();
  readonly #sessionByPane = new Map<PaneID, SessionID>();
  readonly #paneBySession = new Map<SessionID, PaneID>();
  readonly #listeners = new Set<(root: RootID) => void>();
  readonly #log;
  readonly #sessions: SessionSink;
  readonly #storage: KV | undefined;
  readonly #newPane: RandomId | undefined;
  readonly #persist: Debounced;

  constructor(options: LayoutStoreOptions) {
    this.#log = options.logger.child('layout');
    this.#sessions = options.sessions;
    this.#storage = options.storage;
    this.#newPane = options.newPane;
    // Debounced because a drag, a burst of splits, or a restore would otherwise
    // write once per keystroke — v1 re-encoded its whole state on every `cd`.
    this.#persist = debounce(
      options.clock,
      options.persistDebounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS,
      () => this.#writeNow(),
    );
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * Creates a root with one empty pane, or restores it from storage.
   *
   * **Idempotent.** A root that is already open is answered as-is, and nothing
   * is read from storage: re-restoring a live root would replace its tree with
   * FRESH pane ids (`#restore` mints them by design), which orphans every
   * session binding and leaves the ptys running with no pane pointing at them.
   * Multi-root makes that reachable at runtime — `layout.openRoot` names a root
   * the caller may well have open already — where a single window could only
   * ever call this once.
   *
   * `init` shapes the FIRST pane, and only when the root is minted fresh. A
   * restored root already has the panes the user left there; applying a cwd or
   * an initial command to one of them would re-run a command that the persisted
   * shape deliberately drops (see `serialize.ts`) and re-point a pane the user
   * had moved elsewhere.
   *
   * **`{ empty: true }` mints it with NO pane.** That is what the home root asks
   * for at launch: the shell's unit of work is a task, and minting a shell in
   * whatever directory happens to be current is how "you have no tasks" came to
   * be drawn as a terminal — usually sitting in a worktree that had just been
   * deleted. It applies only to the MINT: a restore still brings back whatever
   * the user left, empty or not, because that is what they left.
   *
   * `init` with `empty` is a contradiction and the pane wins nothing: there is
   * no pane to shape. Passing both is legal and `init` is ignored, rather than a
   * failure, because the caller that does it is a caller that stopped needing a
   * first pane and left an argument behind.
   */
  open(id: string = 'window-1', init?: PaneSeed, options: OpenOptions = {}): RootID {
    const live = this.#roots.get(rootId(id));
    if (live) return live.id;

    const restored = this.#restore(rootId(id));
    if (restored) return restored.id;

    if (options.empty === true) {
      const state: RootState = {
        id: rootId(id),
        group: options.group ?? id,
        tree: null,
        focusedPaneId: null,
        zoomedPaneId: null,
        viewport: { x: 0, y: 0, width: 0, height: 0 },
      };
      this.#roots.set(state.id, state);
      this.#changed(state.id);
      return state.id;
    }

    const pane = makePane(init ?? {}, this.#newPane);
    const state: RootState = {
      id: rootId(id),
      group: options.group ?? id,
      tree: leaf(pane),
      focusedPaneId: pane.id,
      zoomedPaneId: null,
      viewport: { x: 0, y: 0, width: 0, height: 0 },
    };
    this.#roots.set(state.id, state);
    // BEFORE `#changed`: see `PaneSeed.session`. A pane announced unbound is a
    // pane the renderer starts a pty for.
    if (init?.session !== undefined) this.bindSession(pane.id, init.session);
    this.#changed(state.id);
    return state.id;
  }

  /**
   * Another tab of `group`, minted with one pane.
   *
   * The id is READABLE (`task:t1/tab-2`) rather than random, because it shows up
   * in `daemon.log`, in the persisted payload and in `shepherd raw
   * layout.listRoots` — and a random id in any of those tells you nothing about
   * which group it belongs to.
   *
   * The smallest unused N, checked against LIVE and PERSISTED roots both. Live
   * alone is not enough: the shell opens a persisted root lazily, so a tab
   * minted before its sibling was opened would take an id that is about to be
   * restored — and `open` is idempotent, so the collision would not throw. It
   * would silently hand the new tab the old tab's panes.
   */
  newTab(group: string, init: PaneSeed = {}): Result<RootID, string> {
    if (group === '') return err('a tab needs a group');
    const taken = new Set<string>([...this.#roots.keys(), ...this.persistedRoots()]);
    let n = 2;
    while (taken.has(`${group}/tab-${n}`)) n += 1;
    const id = `${group}/tab-${n}`;
    this.open(id, init, { group });
    return ok(rootId(id));
  }

  /**
   * Forget a root entirely — the multi-root counterpart of closing a window.
   *
   * It does NOT end sessions: `layout.close` is the one terminator (ADR 0022),
   * so a caller drains the root's panes through `close` first and this drops
   * what is left. Going through `#changed` is what makes it stick: the notify
   * lets the shell republish (and `ViewingResolver` announce the vanished panes
   * as no longer viewed), and the scheduled write is the only reason the root
   * stops being persisted — `#writeNow` serializes whatever is in `#roots`, so
   * a root removed without it comes back on the next launch forever.
   */
  removeRoot(id: RootID): Result<void, string> {
    const state = this.#roots.get(id);
    if (!state) return err(`no root ${id}`);
    // Pending initial input for panes that never got a session would otherwise
    // outlive the panes it names, and every entry here is keyed by a pane id
    // that can never be minted again.
    for (const pane of state.tree === null ? [] : leafIds(state.tree)) {
      this.#initialInput.delete(pane);
      this.#initialSeed.delete(pane);
    }
    this.#roots.delete(id);
    this.#changed(id);
    this.#log.info(`removed root ${id}`);
    return ok(undefined);
  }

  /** For app teardown: the pending layout write must not be lost on quit. */
  flush(): void {
    this.#persist.flush();
  }

  dispose(): void {
    this.#persist.dispose();
    this.#listeners.clear();
  }

  // -------------------------------------------------------------------- queries

  roots(): readonly RootID[] {
    return [...this.#roots.keys()];
  }

  /**
   * Root ids sitting in storage, whether or not they are open.
   *
   * The shell needs this at launch: with one root per task, opening only the
   * home root would leave every task's panes persisted but invisible — the
   * layout would look like it had been forgotten while the record of it sat on
   * disk. Deliberately a *query* rather than an "open everything" method, so
   * the decision about which roots a window puts on screen stays in the shell.
   *
   * Reads the same payload `#restore` does, and is equally forgiving: a
   * corrupt or unrecognized blob is no roots, never a throw. This runs before
   * the first window exists.
   */
  persistedRoots(): readonly RootID[] {
    const record = this.#persisted();
    if (record === undefined) return [];
    return record.roots
      .filter((saved) => typeof saved?.id === 'string' && saved.id !== '')
      .map((saved) => rootId(saved.id));
  }

  /**
   * Which pane group a root is a tab of, or undefined for a root not open.
   *
   * Undefined rather than the id itself for an unknown root, deliberately: the
   * default belongs to the mint, and answering "its own id" here would make a
   * typo indistinguishable from a root that exists.
   */
  groupOf(root: RootID): string | undefined {
    return this.#roots.get(root)?.group;
  }

  /**
   * The roots of one group, in creation order — which IS tab order.
   *
   * Insertion order of `#roots` rather than an explicit index: a `Map` keeps it,
   * `#restore` re-inserts in persisted order, and an order field with no
   * reordering gesture to write it would be a second fact nobody maintains.
   */
  rootsInGroup(group: string): readonly RootID[] {
    return [...this.#roots.values()].filter((state) => state.group === group).map((state) => state.id);
  }

  /**
   * The tree to draw, if there is one.
   *
   * `undefined` now means "no root **or** no panes", which is deliberately the
   * same answer: every caller of this asks it in order to walk a tree, and both
   * cases mean there is nothing to walk. What it is NOT any more is an existence
   * check — that is `hasRoot`, and the two questions parted company the moment a
   * root could be empty. Every `store.tree(root) === undefined` that meant "does
   * this root exist" was converted with this change.
   */
  tree(root: RootID): SplitNode | undefined {
    return this.#roots.get(root)?.tree ?? undefined;
  }

  /**
   * Does this root exist — whether or not it holds anything.
   *
   * Split out of `tree() === undefined`, which answered both questions with one
   * value while a root could not be empty. Left as it was, `layout.switchRoot`
   * would refuse to switch to an empty root and `layout.closeRoot` would refuse
   * to close one, both reporting "no root" about a root that is open.
   */
  hasRoot(root: RootID): boolean {
    return this.#roots.has(root);
  }

  /**
   * The pane a command acts on: the focused one, else the first leaf. A stale id
   * (its pane was closed) resolves like no id at all — otherwise every command
   * after a close is a silent no-op against a pane that is gone.
   */
  focused(root: RootID): PaneID | null {
    const state = this.#roots.get(root);
    if (!state) return null;
    if (state.tree === null) return null;
    const id = state.focusedPaneId;
    if (id !== null && containsPane(state.tree, id)) return id;
    return firstLeafId(state.tree);
  }

  zoomed(root: RootID): PaneID | null {
    return this.#roots.get(root)?.zoomedPaneId ?? null;
  }

  viewport(root: RootID): Rect | undefined {
    return this.#roots.get(root)?.viewport;
  }

  panes(root: RootID): readonly PaneID[] {
    const tree = this.tree(root);
    return tree ? leafIds(tree) : [];
  }

  /** Which root holds a pane. Needed because a command names a pane, not a root. */
  rootOf(pane: PaneID): RootID | undefined {
    for (const [id, state] of this.#roots) {
      if (state.tree !== null && containsPane(state.tree, pane)) return id;
    }
    return undefined;
  }

  pane(id: PaneID): Pane | null {
    for (const state of this.#roots.values()) {
      const found = state.tree === null ? null : findPane(state.tree, id);
      if (found) return found;
    }
    return null;
  }

  // ------------------------------------------------------------------- sessions

  /**
   * Give a pane the one thing that will be typed into its session — M3 D10.
   *
   * **There is exactly one of these, and it is consumed once.** v1 learned this
   * the expensive way: a composed prompt and a `--resume` line were two producers
   * of "the first thing typed", and two producers race. Here a pane carries at
   * most one initial input, whoever created the pane decided which it is (the
   * composer's launch command, or a task's resume line), and the precedence
   * question is settled before a pane exists rather than adjudicated here.
   *
   * A newline in this string is an **Enter press**, because it is typed into a
   * pty. Multi-line text must therefore be delivered some other way — v1 wrote
   * it to a temp file and typed a one-line command that read it back. This seam
   * carries the command, never the prose.
   */
  setInitialInput(pane: PaneID, input: string): void {
    const found = this.pane(pane);
    if (found === undefined) {
      this.#log.warn(`initial input for ${pane} was dropped: no such pane`);
      return;
    }
    this.#initialInput.set(pane, input);
  }

  /**
   * Take it, once.
   *
   * One-shot by construction rather than by discipline: the second caller gets
   * `undefined` because the first deleted it. A seam that could answer twice is
   * how a prompt gets submitted twice, and it would do so only under a race
   * nobody reproduces on purpose.
   */
  takeInitialInput(pane: PaneID): string | undefined {
    const input = this.#initialInput.get(pane);
    this.#initialInput.delete(pane);
    return input;
  }

  /**
   * The screen this pane should be BORN showing — a restored tab's history.
   *
   * The companion of `setInitialInput`, and one-shot for the same reason: the
   * second caller gets `undefined` because the first deleted it. A pane whose
   * session dies and is replaced must not silently replay a screen from before
   * the task was archived.
   */
  setInitialSeed(pane: PaneID, seed: Uint8Array): void {
    this.#initialSeed.set(pane, seed);
  }

  takeInitialSeed(pane: PaneID): Uint8Array | undefined {
    const seed = this.#initialSeed.get(pane);
    this.#initialSeed.delete(pane);
    return seed;
  }

  bindSession(pane: PaneID, session: SessionID): void {
    const previous = this.#sessionByPane.get(pane);
    if (previous !== undefined && previous !== session) this.#paneBySession.delete(previous);
    this.#sessionByPane.set(pane, session);
    this.#paneBySession.set(session, pane);
    this.#log.debug(`pane ${pane} shows session ${session}`);
  }

  /** A session that exited on its own: the pane stays, the binding goes. */
  unbindSession(session: SessionID): void {
    const pane = this.#paneBySession.get(session);
    this.#paneBySession.delete(session);
    if (pane !== undefined) this.#sessionByPane.delete(pane);
  }

  sessionFor(pane: PaneID): SessionID | undefined {
    return this.#sessionByPane.get(pane);
  }

  paneForSession(session: SessionID): PaneID | undefined {
    return this.#paneBySession.get(session);
  }

  /**
   * Reattach each restored pane to the session it was showing — if that session
   * is still there.
   *
   *   - live  → the pane adopts it, and the renderer is handed the id in the
   *             snapshot, where `PaneSessionRegistry` adopts rather than creates;
   *   - gone  → the binding is dropped and the pane creates one, as before R1;
   *   - live but unclaimed → an ORPHAN. Logged rather than leaked; adopting or
   *             reaping it needs a surface, and inventing one ahead of a caller
   *             is what ADR 0031 declines to do.
   */
  #adoptPersistedSessions(persisted: PersistedNode | null, restored: SplitNode): void {
    if (persisted === null) return;
    let adopted = 0;
    let dropped = 0;

    const walk = (node: PersistedNode, live: SplitNode): void => {
      if (node.kind === 'leaf' && live.kind === 'leaf') {
        const claimed = node.pane.sessionId;
        if (claimed === undefined || claimed === '') return;
        const session = claimed as SessionID;
        if (this.#sessions.isLive(session)) {
          this.bindSession(live.pane.id, session);
          adopted += 1;
        } else {
          dropped += 1;
        }
        return;
      }
      if (node.kind === 'split' && live.kind === 'split') {
        walk(node.first, live.first);
        walk(node.second, live.second);
      }
    };
    walk(persisted, restored);

    if (adopted > 0 || dropped > 0) {
      this.#log.info(
        `restore: reattached ${adopted} session(s), dropped ${dropped} that had ended`,
      );
    }
  }

  // ------------------------------------------------------------------ mutations

  setViewport(root: RootID, rect: Rect): void {
    const state = this.#roots.get(root);
    if (!state) return;
    // Not a change worth announcing: geometry does not alter the tree, and
    // notifying here would re-render the renderer that just told us.
    state.viewport = rect;
  }

  split(root: RootID, axis: SplitAxis, init: PaneSeed = {}): Result<PaneID, string> {
    const state = this.#roots.get(root);
    if (!state) return err(`no root ${root}`);

    /*
     * Splitting an EMPTY root gives it its first pane.
     *
     * Not a special case bolted on: with a root able to hold none, "make me a
     * pane here" and "make me another pane here" are the same gesture, and ⌘D on
     * the empty state has to do something other than log `nothing to split`. It
     * is the only way back into an empty home root from the keyboard, so the
     * alternative is an empty state you can only leave by composing a task.
     */
    if (state.tree === null) return ok(this.#seed(state, init));

    const target = this.focused(root);
    if (target === null) return err('nothing to split');

    // A new pane inherits its parent's cwd.
    const parent = findPane(state.tree, target);
    const pane = makePane({ cwd: parent?.cwd ?? null, ...init }, this.#newPane);
    const edit = splitPane(state.tree, target, axis, pane);
    if (!edit.ok) return err(`could not split ${target}`);

    state.tree = edit.tree;
    state.focusedPaneId = pane.id;
    // Splitting clears zoom: a zoomed pane starving its new sibling to 0×0 is a
    // split the user cannot see.
    state.zoomedPaneId = null;
    // BEFORE `#changed`: see `PaneSeed.session`.
    if (init.session !== undefined) this.bindSession(pane.id, init.session);
    this.#changed(root);
    return ok(pane.id);
  }

  focusDirection(root: RootID, direction: FocusDirection): Result<PaneID | null, string> {
    const state = this.#roots.get(root);
    if (!state) return err(`no root ${root}`);
    const target = this.focused(root);
    if (target === null || state.tree === null) return ok(null);

    const next = neighbor(state.tree, target, direction, state.viewport);
    if (next === null) {
      // Not an error — the edge of the layout is a legitimate answer, and an
      // error here would make ⌘⌥← at the left edge look like a failure.
      this.#log.debug(`no ${direction} neighbour of ${target}`);
      return ok(null);
    }
    state.focusedPaneId = next;
    this.#changed(root);
    return ok(next);
  }

  focusPane(pane: PaneID): Result<void, string> {
    const root = this.rootOf(pane);
    if (root === undefined) return err(`no pane ${pane}`);
    const state = this.#roots.get(root)!;
    if (state.focusedPaneId === pane) return ok(undefined);
    state.focusedPaneId = pane;
    this.#changed(root);
    return ok(undefined);
  }

  /**
   * Closes a pane and **ends the session it was showing**. This is the one place
   * a session dies of a layout gesture; a re-render, a reparent, or a focus
   * change never touches one.
   */
  close(pane: PaneID): Result<CloseOutcome, string> {
    const root = this.rootOf(pane);
    if (root === undefined) return err(`no pane ${pane}`);
    const state = this.#roots.get(root)!;

    const session = this.#sessionByPane.get(pane);
    // Non-null: `rootOf` found the pane in this root's tree, so there is one.
    const tree = state.tree as SplitNode;
    const next = closing(tree, pane);

    if (next === null) {
      /*
       * The last pane. The root is now EMPTY — the tree really goes to null, and
       * that is the change the empty state needed.
       *
       * It used to be left intact, with the shell closing the window instead. So
       * a zero-pane projection could not exist, the app's empty state was
       * unreachable, and "you have no tasks" was drawn as a live shell sitting in
       * whatever directory was current — usually a worktree that had just been
       * deleted. `wasLastPane` still reports the fact; what the shell does with
       * it is the shell's, and for the home root it is now "draw the empty state"
       * rather than "quit".
       *
       * `#changed`, not silence: this is a structural change that has to reach
       * the renderer AND the persisted payload, or the next launch mints a pane
       * into a root the user emptied on purpose.
       */
      state.tree = null;
      state.focusedPaneId = null;
      state.zoomedPaneId = null;
      if (session !== undefined) this.#endSession(pane, session);
      this.#log.info(`closed the last pane of ${root}; it is now empty`);
      this.#changed(root);
      return ok({
        closed: pane,
        ...(session === undefined ? {} : { endedSession: session }),
        wasLastPane: true,
      });
    }

    const heir = siblingLeaf(tree, pane) ?? firstLeafId(next);
    state.tree = next;
    state.focusedPaneId = heir;
    if (state.zoomedPaneId === pane) state.zoomedPaneId = null;
    if (session !== undefined) this.#endSession(pane, session);
    this.#changed(root);

    return ok({
      closed: pane,
      ...(session === undefined ? {} : { endedSession: session }),
      wasLastPane: false,
    });
  }

  setRatio(root: RootID, path: readonly number[], ratio: number): Result<void, string> {
    const state = this.#roots.get(root);
    if (!state) return err(`no root ${root}`);
    if (!Number.isFinite(ratio)) return err(`ratio must be finite, got ${ratio}`);
    if (state.tree === null) return err(`${root} has no panes`);
    state.tree = setRatio(state.tree, path, clampRatio(ratio));
    this.#changed(root);
    return ok(undefined);
  }

  /** `null` un-zooms. Transient, so this never persists. */
  zoom(pane: PaneID | null, root?: RootID): Result<void, string> {
    const id = pane === null ? root : this.rootOf(pane);
    if (id === undefined) return err('no root to zoom in');
    const state = this.#roots.get(id);
    if (!state) return err(`no root ${id}`);
    state.zoomedPaneId = state.zoomedPaneId === pane ? null : pane;
    this.#notify(id); // no persist: zoom never survives a restart
    return ok(undefined);
  }

  rename(pane: PaneID, userTitle: string | null): Result<void, string> {
    return this.#editPane(pane, (current) => ({ ...current, userTitle }));
  }

  /**
   * The pty reported a new cwd or OSC title.
   *
   * A no-op patch returns without touching the tree: a shell re-emits both on
   * every prompt, and `#editPane` would push a full snapshot to the renderer and
   * schedule a write to say nothing had happened. The "no pane" refusal still
   * comes first — a miss is not the same answer as a no-op.
   */
  observe(
    pane: PaneID,
    patch: { readonly title?: string; readonly cwd?: string },
  ): Result<void, string> {
    const current = this.pane(pane);
    if (current === null) return err(`no pane ${pane}`);
    const title = patch.title ?? current.title;
    const cwd = patch.cwd ?? current.cwd;
    if (title === current.title && cwd === current.cwd) return ok(undefined);
    return this.#editPane(pane, (live) => ({ ...live, title, cwd }));
  }

  // --------------------------------------------------------------------- events

  onDidChange(listener: (root: RootID) => void): Disposable {
    this.#listeners.add(listener);
    return toDisposable(() => void this.#listeners.delete(listener));
  }

  // ------------------------------------------------------------------ projection

  /** The read-only DTO an extension sees. The internal tree never leaves core. */
  project(root: RootID): PublicRoot | undefined {
    const state = this.#roots.get(root);
    if (!state) return undefined;
    return {
      id: state.id,
      group: state.group,
      // A paneless root contributes NO region rather than an empty one: `regions`
      // is `Partial<Record<RegionName, LayoutNode>>` and an absent key already
      // means "nothing here", so an extension reading it needs no new case.
      regions: state.tree === null ? {} : { main: this.#projectNode(state.tree) },
      focused: state.focusedPaneId === null ? null : nodeId(state.focusedPaneId),
      zoomed: state.zoomedPaneId === null ? null : nodeId(state.zoomedPaneId),
    };
  }

  #projectNode(node: SplitNode): PublicNode {
    if (node.kind === 'leaf') {
      const session = this.#sessionByPane.get(node.pane.id);
      return {
        kind: 'leaf',
        // A leaf's node id IS its pane id at this layer. They are separate types
        // because the tree addresses structure and a pane addresses a surface;
        // here one leaf holds exactly one pane, so the mapping is the identity.
        id: nodeId(node.pane.id),
        title: node.pane.userTitle ?? node.pane.title,
        view:
          session === undefined
            ? { kind: 'view', type: 'terminal.empty' }
            : { kind: 'terminal', sessionId: session },
      };
    }
    return {
      kind: 'split',
      id: nodeId(`split:${node.axis}`),
      axis: node.axis,
      ratio: node.ratio,
      children: [this.#projectNode(node.first), this.#projectNode(node.second)],
    };
  }

  // ------------------------------------------------------------------ internals

  #editPane(pane: PaneID, edit: (current: Pane) => Pane): Result<void, string> {
    const root = this.rootOf(pane);
    if (root === undefined) return err(`no pane ${pane}`);
    const state = this.#roots.get(root)!;
    // `updatePane` answers with a `TreeEdit`, not a tree: its `ok` distinguishes
    // "rewritten" from "that pane is not in here", and dropping the distinction
    // is what makes a miss look like a successful no-op.
    // Non-null: `rootOf` found the pane in this root's tree.
    const result = updatePane(state.tree as SplitNode, pane, edit);
    if (!result.ok) return err(`no pane ${pane}`);
    state.tree = result.tree;
    this.#changed(root);
    return ok(undefined);
  }

  /**
   * Give an empty root its first pane. The mint half of `open`, reachable again
   * once a root can be emptied — otherwise the only way to get a pane into one
   * would be to close and re-open it, which loses the root's identity and every
   * task that names it.
   */
  #seed(state: RootState, init: PaneSeed): PaneID {
    const pane = makePane(init, this.#newPane);
    state.tree = leaf(pane);
    state.focusedPaneId = pane.id;
    state.zoomedPaneId = null;
    // BEFORE `#changed`: see `PaneSeed.session`.
    if (init.session !== undefined) this.bindSession(pane.id, init.session);
    this.#changed(state.id);
    return pane.id;
  }

  #endSession(pane: PaneID, session: SessionID): void {
    this.#sessionByPane.delete(pane);
    this.#paneBySession.delete(session);
    this.#sessions.kill(session);
    this.#log.info(`pane ${pane} closed, ended session ${session}`);
  }

  /** A structural change: notify, and schedule a write. */
  #changed(root: RootID): void {
    this.#notify(root);
    this.#persist.schedule();
  }

  #notify(root: RootID): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(root);
      } catch (error) {
        this.#log.error(`layout listener threw: ${messageOf(error)}`);
      }
    }
  }

  #writeNow(): void {
    if (!this.#storage) return;
    const payload: PersistedLayout = {
      schemaVersion: 1,
      roots: [...this.#roots.values()].map((state) => ({
        id: state.id,
        group: state.group,
        // `null` for an emptied root, and it has to be written rather than
        // skipped: a root dropped from the payload is a root that comes back
        // MINTED on the next launch, which would refill the empty state with a
        // shell the user closed on purpose.
        // The session each pane was showing rides along (ADR 0036). It is a
        // CLAIM: `#restore` checks it against the daemon before believing it.
        tree:
          state.tree === null
            ? null
            : serializeNode(state.tree, (pane) => this.#sessionByPane.get(pane.id)),
        focusedPaneId: state.focusedPaneId,
      })),
    };
    this.#storage.set(STORAGE_KEY, payload);
  }

  /**
   * The persisted payload, decoded once — `#restore` and `persistedRoots` ask
   * the same question of it, and two decoders would be two chances to disagree
   * about what a recognizable blob is.
   */
  #persisted(): PersistedLayout | undefined {
    if (!this.#storage) return undefined;
    const raw = this.#storage.get<unknown>(STORAGE_KEY, PASSTHROUGH);
    if (raw === undefined) return undefined;

    const record = raw as PersistedLayout;
    if (record?.schemaVersion !== 1 || !Array.isArray(record.roots)) {
      this.#log.warn('persisted layout has no recognizable schemaVersion — starting fresh');
      return undefined;
    }
    return record;
  }

  /**
   * A restored root comes back with **fresh pane ids and no sessions**: live
   * state never survives a restart, and reusing an id would let a stale binding
   * from the previous run resolve to a new pane. `deserializeNode` mints them.
   */
  #restore(id: RootID): RootState | undefined {
    const record = this.#persisted();
    if (record === undefined) return undefined;
    const saved = record.roots.find((candidate) => candidate.id === id);
    if (!saved) return undefined;

    let tree: SplitNode | null;
    try {
      // A persisted `null` is a root the user emptied, restored empty. Handled
      // before `deserializeNode`, which has no empty case by design and would
      // report this as corruption — and "corrupt" here means `#restore` returns
      // undefined and `open` mints a pane, i.e. the exact refill this is for.
      tree = saved.tree === null ? null : deserializeNode(saved.tree, this.#newPane);
    } catch (error) {
      // A corrupt tree must not stop the app from starting. This is a restore
      // path; the cost of ignoring it is one lost layout, and the cost of
      // throwing is a window that never opens.
      this.#log.warn(`could not restore the layout for ${id}, starting fresh: ${messageOf(error)}`);
      return undefined;
    }

    // ADR 0036's three cases, and the orphan branch is the one worth naming: a
    // session the daemon still holds that no restored pane claims would
    // otherwise keep running with nothing pointing at it — exactly the leak the
    // persisted binding exists to prevent, arriving through the other door.
    if (tree !== null) this.#adoptPersistedSessions(saved.tree, tree);

    const state: RootState = {
      id,
      // A payload written before groups existed has none, and every root in it
      // is its own — which is exactly how the app behaved then.
      group: saved.group ?? id,
      tree,
      focusedPaneId: tree === null ? null : firstLeafId(tree),
      zoomedPaneId: null,
      viewport: { x: 0, y: 0, width: 0, height: 0 },
    };
    this.#roots.set(id, state);
    this.#log.info(`restored ${tree === null ? 0 : leafIds(tree).length} pane(s) for ${id}`);
    this.#notify(id);
    return state;
  }
}

/** `KV.get` validates; the layout does its own decoding, so this lets it through. */
const PASSTHROUGH = { describe: 'unknown', parse: (value: unknown) => ok(value) };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
