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
  type AgentIndicatorDTO,
  type AgentsApi,
  type ViewsApi,
  type CommandID,
  type CommandsApi,
  type LayoutApi,
  type LayoutSnapshot,
} from '../shared/index.ts';
import { MENU_INVOCATIONS } from '../shared/menu-commands.ts';
import { ViewDock } from './view-dock.tsx';
import { ViewOverlay } from './view-overlay.tsx';
import { useContributions } from './contributions.ts';
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
  /** Agent state per session. Null with no bridge — panes then show no badge. */
  readonly agents?: AgentsApi | null;
  /** Contributed views (M3). Absent = no dock, not a crash. */
  readonly views?: ViewsApi | null;
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
  agents: agentsApi = null,
  views: viewsApi = null,
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

  /**
   * Agent state per session, pulled once and then followed.
   *
   * The same shape as the layout, for the same reason: a push-only channel
   * leaves a renderer that mounted after the last transition showing nothing —
   * and with HMR that is every reload, not an edge case.
   */
  const [agents, setAgents] = useState<Readonly<Record<string, AgentIndicatorDTO>>>({});
  useEffect(() => {
    if (agentsApi === null) return;
    const index = (list: readonly AgentIndicatorDTO[]): Readonly<Record<string, AgentIndicatorDTO>> =>
      Object.fromEntries(list.map((indicator) => [indicator.sessionId, indicator]));
    // Follow first, then pull — so a transition landing between the two is not
    // overwritten by a snapshot taken before it.
    const off = agentsApi.onChanged((list) => setAgents(index(list)));
    let live = true;
    void agentsApi.get().then((result) => {
      if (!live || !result.ok) return;
      // Merge under, never over: anything the subscription already delivered is
      // newer than this snapshot by construction.
      setAgents((current) => ({ ...index(result.value), ...current }));
    });
    return () => {
      live = false;
      off();
    };
  }, [agentsApi]);

  const renderPane = useCallback(
    (pane: Pane, focused: boolean): ReactNode => {
      if (terminals === null) return null;
      // A pane shows a session; a session may have an agent. Both hops can be
      // absent, and an absent one renders the empty slot rather than no slot.
      const sessionId = snapshot?.sessions[pane.id];
      const agent = sessionId === undefined ? undefined : agents[sessionId];
      return (
        <TerminalPane
          pane={pane}
          terminals={terminals}
          focused={focused}
          {...(agent === undefined ? {} : { agentState: agent.state })}
          {...(agent?.reason === undefined ? {} : { agentReason: agent.reason })}
        />
      );
    },
    [terminals, snapshot, agents],
  );

  const paneCount = snapshot === null ? 0 : leafIds(snapshot.tree).length;

  const contributions = useContributions(viewsApi);
  /** Every accelerator an overlay declared, for the footer's keycap strip. */
  const raisable = contributions.filter((view) => view.surface === 'overlay' && view.key !== undefined);

  return (
    <div className="sh-app">
      {/*
        The spec plate, not a toolbar. Splitting and closing panes are menu
        commands with accelerators (⌘D / ⌘⇧D / ⌘W) — buttons for them were
        scaffolding from M0, and a row of debug buttons across the top is the
        thing that makes an app look like its own test harness.
      */}
      <header className="sh-plate">
        <span className="sh-brand">SHEPHERD</span>
        <span className="sh-plate-spacer" />
        <span className="sh-plate-cell">
          PANES <b>{String(paneCount).padStart(2, '0')}</b>
        </span>
        {terminals === null && <span className="sh-plate-cell is-ember">NO BRIDGE</span>}
      </header>

      <div className="sh-body">
        <ViewDock
          views={viewsApi}
          footer={
            <>
              {raisable.map((view) => (
                <span className="sh-key" key={view.type}>
                  {accelLabel(view.key ?? '')} {(view.title ?? view.type).toUpperCase()}
                </span>
              ))}
            </>
          }
        />
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

      <footer className="sh-status">
        {STATUS_CELLS.map((cell) => {
          const count = Object.values(agents).filter((agent) => agent.state === cell.state).length;
          return count === 0 ? null : (
            <span className="sh-status-cell" key={cell.state}>
              <i className="sh-dot" data-tint={cell.tint} /> {count} {cell.label}
            </span>
          );
        })}
        <span className="sh-plate-spacer" />
        <span className="sh-status-cell">{contributions.length} VIEWS</span>
      </footer>

      <ViewOverlay views={contributions} bridge={viewsApi} />
    </div>
  );
}

/**
 * `CmdOrCtrl+T` → `⌘T`. Presentation only: the accelerator itself is matched
 * against the real modifiers, never against this string.
 */
function accelLabel(accelerator: string): string {
  return accelerator
    .split('+')
    .map((part) => {
      const key = part.trim().toLowerCase();
      if (key === 'cmdorctrl' || key === 'commandorcontrol' || key === 'cmd' || key === 'command') return '⌘';
      if (key === 'ctrl' || key === 'control') return '⌃';
      if (key === 'alt' || key === 'option') return '⌥';
      if (key === 'shift') return '⇧';
      return part.toUpperCase();
    })
    .join('');
}

/**
 * The status bar's cells — the flock at a glance, in the ranking v1's aggregate
 * dot used: what needs you, then what is moving. A cell with a count of zero is
 * absent rather than a `0`, because a status bar full of zeroes reads as noise.
 */
const STATUS_CELLS: readonly { state: string; label: string; tint: string }[] = [
  { state: 'blocked', label: 'BLOCKED', tint: 'hay' },
  { state: 'error', label: 'ERROR', tint: 'ember' },
  { state: 'needs-check', label: 'DONE', tint: 'pasture' },
  { state: 'working', label: 'WORKING', tint: 'cobalt' },
];
