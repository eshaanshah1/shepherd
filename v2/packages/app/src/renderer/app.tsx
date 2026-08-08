import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { IconPlus } from '@tabler/icons-react';
import { paneId, type PaneID } from '@shepherd/sdk';
import { IconButton } from '@shepherd/ui';
import {
  LAYOUT_COMMANDS,
  findPane,
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
  type LayoutSnapshots,
} from '../shared/index.ts';
import { MENU_INVOCATIONS } from '../shared/menu-commands.ts';
import { EmptyState } from './empty-state.tsx';
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
  readonly initialSnapshot?: LayoutSnapshots;
  /**
   * Diagnostics seam: the smoke reads the live projection through this.
   *
   * It receives the ACTIVE root's snapshot, not the envelope — what the smokes
   * assert about is what the window is showing, and that is one root whether or
   * not others exist behind it.
   */
  readonly onSnapshot?: (snapshot: LayoutSnapshot) => void;
}

/** A one-root, one-pane projection, for a page with no main process behind it. */
export function placeholderSnapshots(tree: SplitNode = leaf(makePane({}))): LayoutSnapshots {
  return {
    active: 'window-1',
    roots: [
      {
        root: 'window-1',
        tree,
        focusedPaneId: leafIds(tree)[0] ?? null,
        zoomedPaneId: null,
        sessions: {},
      },
    ],
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
  const [snapshots, setSnapshots] = useState<LayoutSnapshots | null>(initialSnapshot ?? null);
  const stageRef = useRef<HTMLElement>(null);

  /**
   * The root on screen. Every other root stays mounted and hidden — see the
   * stage below, and `LayoutSnapshots` for why that is not an optimisation.
   */
  const active = useMemo(
    () => snapshots?.roots.find((root) => root.root === snapshots.active) ?? null,
    [snapshots],
  );

  useEffect(() => {
    if (active !== null) onSnapshot?.(active);
  }, [active, onSnapshot]);

  // Subscribe FIRST, then ask. The other order drops any change that lands while
  // the request is in flight, and the app would then draw a tree one gesture old
  // until the next unrelated change happened to arrive.
  useEffect(() => {
    if (layout === null) return;
    const off = layout.onChanged(setSnapshots);
    void layout.get().then((result) => {
      // `prev ?? value` rather than an assignment: if a push has already arrived
      // it is strictly newer than this answer, and overwriting it would undo a
      // gesture that has already happened.
      if (result.ok) setSnapshots((prev) => prev ?? result.value);
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
    // `snapshots?.active` is a dependency because the rect is stored PER ROOT and
    // main applies it to whichever is active. A root that has never been on
    // screen would otherwise keep a 0x0 viewport, every pane frame would be
    // degenerate, and ⌘⌥← would answer null in every direction — silently.
    // Measuring the shared stage is correct for all of them: they are drawn into
    // the same box, and the hidden ones measure 0x0 because they are hidden.
  }, [layout, snapshots?.active]);

  // --- a pane that has left the tree takes its terminal with it.
  //
  // The session is already gone — core's `layout.close` killed it (see
  // `pane-sessions.ts`). What is left is this renderer's xterm, which nothing else
  // would ever drop: React unmounts the view, and unmounting only ever detaches.
  //
  // "Absent" means absent from the UNION of every root, never from the one on
  // screen. With several roots mounted, reading only the active one would
  // release the hidden roots' terminals on every switch — and switching back
  // would then build a SECOND pty per pane while the first kept running with
  // nothing pointing at it, which is unkillable from the UI. This is v1's
  // remount lesson arriving through a different door.
  const knownPanes = useRef<readonly PaneID[]>([]);
  useEffect(() => {
    if (snapshots === null) return;
    const present = snapshots.roots.flatMap((root) => leafIds(root.tree));
    for (const paneId of knownPanes.current) {
      if (!present.includes(paneId)) terminals?.release(paneId);
    }
    knownPanes.current = present;
  }, [snapshots, terminals]);

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

  /**
   * paneId -> sessionId across EVERY root. Pane ids are unique across roots (one
   * store mints them all), so one flat map answers for whichever root is being
   * drawn — and a hidden root's panes keep their session badge for free.
   */
  const sessionsByPane = useMemo(() => {
    const merged: Record<string, string> = {};
    for (const root of snapshots?.roots ?? []) Object.assign(merged, root.sessions);
    return merged;
  }, [snapshots]);

  const renderPane = useCallback(
    (pane: Pane, focused: boolean): ReactNode => {
      if (terminals === null) return null;
      // A pane shows a session; a session may have an agent. Both hops can be
      // absent, and an absent one renders the empty slot rather than no slot.
      const sessionId = sessionsByPane[pane.id];
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
    [terminals, sessionsByPane, agents],
  );


  /**
   * Where you are: the focused pane's own name, and the path under it.
   *
   * Read off the pane rather than off the task list, because the renderer knows
   * nothing about tasks — `tasks` sets a pane's `userTitle` when it spawns
   * (`Ship the login fix · api`), so the name the pane carries IS the task's,
   * with no coupling in this file. A window with no snapshot yet says the app's
   * name, which is the one moment that is honest.
   */
  const focused = active === null || active.focusedPaneId === null
    ? null
    : findPane(active.tree, paneId(active.focusedPaneId));
  // A pane nobody named shows its path where the name would be, rather than a
  // placeholder: "Untitled" tells you nothing, and a plain shell in ~/dev is a
  // thing you can recognise.
  const named = focused?.userTitle ?? (focused?.title === '' ? null : focused?.title) ?? null;
  const where = focused?.cwd === null || focused?.cwd === undefined ? '' : shorten(focused.cwd);
  const crumb = {
    task: named ?? (where === '' ? 'Shepherd' : where),
    pane: named === null ? '' : where,
  };

  const contributions = useContributions(viewsApi);
  /** Every accelerator an overlay declared, for the footer's keycap strip. */
  const raisable = contributions.filter((view) => view.surface === 'overlay' && view.key !== undefined);

  return (
    <div className="sh-app">
      {/*
        The window's OWN titlebar (`titleBarStyle: 'hiddenInset'`), carrying the
        traffic lights and a breadcrumb — where you are, which is the one fact
        the sidebar cannot show while it is scrolled somewhere else.
        It said "SHEPHERD" before, under a native bar that also said Shepherd.
      */}
      <header className="sh-plate">
        <span className="sh-crumb">
          <span className="sh-crumb-task">{crumb.task}</span>
          {crumb.pane !== '' && (
            <>
              <span className="sh-crumb-sep" aria-hidden="true">
                /
              </span>
              <span className="sh-crumb-pane">{crumb.pane}</span>
            </>
          )}
        </span>
        <span className="sh-plate-spacer" />
        {/*
          A pane count was here and it counted what you can see. The one cell
          that survives is the one you CANNOT see: a renderer with no bridge
          looks like an app with no panes, and that is worth a word.
        */}
        {terminals === null && <span className="sh-plate-cell is-ember">NO BRIDGE</span>}
      </header>

      <div className="sh-body">
        <ViewDock
          views={viewsApi}
          actions={
            <>
              <span className="sh-side-title">Tasks</span>
              <span className="sh-plate-spacer" />
              {raisable.map((view) => (
                <IconButton
                  key={view.type}
                  icon={IconPlus}
                  size="sm"
                  // Required by the type, which is the whole point of the
                  // primitive: this control shipped as a bare `+` with no
                  // accessible name and — the spec's opening anecdote — no CSS
                  // at all.
                  label={view.title ?? view.type}
                  className="sh-side-add"
                  data-testid="raise-view"
                  data-view-type={view.type}
                  // The keystroke is in the tooltip, not painted next to the
                  // control: a button that already says what it does does not
                  // need to also teach its shortcut.
                  title={`${view.title ?? view.type} (${accelLabel(view.key ?? '')})`}
                  onClick={() => window.dispatchEvent(new CustomEvent('sh:raise-view', { detail: view.type }))}
                />
              ))}
            </>
          }
        />
        {/*
          Every root, mounted; one of them visible.

          A FLAT keyed list, never `active === root.root && <SplitView/>`. A
          conditional mount tears the hidden root's subtree down, and a torn-down
          pane is a released terminal and then — on the way back — a second pty.
          This is v1's `_ConditionalContent` lesson, and the reason the hidden
          roots are hidden with `display: none` rather than not rendered.
        */}
        <main className="sh-stage" ref={stageRef}>
          {/*
            The one empty state there is: the window before main's first push.
            Core keeps the tree intact when the last pane closes and closes the
            window instead, so a zero-pane projection never arrives — see
            `empty-state.tsx`. It renders no pane, which is what the null-snapshot
            test asserts.
          */}
          {snapshots === null && <EmptyState />}
          {(snapshots?.roots ?? []).map((root) => (
            <div
              className="sh-root"
              key={root.root}
              data-root={root.root}
              data-active={root.root === snapshots?.active}
              style={{ display: root.root === snapshots?.active ? 'flex' : 'none' }}
            >
              <SplitView
                tree={root.tree}
                // Only the visible root has a focused pane. `TerminalPane` calls
                // `terminals.focus()` for the pane it is told is focused, so a
                // hidden root would fight the one on screen for the keyboard.
                focusedPaneId={root.root === snapshots?.active ? root.focusedPaneId : null}
                // The two gestures with no menu item of their own. They name the
                // kernel's verb directly, off `LAYOUT_COMMANDS` rather than as a
                // string, for the same reason `menu-commands.ts` does.
                onFocusPane={(id) => invoke(LAYOUT_COMMANDS.focusPane, { pane: id })}
                onSetRatio={(path, ratio) =>
                  invoke(LAYOUT_COMMANDS.setRatio, { path: [...path], ratio, root: root.root })
                }
                {...(terminals === null ? {} : { renderPane })}
                home=""
              />
            </div>
          ))}
        </main>
      </div>

      <ViewOverlay views={contributions} bridge={viewsApi} />
    </div>
  );
}

/** `~/dev/shepherd/api` — a path in the width a titlebar has for one. */
function shorten(cwd: string): string {
  const home = '/Users/';
  const path = cwd.startsWith(home) ? `~/${cwd.split('/').slice(3).join('/')}` : cwd;
  const parts = path.split('/');
  return parts.length <= 4 ? path : `…/${parts.slice(-3).join('/')}`;
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
 * There is deliberately no status bar.
 *
 * The shell had one counting agent states, and it was the sidebar's own
 * information restated along the bottom edge — the dots are already there, in
 * the list the counts were about. A permanent band spent on a duplicate is the
 * "instrument panel for its own internals" the app kept drifting into.
 *
 * It stays POSSIBLE: `views.registerStatusItem` is declared in the SDK and
 * refuses with the milestone it lands in, so a status bar is a contribution
 * somebody makes, not a thing the shell decided everyone wants. That is the
 * distinction the whole extension model rests on — removing our own is not the
 * same as making it unbuildable.
 */
