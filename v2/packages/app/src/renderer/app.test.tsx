// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import {
  LAYOUT_COMMANDS,
  leaf,
  makePane,
  split,
  type Pane,
  type SplitNode,
} from '@shepherd/core/layout';
import {
  COMMANDS,
  type CommandsApi,
  type IpcResult,
  type LayoutApi,
  type LayoutSnapshot,
  type LayoutSnapshots,
  type ViewportRect,
} from '../shared/index.ts';
import { MENU_INVOCATIONS } from '../shared/menu-commands.ts';
import { App } from './app.tsx';
import { PaneSessionRegistry } from './pane-sessions.ts';
import { SpySession, fakeTerminal, type FakeTerminal } from './test-terminals.ts';
import { all, mount } from './test-dom.ts';

/**
 * The renderer as P4a leaves it: **a projection plus a transport.**
 *
 * Every test here is one of those two claims. It draws what main pushed (and
 * nothing it computed itself), and a gesture leaves as one `commands.invoke`. The
 * M0 version of this file asserted about `runCommand`'s new tree; there is no new
 * tree here to assert about, which is the change.
 *
 * The terminal registry is the REAL `PaneSessionRegistry` against a fake bridge,
 * not a spy implementing `PaneTerminals`. That is deliberate: the load-bearing
 * claim about a reshape is how many xterms get BUILT, and a spy counts nothing —
 * it is the v1 `makeNSView` count, one language over.
 */

// ---------------------------------------------------------------- the doubles

/** A `LayoutApi` whose pushes the test drives by hand. */
function spyLayout(initial: LayoutSnapshots | null = null) {
  let listeners: Array<(snapshots: LayoutSnapshots) => void> = [];
  const viewports: ViewportRect[] = [];
  let answer = initial;

  return {
    viewports,
    get listeners() {
      return listeners.length;
    },
    /** What main would answer `layout:get` with. */
    set snapshot(next: LayoutSnapshots | null) {
      answer = next;
    },
    api: {
      get: (): Promise<IpcResult<LayoutSnapshots>> =>
        Promise.resolve(
          answer === null
            ? { ok: false, error: { code: 'no-root', message: 'no root' } }
            : { ok: true, value: answer },
        ),
      onChanged: (listener) => {
        listeners.push(listener);
        return () => {
          listeners = listeners.filter((l) => l !== listener);
        };
      },
      setViewport: (rect) => {
        viewports.push(rect);
        return Promise.resolve({ ok: true, value: undefined });
      },
    } satisfies LayoutApi,
    /** Main pushed a new projection. Structure-cloned, exactly as IPC would. */
    push: (snapshot: LayoutSnapshots) => {
      answer = snapshot;
      act(() => {
        for (const listener of [...listeners]) listener(structuredClone(snapshot));
      });
    },
  };
}

function spyCommands() {
  const calls: Array<{ command: string; args: unknown }> = [];
  return {
    calls,
    api: {
      invoke: (command, args) => {
        calls.push({ command, args });
        return Promise.resolve({ ok: true, value: undefined });
      },
      // What the palette reads. Empty here: these tests are about the stage, and
      // a palette that is never opened never asks.
      list: () => Promise.resolve({ ok: true as const, value: [] }),
    } satisfies CommandsApi,
  };
}

/** One root's projection. `snapshotOf` wraps it as the envelope the page reads. */
function rootOf(tree: SplitNode, focused?: Pane, root = 'window-1'): LayoutSnapshot {
  return {
    root,
    tree,
    focusedPaneId: focused?.id ?? firstPaneId(tree),
    zoomedPaneId: null,
    sessions: {},
  };
}

/** The single-root envelope — what almost every test here is about. */
function snapshotOf(tree: SplitNode, focused?: Pane): LayoutSnapshots {
  return { active: 'window-1', roots: [rootOf(tree, focused)] };
}

/** Several roots, one of them active. The multi-root claims below. */
function snapshotsOf(active: string, ...roots: LayoutSnapshot[]): LayoutSnapshots {
  return { active, roots };
}

function firstPaneId(node: SplitNode): string {
  return node.kind === 'leaf' ? node.pane.id : firstPaneId(node.first);
}

