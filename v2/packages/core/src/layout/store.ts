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

/** What can end a session. Required, so the wiring cannot be omitted. */
export interface SessionSink {
  kill(id: SessionID): void;
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

export interface CloseOutcome {
  /** The pane that went away. */
  readonly closed: PaneID;
  /** The session it was showing, if any — already killed by the time you see this. */
  readonly endedSession?: SessionID;
  /**
   * True when that was the last pane of the root. ⌘W then falls through to the
   * window, and **only** here: closing the window on any other pane is the
   * classic Electron bug where a split vanishes because one pane was closed.
   */
  readonly wasLastPane: boolean;
}

/** Persisted shape. `schemaVersion` rides IN the payload — review §Bad-8. */
export interface PersistedLayout {
  readonly schemaVersion: 1;
  readonly roots: readonly {
    readonly id: string;
    readonly tree: PersistedNode;
    readonly focusedPaneId: string | null;
  }[];
}

const STORAGE_KEY = 'layout';
const DEFAULT_PERSIST_DEBOUNCE_MS = 400;

interface RootState {
  readonly id: RootID;
  tree: SplitNode;
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

  /** Creates a root with one empty pane, or restores it from storage. */
  open(id: string = 'window-1'): RootID {
    const restored = this.#restore(rootId(id));
    if (restored) return restored.id;

    const pane = makePane({}, this.#newPane);
    const state: RootState = {
      id: rootId(id),
      tree: leaf(pane),
      focusedPaneId: pane.id,
      zoomedPaneId: null,
      viewport: { x: 0, y: 0, width: 0, height: 0 },
    };
    this.#roots.set(state.id, state);
    this.#changed(state.id);
    return state.id;
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

  tree(root: RootID): SplitNode | undefined {
    return this.#roots.get(root)?.tree;
  }

  /**
   * The pane a command acts on: the focused one, else the first leaf. A stale id
   * (its pane was closed) resolves like no id at all — otherwise every command
   * after a close is a silent no-op against a pane that is gone.
   */
  focused(root: RootID): PaneID | null {
    const state = this.#roots.get(root);
    if (!state) return null;
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
    for (const [id, state] of this.#roots) if (containsPane(state.tree, pane)) return id;
    return undefined;
  }

  pane(id: PaneID): Pane | null {
    for (const state of this.#roots.values()) {
      const found = findPane(state.tree, id);
      if (found) return found;
    }
    return null;
  }

  // ------------------------------------------------------------------- sessions

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

  // ------------------------------------------------------------------ mutations

  setViewport(root: RootID, rect: Rect): void {
    const state = this.#roots.get(root);
    if (!state) return;
    // Not a change worth announcing: geometry does not alter the tree, and
    // notifying here would re-render the renderer that just told us.
    state.viewport = rect;
  }

  split(root: RootID, axis: SplitAxis, init: PaneInit = {}): Result<PaneID, string> {
    const state = this.#roots.get(root);
    if (!state) return err(`no root ${root}`);
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
    this.#changed(root);
    return ok(pane.id);
  }

  focusDirection(root: RootID, direction: FocusDirection): Result<PaneID | null, string> {
    const state = this.#roots.get(root);
    if (!state) return err(`no root ${root}`);
    const target = this.focused(root);
    if (target === null) return ok(null);

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
    const next = closing(state.tree, pane);

    if (next === null) {
      // The last pane. The tree is left alone — the app decides what closing the
      // window means, and a root with no leaves is not a state anything can draw.
      if (session !== undefined) this.#endSession(pane, session);
      this.#log.info(`closed the last pane of ${root}`);
      return ok({
        closed: pane,
        ...(session === undefined ? {} : { endedSession: session }),
        wasLastPane: true,
      });
    }

    const heir = siblingLeaf(state.tree, pane) ?? firstLeafId(next);
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

  /** The pty reported a new cwd or OSC title. */
  observe(pane: PaneID, patch: { readonly title?: string; readonly cwd?: string }): Result<void, string> {
    return this.#editPane(pane, (current) => ({
      ...current,
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.cwd === undefined ? {} : { cwd: patch.cwd }),
    }));
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
      regions: { main: this.#projectNode(state.tree) },
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
    const result = updatePane(state.tree, pane, edit);
    if (!result.ok) return err(`no pane ${pane}`);
    state.tree = result.tree;
    this.#changed(root);
    return ok(undefined);
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
        tree: serializeNode(state.tree),
        focusedPaneId: state.focusedPaneId,
      })),
    };
    this.#storage.set(STORAGE_KEY, payload);
  }

  /**
   * A restored root comes back with **fresh pane ids and no sessions**: live
   * state never survives a restart, and reusing an id would let a stale binding
   * from the previous run resolve to a new pane. `deserializeNode` mints them.
   */
  #restore(id: RootID): RootState | undefined {
    if (!this.#storage) return undefined;
    const raw = this.#storage.get<unknown>(STORAGE_KEY, PASSTHROUGH);
    if (raw === undefined) return undefined;

    const record = raw as PersistedLayout;
    if (record?.schemaVersion !== 1 || !Array.isArray(record.roots)) {
      this.#log.warn('persisted layout has no recognizable schemaVersion — starting fresh');
      return undefined;
    }
    const saved = record.roots.find((candidate) => candidate.id === id);
    if (!saved) return undefined;

    let tree: SplitNode;
    try {
      tree = deserializeNode(saved.tree, this.#newPane);
    } catch (error) {
      // A corrupt tree must not stop the app from starting. This is a restore
      // path; the cost of ignoring it is one lost layout, and the cost of
      // throwing is a window that never opens.
      this.#log.warn(`could not restore the layout for ${id}, starting fresh: ${messageOf(error)}`);
      return undefined;
    }

    const state: RootState = {
      id,
      tree,
      focusedPaneId: firstLeafId(tree),
      zoomedPaneId: null,
      viewport: { x: 0, y: 0, width: 0, height: 0 },
    };
    this.#roots.set(id, state);
    this.#log.info(`restored ${leafIds(tree).length} pane(s) for ${id}`);
    this.#notify(id);
    return state;
  }
}

/** `KV.get` validates; the layout does its own decoding, so this lets it through. */
const PASSTHROUGH = { describe: 'unknown', parse: (value: unknown) => ok(value) };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
