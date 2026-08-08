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
function spyLayout(initial: LayoutSnapshot | null = null) {
  let listeners: Array<(snapshot: LayoutSnapshot) => void> = [];
  const viewports: ViewportRect[] = [];
  let answer = initial;

  return {
    viewports,
    get listeners() {
      return listeners.length;
    },
    /** What main would answer `layout:get` with. */
    set snapshot(next: LayoutSnapshot | null) {
      answer = next;
    },
    api: {
      get: (): Promise<IpcResult<LayoutSnapshot>> =>
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
    push: (snapshot: LayoutSnapshot) => {
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
    } satisfies CommandsApi,
  };
}

function snapshotOf(tree: SplitNode, focused?: Pane): LayoutSnapshot {
  return {
    root: 'window-1',
    tree,
    focusedPaneId: focused?.id ?? firstPaneId(tree),
    zoomedPaneId: null,
    sessions: {},
  };
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

function render(options: { snapshot?: LayoutSnapshot | null; noTerminals?: boolean } = {}): Rendered {
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
    expect(view.container.textContent).toContain('PANES');
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

// ------------------------------------------------------------------ helpers

function clickButton(container: HTMLElement, label: string): void {
  const button = [...container.querySelectorAll('button')].find((el) => el.textContent === label);
  if (button === undefined) throw new Error(`no button labelled ${label}`);
  act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}