function threePaneTree(): { tree: SplitNode; left: Pane; topRight: Pane; bottomRight: Pane } {
  const left = makePane({ userTitle: 'left' });
  const topRight = makePane({ userTitle: 'top-right' });
  const bottomRight = makePane({ userTitle: 'bottom-right' });
  return {
    tree: split('row', 0.5, leaf(left), split('column', 0.5, leaf(topRight), leaf(bottomRight))),
    left,
    topRight,
    bottomRight,
  };
}

interface Rendered {
  readonly view: ReturnType<typeof mount>;
  readonly layout: ReturnType<typeof spyLayout>;
  readonly commands: ReturnType<typeof spyCommands>;
  readonly session: SpySession;
  readonly registry: PaneSessionRegistry;
  /** One entry per xterm the registry built. The `makeNSView` count. */
  readonly built: FakeTerminal[];
}

function render(options: { snapshot?: LayoutSnapshots | null; noTerminals?: boolean } = {}): Rendered {
  const session = new SpySession();
  const built: FakeTerminal[] = [];
  const registry = new PaneSessionRegistry({
    session,
    createTerminal: () => {
      const terminal = fakeTerminal();
      built.push(terminal);
      return terminal;
    },
    spec: (pane) => ({ paneId: pane.id }),
  });
  const initial = options.snapshot === undefined ? snapshotOf(leaf(makePane({}))) : options.snapshot;
  const layout = spyLayout(initial);
  const commands = spyCommands();

  const view = mount(
    <App
      terminals={options.noTerminals === true ? null : registry}
      layout={layout.api}
      commands={commands.api}
      {...(initial === null ? {} : { initialSnapshot: initial })}
    />,
  );
  return { view, layout, commands, session, registry, built };
}

const paneIds = (container: HTMLElement): string[] =>
  all(container, 'pane').map((el) => el.dataset['paneId'] ?? '');

const focusedId = (container: HTMLElement): string | undefined =>
  all(container, 'pane').find((el) => el.dataset['focused'] === 'true')?.dataset['paneId'];

// -------------------------------------------------------- a projection, drawn

describe('App as a projection of main’s layout', () => {
  it('draws the tree main pushed, and never a tree of its own', () => {
    const { view, layout } = render();
    expect(paneIds(view.container)).toHaveLength(1);

    const three = threePaneTree();
    layout.push(snapshotOf(three.tree, three.bottomRight));

    expect(paneIds(view.container)).toEqual([three.left.id, three.topRight.id, three.bottomRight.id]);
    expect(focusedId(view.container)).toBe(three.bottomRight.id);
    // Two splits: the root row, and the column inside its right half.
    expect(all(view.container, 'split').map((el) => el.dataset['axis'])).toEqual(['row', 'column']);
    view.unmount();
  });

  it('subscribes before it asks, so a push mid-request is not lost', async () => {
    // The other order drops any change that lands while `layout:get` is in
    // flight, and the app then draws a tree one gesture old until something
    // unrelated happens to change.
    const layout = spyLayout(snapshotOf(leaf(makePane({ userTitle: 'stale' }))));
    const three = threePaneTree();

    const view = mount(
      <App terminals={null} layout={layout.api} commands={spyCommands().api} />,
    );
    // A listener exists already — before any answer could have arrived.
    expect(layout.listeners).toBe(1);
    layout.push(snapshotOf(three.tree, three.left));
    await act(async () => undefined);

    // The newer push wins over the older `get`.
    expect(paneIds(view.container)).toHaveLength(3);
    view.unmount();
  });

  it('unsubscribes on unmount', () => {
    const { view, layout } = render();
    expect(layout.listeners).toBe(1);
    view.unmount();
    expect(layout.listeners).toBe(0);
  });

  it('renders nothing rather than inventing a layout before main answers', () => {
    // `snapshot === null` is the only empty state there is: core leaves the tree
    // intact when the last pane closes and closes the window instead, so a
    // zero-pane projection never arrives.
    const { view } = render({ snapshot: null });
    expect(all(view.container, 'pane')).toHaveLength(0);
    // The titlebar says the app's name in the one moment that is honest — there
    // is nothing to be in yet.
    expect(view.container.textContent).toContain('Shepherd');
    view.unmount();
  });
});

// ------------------------------------------------------------- a transport

