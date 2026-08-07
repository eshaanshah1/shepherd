import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { PaneID } from '@shepherd/sdk';
import {
  LAYOUT_COMMANDS,
  leaf,
  leafIds,
  makePane,
  type Pane,
  type SplitNode,
} from '@shepherd/core/layout';
import {
  COMMANDS,
  type CommandID,
  type CommandsApi,
  type LayoutApi,
  type LayoutSnapshot,
} from '../shared/index.ts';
import { MENU_INVOCATIONS } from '../shared/menu-commands.ts';
import { SplitView } from './split-view.tsx';
import { TerminalPane } from './terminal-pane.tsx';
import type { PaneTerminals } from './pane-sessions.ts';

/**
 * The shell: a **projection plus a transport.**
 *
 * M0 kept the layout here in a `useState<LayoutState>` and decided what ⌘D meant
 * in a `runCommand` next door. P4a moved both to the kernel, and what is left is
 * the two things a renderer is actually for:
 *
 *   - it draws `snapshot`, which main owns and pushes; and
 *   - it turns a gesture into `commands.invoke`, which is the same funnel the
 *     menu, the control socket and (later) an extension dispatch into.
 *
 * Nothing here computes a new tree. There is no local layout state to disagree
 * with main's, which is the point — a button and its accelerator are now the same
 * call rather than two implementations that happen to match.
 *
 * The one thing it still measures is the **viewport**, because core has no DOM and
 * `neighbor` needs a rect. Pushing it is what lets `layout.focusDirection` take no
 * rect argument and stay invokable from a CLI.
 */

export interface AppProps {
  /** Null when there is no preload bridge (a plain `vite` page): panes draw as cards. */
  readonly terminals: PaneTerminals | null;
  readonly layout: LayoutApi | null;
  readonly commands: CommandsApi | null;
  /** Rendered until (or instead of) main's first push. The no-bridge and test seam. */
  readonly initialSnapshot?: LayoutSnapshot;
  /** Diagnostics seam: the smoke reads the live projection through this. */
  readonly onSnapshot?: (snapshot: LayoutSnapshot) => void;
}

/** A one-pane projection, for a page with no main process behind it. */
export function placeholderSnapshot(tree: SplitNode = leaf(makePane({}))): LayoutSnapshot {
  return {
    root: 'window-1',
    tree,
    focusedPaneId: leafIds(tree)[0] ?? null,
    zoomedPaneId: null,
    sessions: {},
  };
}

export function App({
  terminals,
  layout,
  commands,
  initialSnapshot,
  onSnapshot,
}: AppProps): ReactNode {
  const [snapshot, setSnapshot] = useState<LayoutSnapshot | null>(initialSnapshot ?? null);
  const stageRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (snapshot !== null) onSnapshot?.(snapshot);
  }, [snapshot, onSnapshot]);

  // Subscribe FIRST, then ask. The other order drops any change that lands while
  // the request is in flight, and the app would then draw a tree one gesture old
  // until the next unrelated change happened to arrive.
  useEffect(() => {
    if (layout === null) return;
    const off = layout.onChanged(setSnapshot);
    void layout.get().then((result) => {
      // `prev ?? value` rather than an assignment: if a push has already arrived
      // it is strictly newer than this answer, and overwriting it would undo a
      // gesture that has already happened.
      if (result.ok) setSnapshot((prev) => prev ?? result.value);
    });
    return off;
  }, [layout]);

  /** Every gesture, as one call into the kernel's verb table. */
  const invoke = useCallback(
    (command: string, args: Readonly<Record<string, unknown>>) => {
      if (commands === null) return;
      void commands.invoke(command, args).then((result) => {
        // A command that failed must not fail silently: with the layout owned a
        // process away, "the button did nothing" has no other way to be seen.
        if (!result.ok) console.error(`[shepherd] ${command}: ${result.error.message}`);
      });
    },
    [commands],
  );

  /** A chrome gesture named the way the menu names it. One table, `menu-commands.ts`. */
  const runMenuCommand = useCallback(
    (id: CommandID) => {
      const invocation = MENU_INVOCATIONS[id];
      invoke(invocation.command, invocation.args);
    },
    [invoke],
  );

  // --- the pushed viewport (finding E).
  useEffect(() => {
    const stage = stageRef.current;
    if (layout === null || stage === null) return;
    const publish = (): void => {
      const box = stage.getBoundingClientRect();
      // Origin 0,0 deliberately: `neighbor` only ever compares frames within this
      // rect, so the window's position on screen is not part of the question.
      void layout.setViewport({ x: 0, y: 0, width: box.width, height: box.height });
    };
    publish();
    // Guarded because jsdom has none, and a layout test must not need a polyfill
    // to say what it is about. The same guard `terminal-pane.tsx` carries.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(publish);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [layout]);

  // --- a pane that has left the tree takes its terminal with it.
  //
  // The session is already gone — core's `layout.close` killed it (see
  // `pane-sessions.ts`). What is left is this renderer's xterm, which nothing else
  // would ever drop: React unmounts the view, and unmounting only ever detaches.
  const knownPanes = useRef<readonly PaneID[]>([]);
  useEffect(() => {
    if (snapshot === null) return;
    const present = leafIds(snapshot.tree);
    for (const paneId of knownPanes.current) {
      if (!present.includes(paneId)) terminals?.release(paneId);
    }
    knownPanes.current = present;
  }, [snapshot, terminals]);

  const renderPane = useCallback(
    (pane: Pane, focused: boolean): ReactNode =>
      terminals === null ? null : (
        <TerminalPane pane={pane} terminals={terminals} focused={focused} />
      ),
    [terminals],
  );

  const paneCount = snapshot === null ? 0 : leafIds(snapshot.tree).length;

  return (
    <div className="sh-app">
      <header className="sh-bar">
        <span className="sh-brand">SHEPHERD</span>
        <span className="sh-bar-sep" />
        <button
          className="sh-key"
          onClick={() => runMenuCommand(COMMANDS.splitRight)}
          type="button"
        >
          SPLIT RIGHT
        </button>
        <button className="sh-key" onClick={() => runMenuCommand(COMMANDS.splitDown)} type="button">
          SPLIT DOWN
        </button>
        <button className="sh-key" onClick={() => runMenuCommand(COMMANDS.closePane)} type="button">
          CLOSE PANE
        </button>
        <span className="sh-bar-spacer" />
        <span className="sh-plate">
          PANES · {paneCount}
          <span className="sh-plate-dim">{terminals === null ? ' / NO BRIDGE' : ''}</span>
        </span>
      </header>
      <main className="sh-stage" ref={stageRef}>
        {snapshot === null ? null : (
          <SplitView
            tree={snapshot.tree}
            focusedPaneId={snapshot.focusedPaneId}
            // The two gestures with no menu item of their own. They name the
            // kernel's verb directly, off `LAYOUT_COMMANDS` rather than as a
            // string, for the same reason `menu-commands.ts` does.
            onFocusPane={(id) => invoke(LAYOUT_COMMANDS.focusPane, { pane: id })}
            onSetRatio={(path, ratio) =>
              invoke(LAYOUT_COMMANDS.setRatio, { path: [...path], ratio })
            }
            {...(terminals === null ? {} : { renderPane })}
            home=""
          />
        )}
      </main>
    </div>
  );
}