describe('App as a transport into the one funnel', () => {
  /**
   * The chrome no longer carries SPLIT/CLOSE buttons.
   *
   * They were M0 scaffolding, and a strip of them across the top is what made
   * the app read as its own test harness. The gestures did not go anywhere —
   * they are menu items with accelerators, dispatched through `MENU_INVOCATIONS`
   * and asserted end to end in `menu-dispatch.test.ts` against a real
   * `LayoutStore`. What is asserted HERE is that the page does not grow a second
   * route to them: the only invocations it makes are the two gestures with no
   * menu item of their own.
   */
  it('offers no toolbar of layout buttons — the menu owns those gestures', () => {
    const { view } = render();
    const labels = [...view.container.querySelectorAll('button')].map((button) => button.textContent);
    expect(labels).not.toContain('SPLIT RIGHT');
    expect(labels).not.toContain('CLOSE PANE');
    view.unmount();
  });

  it('the menu table still resolves the gestures the chrome dropped', () => {
    // The claim the deleted button test was really making: a menu item and the
    // kernel verb cannot drift, because one table maps them.
    expect(MENU_INVOCATIONS[COMMANDS.splitRight]).toEqual({
      command: LAYOUT_COMMANDS.split,
      args: { axis: 'row' },
    });
    expect(MENU_INVOCATIONS[COMMANDS.closePane]).toEqual({ command: LAYOUT_COMMANDS.close, args: {} });
  });

  it('clicking a pane asks core to focus it, rather than moving a local ring', () => {
    const three = threePaneTree();
    const { view, commands } = render({ snapshot: snapshotOf(three.tree, three.left) });

    act(() =>
      all(view.container, 'pane')[2]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })),
    );

    expect(commands.calls).toEqual([
      { command: LAYOUT_COMMANDS.focusPane, args: { pane: three.bottomRight.id } },
    ]);
    // Still on the old pane until main says otherwise.
    expect(focusedId(view.container)).toBe(three.left.id);
    view.unmount();
  });

  it('reports a failed command instead of a gesture that silently did nothing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const session = new SpySession();
      const registry = new PaneSessionRegistry({
        session,
        createTerminal: fakeTerminal,
        spec: (pane) => ({ paneId: pane.id }),
      });
      // Through a gesture the chrome still has: clicking a pane asks core to
      // focus it. The claim is about the FAILURE reaching a log rather than the
      // particular verb — a refused command that reports nothing is the silent
      // no-op this codebase refuses everywhere else.
      const three = threePaneTree();
      const view = mount(
        <App
          terminals={registry}
          layout={spyLayout(snapshotOf(three.tree, three.left)).api}
          commands={{
            invoke: () =>
              Promise.resolve({ ok: false, error: { code: 'denied', message: 'nope' } }),
            list: () => Promise.resolve({ ok: true as const, value: [] }),
          }}
          initialSnapshot={snapshotOf(three.tree, three.left)}
        />,
      );
      act(() =>
        all(view.container, 'pane')[2]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })),
      );
      await act(async () => undefined);

      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0]?.[0])).toContain('nope');
      view.unmount();
    } finally {
      errors.mockRestore();
    }
  });
});

// ------------------------------------------------------- the pushed viewport

describe('the viewport the renderer publishes', () => {
  it('pushes a rect on mount and again on every resize', () => {
    const observers: Array<() => void> = [];
    const original = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    class FakeResizeObserver {
      constructor(callback: () => void) {
        observers.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    }
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
    try {
      // No terminals: `TerminalPane` observes its own host for re-fitting, so a
      // rendered pane would put a second, unrelated callback in this list and the
      // test would be asserting about whichever one happened to be first.
      const { view, layout } = render({ noTerminals: true });
      // Core has no DOM and `neighbor` needs a rect, so without this push main's
      // viewport stays 0×0, every frame is degenerate, and ⌘⌥← answers null for
      // every direction — a focus command that does nothing, silently.
      expect(layout.viewports).toHaveLength(1);
      expect(layout.viewports[0]).toEqual({ x: 0, y: 0, width: 0, height: 0 });

      expect(observers).toHaveLength(1);
      act(() => observers[0]?.());
      expect(layout.viewports).toHaveLength(2);
      view.unmount();
    } finally {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = original;
    }
  });

  it('still pushes once where there is no ResizeObserver at all', () => {
    // jsdom has none. The guard exists so a layout test does not need a polyfill
    // to say what it is about — and the mount-time push must survive it.
    const { view, layout } = render();
    expect(layout.viewports).toHaveLength(1);
    view.unmount();
  });
});

// -------------------------------------- what happens to a pane's terminal

describe('terminals across a reshape', () => {
  it('a leaf becoming a split does NOT rebuild the existing pane’s terminal', async () => {
    // Finding G, as the count that matters. React must remount `TerminalPane`
    // here — the pane was the root and is now a grandchild, and no key can move a
    // component across a change of depth — so the claim is not "no remount", it is
    // that a remount costs one `appendChild` and NO xterm. That is what makes the
    // reshape harmless, and it is v1's `makeNSView` count in another language.
    const a = makePane({ userTitle: 'a' });
    const { view, layout, built, registry } = render({ snapshot: snapshotOf(leaf(a)) });
    await registry.settled();
    expect(built).toHaveLength(1);
    const first = built[0];

    const b = makePane({ userTitle: 'b' });
    layout.push(snapshotOf(split('row', 0.5, leaf(a), leaf(b)), b));
    await registry.settled();

    expect(paneIds(view.container)).toEqual([a.id, b.id]);
    // Two panes, two terminals — a's was never rebuilt, and never disposed.
    expect(built).toHaveLength(2);
    expect(built[0]).toBe(first);
    expect(first?.disposed).toBe(false);
    // …and the screen it had accumulated is still the same object's.
    expect(registry.inspect(a.id)?.sessionId).toBe('s1');
    view.unmount();
  });

  it('a push that only renames a pane rebuilds nothing', async () => {
    const a = makePane({ userTitle: 'a' });
    const { view, layout, built, registry } = render({ snapshot: snapshotOf(leaf(a)) });
    await registry.settled();

    layout.push(snapshotOf(leaf({ ...a, title: 'vim' })));
    await registry.settled();

    // Every push is a fresh structure clone, so `pane` is a new object each time.
    // `TerminalPane`'s effect keys off `pane.id` precisely so an OSC title cannot
    // throw the terminal away.
    expect(built).toHaveLength(1);
    expect(built[0]?.disposed).toBe(false);
    view.unmount();
  });

  it('a pane that leaves the tree gives up its terminal — and is not killed here', async () => {
    const three = threePaneTree();
    const { view, layout, built, session, registry } = render({
      snapshot: snapshotOf(three.tree, three.left),
    });
    await registry.settled();
    expect(built).toHaveLength(3);
    session.calls.length = 0;

    // Main closed the left pane: it killed the session and pushed this.
    layout.push(snapshotOf(split('column', 0.5, leaf(three.topRight), leaf(three.bottomRight))));
    await registry.settled();

    expect(paneIds(view.container)).toEqual([three.topRight.id, three.bottomRight.id]);
    expect(registry.inspect(three.left.id)).toBeUndefined();
    expect(built[0]?.disposed).toBe(true);
    // THE assertion: the renderer does not kill. Core did, before this snapshot
    // was even built — a kill from here would be a guaranteed second one.
    expect(session.names).not.toContain('kill');
    // The survivors are reshuffled by React (a grandchild became a child) and
    // keep their terminals through it: detach, attach, no rebuild.
    expect(built).toHaveLength(3);
    expect(built[1]?.disposed).toBe(false);
    view.unmount();
  });

  it('unmounting the whole app detaches every pane and kills nothing', async () => {
    const three = threePaneTree();
    const { view, session, registry } = render({ snapshot: snapshotOf(three.tree, three.left) });
    await registry.settled();
    session.calls.length = 0;

    view.unmount();
    await registry.settled();

    expect(session.names).not.toContain('kill');
  });

  it('mounts one terminal host per leaf', () => {
    const three = threePaneTree();
    const { view } = render({ snapshot: snapshotOf(three.tree, three.left) });
    expect(all(view.container, 'terminal-host')).toHaveLength(3);
    view.unmount();
  });
});

// -------------------------------------------------- several roots, one visible

describe('roots the window switches between', () => {
  it('mounts every root and shows only the active one', () => {
    // A flat keyed list with the inactive ones hidden, NEVER a conditional
    // mount: unrendering a root tears its panes down, and a torn-down pane is a
    // released terminal. v1's `_ConditionalContent` lesson, one language over.
    const home = makePane({ userTitle: 'home' });
    const task = makePane({ userTitle: 'task' });
    const { view } = render({
      snapshot: snapshotsOf('window-1', rootOf(leaf(home)), rootOf(leaf(task), task, 'task-1')),
    });

    // Both trees are in the DOM…
    expect(paneIds(view.container)).toEqual([home.id, task.id]);
    // …and exactly one of them is on screen.
    const roots = [...view.container.querySelectorAll<HTMLElement>('.sh-root')];
    expect(roots.map((el) => el.dataset['root'])).toEqual(['window-1', 'task-1']);
    expect(roots.map((el) => el.style.display)).toEqual(['flex', 'none']);
    view.unmount();
  });

  it('gives the hidden root no focused pane, so it cannot steal the keyboard', () => {
    // `TerminalPane` calls `terminals.focus()` for whichever pane it is told is
    // focused. With every root mounted, a hidden root's focused pane would fight
    // the visible one for the keyboard on every render.
    const home = makePane({ userTitle: 'home' });
    const task = makePane({ userTitle: 'task' });
    const { view } = render({
      snapshot: snapshotsOf('window-1', rootOf(leaf(home)), rootOf(leaf(task), task, 'task-1')),
    });
    expect(focusedId(view.container)).toBe(home.id);
    expect(all(view.container, 'pane').filter((el) => el.dataset['focused'] === 'true')).toHaveLength(1);
    view.unmount();
  });

  it('suspends a hidden root’s panes without ever creating a second session', async () => {
    /**
     * THE multi-root trap, and what R0 changed about it.
     *
     * The invariant is unchanged and is the whole point: switching roots must
     * never create a second pty for a pane that already has one, leaving the
     * first running with nothing pointing at it — unkillable from the UI.
     *
     * What changed is the mechanism. The hidden root's panes used to keep a live
     * terminal and keep parsing forever, because a pane that stopped listening
     * could never catch up from a 256 KB ring. The host now holds the SCREEN, so
     * a hidden pane holds no terminal at all and is handed a correct repaint when
     * it comes back. So a terminal IS rebuilt on wake — and the session behind it
     * is adopted, not recreated, which is the claim that matters.
     */
    const home = makePane({ userTitle: 'home' });
    const task = makePane({ userTitle: 'task' });
    const both = (active: string): LayoutSnapshots =>
      snapshotsOf(active, rootOf(leaf(home)), rootOf(leaf(task), task, 'task-1'));

    const { view, layout, built, session, registry } = render({ snapshot: both('window-1') });
    await registry.settled();

    // Only the visible root built a terminal. The hidden one costs a session id.
    expect(built).toHaveLength(1);
    expect(registry.inspect(task.id)?.suspended).toBe(true);
    expect(registry.inspect(task.id)?.streaming).toBe(false);
    session.calls.length = 0;

    layout.push(both('task-1'));
    await registry.settled();
    layout.push(both('window-1'));
    await registry.settled();

    // Each pane woke into a fresh terminal…
    expect(registry.inspect(home.id)?.suspended).toBe(false);
    expect(registry.inspect(task.id)?.suspended).toBe(true);
    // …and NOT a fresh session. This is the assertion the whole test is for.
    expect(session.names).not.toContain('create');
    expect(session.names).not.toContain('kill');
    expect(registry.inspect(home.id)?.sessionId).toBe('s1');
    expect(registry.inspect(task.id)?.sessionId).toBe('s2');
    view.unmount();
  });

  it('still releases a pane that really has left every root', async () => {
    // The negative control for the union above: widening "present" must not
    // widen it to everything, or a closed pane's terminal leaks forever.
    const home = makePane({ userTitle: 'home' });
    const gone = makePane({ userTitle: 'gone' });
    const { view, layout, registry } = render({
      snapshot: snapshotsOf('window-1', rootOf(leaf(home)), rootOf(leaf(gone), gone, 'task-1')),
    });
    await registry.settled();
    // Suspended, not released — it is hidden, but it is still in a root.
    expect(registry.inspect(gone.id)?.suspended).toBe(true);

    layout.push(snapshotsOf('window-1', rootOf(leaf(home))));
    await registry.settled();

    // Now it has left every root, and `release` drops it from the registry
    // entirely. Suspension must never be mistaken for removal: a suspended pane
    // still answers `inspect`, and this one no longer does.
    expect(registry.inspect(gone.id)).toBeUndefined();
    view.unmount();
  });

  it('names the ACTIVE root\'s focused pane, not one behind it', () => {
    // A pane count used to live here and it counted what you can already see.
    // What the titlebar carries now is where you ARE, and the claim worth
    // pinning is the same one: it reads from the active root, so a hidden root's
    // focused pane can never be what the window says you are looking at.
    const home = makePane({ userTitle: 'home' });
    const task = makePane({ userTitle: 'task' });
    const { view } = render({
      snapshot: snapshotsOf(
        'window-1',
        rootOf(leaf(home)),
        rootOf(split('row', 0.5, leaf(task), leaf(makePane({}))), task, 'task-1'),
      ),
    });
    // The TITLEBAR's text, not the document's: every root stays mounted by
    // design, so the hidden root's pane is legitimately in the DOM — asserting
    // over the whole container would be asserting that the mount rule is
    // broken.
    const crumb = view.container.querySelector('.sh-crumb')?.textContent ?? '';
    expect(crumb).toContain('home');
    expect(crumb).not.toContain('task');
    view.unmount();
  });

  it('re-publishes the viewport when the active root changes', () => {
    // The rect is stored PER ROOT and main applies it to whichever is active, so
    // a root that has never been on screen would keep a 0x0 viewport — every
    // pane frame degenerate and ⌘⌥← answering null in every direction, silently.
    const home = makePane({ userTitle: 'home' });
    const task = makePane({ userTitle: 'task' });
    const both = (active: string): LayoutSnapshots =>
      snapshotsOf(active, rootOf(leaf(home)), rootOf(leaf(task), task, 'task-1'));

    const { view, layout } = render({ snapshot: both('window-1'), noTerminals: true });
    expect(layout.viewports).toHaveLength(1);

    layout.push(both('task-1'));
    expect(layout.viewports).toHaveLength(2);

    // A push that does NOT change which root is active must not re-publish: the
    // rect has not changed, and a push per snapshot would be one per keystroke.
    layout.push(both('task-1'));
    expect(layout.viewports).toHaveLength(2);
    view.unmount();
  });
});

/**
 * The stage with nothing on it — and it is REACHABLE now.
 *
 * A root can hold no panes: closing the last pane of the home root empties it
 * rather than closing the window, so `tree: null` is a real projection. Before
 * this the only empty state was `snapshots === null`, the instant before main's
 * first push — a state nobody could see, which is why the component had no CSS
 * anywhere in the repo and nobody had noticed.
 */
describe('the empty state', () => {
  const paneless = (root = 'window-1'): LayoutSnapshot => ({
    root,
    tree: null,
    focusedPaneId: null,
    zoomedPaneId: null,
    sessions: {},
  });

  it('draws before main answers, as it always did', () => {
    const { view } = render({ snapshot: null });
    expect(all(view.container, 'empty-state')).toHaveLength(1);
    expect(all(view.container, 'pane')).toHaveLength(0);
    view.unmount();
  });

  /**
   * MUTATION TARGET. Reverting the render gate to `snapshots === null` — its
   * shipped condition — passes the test above and every other test in this file,
   * and fails only here. That is the whole bug: the state existed in the
   * component and could not be reached from the app.
   */
  it('draws when the ACTIVE root holds no panes', () => {
    const { view } = render({ snapshot: { active: 'window-1', roots: [paneless()] } });
    expect(all(view.container, 'empty-state')).toHaveLength(1);
    expect(all(view.container, 'pane')).toHaveLength(0);
    view.unmount();
  });

  it('does not draw while the active root still has one', () => {
    const { view } = render({ snapshot: snapshotOf(leaf(makePane({}))) });
    expect(all(view.container, 'empty-state')).toHaveLength(0);
    view.unmount();
  });

  it('follows the ACTIVE root, not any root', () => {
    // A hidden root running out of panes is not this window being empty.
    const three = threePaneTree();
    const { view } = render({
      snapshot: snapshotsOf('window-1', rootOf(three.tree, three.left), paneless('task-1')),
    });
    expect(all(view.container, 'empty-state')).toHaveLength(0);
    view.unmount();
  });

  it('keeps every other root mounted while it draws', () => {
    // The hidden roots must not be torn down: a torn-down pane comes back as a
    // second pty, which is v1-s recorded lesson and this file-s standing rule.
    const three = threePaneTree();
    const { view } = render({
      snapshot: snapshotsOf('window-1', paneless(), rootOf(three.tree, three.left, 'task-1')),
    });
    expect(all(view.container, 'empty-state')).toHaveLength(1);
    expect(all(view.container, 'pane')).toHaveLength(3);
    view.unmount();
  });
});

/**
 * ⌘K — the palette, and the kernel-s own command registry behind it.
 *
 * M1 gave every command a `title` documented as "shown in the palette" and there
 * was no palette, so `layout.zoom`, `layout.rename` and every `tasks.*` verb had
 * a user-facing name and no way for a user to say it.
 */
describe('the command palette', () => {
  const press = (key: string, init: KeyboardEventInit = {}): void => {
    act(() =>
      void window.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
      ),
    );
  };

  const items = (): HTMLElement[] => [
    ...document.querySelectorAll<HTMLElement>('[data-testid="palette-item"]'),
  ];

  function palette(listed: readonly { id: string; title: string }[]) {
    const calls: Array<{ command: string; args: unknown }> = [];
    const api: CommandsApi = {
      invoke: (command, args) => {
        calls.push({ command, args });
        return Promise.resolve({ ok: true as const, value: undefined });
      },
      list: () => Promise.resolve({ ok: true as const, value: listed }),
    };
    const view = mount(
      <App terminals={null} layout={null} commands={api} initialSnapshot={snapshotOf(leaf(makePane({})))} />,
    );
    return { view, calls };
  }

  const LISTED = [
    { id: 'layout.zoom', title: 'Toggle Zoom' },
    { id: 'layout.rename', title: 'Rename Pane' },
    { id: 'tasks.create', title: 'Tasks: New Task' },
  ];

  it('is closed until ⌘K, and closes on a second one', async () => {
    const { view } = palette(LISTED);
    expect(document.querySelector('[data-testid="palette-input"]')).toBeNull();

    press('k', { metaKey: true });
    await act(async () => undefined);
    expect(document.querySelector('[data-testid="palette-input"]')).not.toBeNull();

    press('k', { metaKey: true });
    await act(async () => undefined);
    expect(document.querySelector('[data-testid="palette-input"]')).toBeNull();
    view.unmount();
  });

  it('ignores a plain k, and ⌥⌘K', () => {
    const { view } = palette(LISTED);
    press('k');
    press('k', { metaKey: true, altKey: true });
    expect(document.querySelector('[data-testid="palette-input"]')).toBeNull();
    view.unmount();
  });

  it('lists exactly what the registry offered', async () => {
    // The filter is main-s (`command:list` returns only titled commands); the
    // page draws what it is given rather than deciding again.
    const { view } = palette(LISTED);
    press('k', { metaKey: true });
    await act(async () => undefined);
    expect(items().map((item) => item.dataset.commandId)).toEqual([
      'layout.zoom',
      'layout.rename',
      'tasks.create',
    ]);
    view.unmount();
  });

  /**
   * MUTATION TARGET. Running a palette entry through `views.activate` — the seam
   * a tree row uses — would still run the command and still close the palette.
   * It would run it as an EXTENSION. Here the user typed the command-s own name
   * and can see what they are running, so `commands.invoke` (which main
   * attributes to `{kind:"user"}`) is the correct and different answer.
   */
  it('runs the chosen command through commands.invoke, attributed as the user', async () => {
    const { view, calls } = palette(LISTED);
    press('k', { metaKey: true });
    await act(async () => undefined);

    act(() => items()[1]?.click());
    await act(async () => undefined);

    expect(calls).toEqual([{ command: 'layout.rename', args: {} }]);
    // And it closed itself: a palette still on screen over the thing it just did
    // is a palette you have to dismiss twice.
    expect(document.querySelector('[data-testid="palette-input"]')).toBeNull();
    view.unmount();
  });

  it('fetches the list every time it opens, not once on mount', async () => {
    // An extension activating later registers more commands; a list taken at
    // first paint would be short by exactly the ones a user is looking for.
    let asked = 0;
    const api: CommandsApi = {
      invoke: () => Promise.resolve({ ok: true as const, value: undefined }),
      list: () => {
        asked += 1;
        return Promise.resolve({ ok: true as const, value: LISTED });
      },
    };
    const view = mount(
      <App terminals={null} layout={null} commands={api} initialSnapshot={snapshotOf(leaf(makePane({})))} />,
    );
    await act(async () => undefined);
    expect(asked).toBe(0);

    press('k', { metaKey: true });
    await act(async () => undefined);
    expect(asked).toBe(1);

    press('k', { metaKey: true });
    press('k', { metaKey: true });
    await act(async () => undefined);
    expect(asked).toBe(2);
    view.unmount();
  });
});

// ------------------------------------------------------------------ helpers

function clickButton(container: HTMLElement, label: string): void {
  const button = [...container.querySelectorAll('button')].find((el) => el.textContent === label);
  if (button === undefined) throw new Error(`no button labelled ${label}`);
  act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}
