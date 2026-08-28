import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { paneId, type PaneID } from '@shepherd/sdk';
import type { ThemeMode } from '@shepherd/design-tokens';
import { CommandPalette, IconButton, TabStrip, type MarkState, type PaletteCommand } from '@shepherd/ui';
import {
  LAYOUT_COMMANDS,
  displayTitle,
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
  type SettingsApi,
  type ViewsApi,
  THEME_KEY,
  type CommandID,
  type CommandsApi,
  type LayoutApi,
  type LayoutSnapshot,
  type LayoutSnapshots,
} from '../shared/index.ts';
import { MENU_INVOCATIONS } from '../shared/menu-commands.ts';
import { ArchivedBanner } from './archived-banner.tsx';
import { EmptyState } from './empty-state.tsx';
import { FindBar } from './find-bar.tsx';
import { SkyStrip } from './sky-strip.tsx';
import { ViewDock, contributedIcon, raiseIcon } from './view-dock.tsx';
import { ViewOverlay } from './view-overlay.tsx';
import { ViewScreen } from './view-screen.tsx';
import { PaneKeys } from './pane-keys.ts';
import { SettingsScreen } from './settings-screen.tsx';
import { useContributions } from './contributions.ts';
import { useSetting } from './use-setting.ts';
import {
  DEFAULT_THEME_MODE,
  applyThemeVariables,
  resolveThemeMode,
  terminalBackground,
  watchPrefersDark,
} from './theme.ts';

import { SplitView } from './split-view.tsx';
import { TerminalPane } from './terminal-pane.tsx';
import { ExtensionPane } from './extension-pane.tsx';
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
  /** Settings. Absent = ⌘, draws nothing, not a crash. */
  readonly settings?: SettingsApi | null;
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
        group: 'window-1',
        tree,
        focusedPaneId: leafIds(tree)[0] ?? null,
        zoomedPaneId: null,
        sessions: {},
      },
    ],
  };
}

/**
 * A command id → the heading it sits under in ⌘K.
 *
 * Read off the id's NAMESPACE, which is the one thing every command already has
 * and nobody had to be asked for: `layout.split` is a layout verb because it
 * says so. The alternative — a `group` field on the command registration —
 * would make every extension declare a heading, and an extension's own opinion
 * about which of the shell's sections it belongs in is not one worth honouring.
 *
 * Only the two the design names get a heading. Anything else is drawn with none:
 * §6's refusal of "a badge pill on every count" is the same instinct — a heading
 * above a list of one is furniture pretending to be structure. `tasks.reveal` is
 * the exception inside `tasks`, because "jump to a task" is what the second
 * group IS.
 */
function paletteGroup(id: string): string | undefined {
  if (id.startsWith('layout.')) return 'Layout';
  if (id === 'tasks.reveal' || id.startsWith('window.')) return 'Jump to';
  return undefined;
}

/**
 * A layout verb's glyph, by id.
 *
 * Only the verbs that HAVE a picture of themselves get one — splitting and
 * zooming are shapes, and a magnifying glass beside "Close the pane" would be a
 * decoration standing in for a meaning. §1 gives `Jump to` rows state marks
 * instead, which the extension supplies as `mark`.
 */
function paletteIcon(id: string): string | undefined {
  if (id.includes('splitRight') || id.includes('split-right')) return 'split-right';
  if (id.includes('splitDown') || id.includes('split-down')) return 'split-down';
  if (id.includes('zoom')) return 'zoom';
  if (id.includes('close')) return 'close';
  return undefined;
}

/**
 * The agent lifecycle → the mark a tab wears, and the only place the two meet.
 *
 * `TabStrip` is a primitive and does not know what a session is, so the
 * translation lives here rather than in `@shepherd/ui`.
 *
 * **Every agent tab carries a mark, including a quiet one.** The state is the
 * tab's own — you cannot see the pane inside a tab you are not on, and a strip
 * where only trouble draws something makes "working" and "no agent here"
 * the same picture.
 *
 * **A tab with no agent carries nothing.** `shell` is a plain terminal and a
 * contributed view (a pull request, a diff) has no session at all; both fall
 * through to `undefined`, as does a word this build does not know. State belongs
 * to agents, and a ring on a pull-request tab would claim a lifecycle it has not
 * got.
 *
 * The order is v1's `AgentState.rollUp` unchanged — blocked > error > needsCheck
 * > working > idle. A tab shows one mark, so it must be the most actionable one:
 * anything else and a blocked pane hides behind a working sibling.
 */
const TAB_MARKS: readonly (readonly [state: string, mark: MarkState])[] = [
  ['blocked', 'waiting'],
  ['error', 'failed'],
  ['needsCheck', 'ready'],
  ['working', 'working'],
  ['idle', 'resting'],
];

function tabMark(states: readonly (string | undefined)[]): MarkState | undefined {
  const present = new Set(states);
  return TAB_MARKS.find(([state]) => present.has(state))?.[1];
}

/**
 * Grouped commands, in group order — headings are drawn where the group CHANGES,
 * so the list has to be sorted or a group appears twice.
 *
 * A stable sort within each group, so a command's position only depends on
 * where it already was. `Layout` first because it acts on what is on screen,
 * `Jump to` second because it changes what is; ungrouped last, since a heading
 * cannot follow rows that had none.
 */
function grouped(commands: readonly PaletteCommand[]): readonly PaletteCommand[] {
  const ORDER = ['Layout', 'Jump to', undefined];
  const withGroup = commands.map((command) => ({
    ...command,
    group: paletteGroup(command.id),
    icon: command.icon ?? paletteIcon(command.id),
  }));
  return withGroup
    .map((command, position) => ({ command, position }))
    .sort(
      (a, b) =>
        ORDER.indexOf(a.command.group) - ORDER.indexOf(b.command.group) || a.position - b.position,
    )
    .map((entry) => entry.command);
}

export function App({
  terminals,
  layout,
  commands,
  agents: agentsApi = null,
  views: viewsApi = null,
  settings: settingsApi = null,
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

  /**
   * ⌘K — the command palette.
   *
   * The consumer that bought the primitive, and it closes a gap M1 opened: every
   * command carries a `title` the SDK documents as "shown in the palette", and
   * there was no palette. `layout.zoom`, `layout.rename` and every `tasks.*` verb
   * had a user-facing name and no way for a user to say it.
   *
   * The list is fetched **when it opens**, not on mount: an extension activating
   * later registers more commands, and a list taken at first paint would be short
   * by exactly the ones a user is most likely looking for.
   *
   * Attribution: this goes through `commands.invoke`, which main attributes to
   * `{kind:'user'}` — and that is CORRECT here, unlike a tree row's command
   * (D14). The difference is not who clicked; it is that the user typed the
   * command's own name and can see what they are running.
   */
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteCommands, setPaletteCommands] = useState<readonly PaletteCommand[]>([]);

  useEffect(() => {
    if (!paletteOpen || commands === null) return;
    let live = true;
    void commands.list().then((result) => {
      if (!live) return;
      // A failure leaves the list empty and the palette says "no matching
      // command" — which is honest. Silently rendering the previous list would
      // offer verbs that may no longer be registered.
      setPaletteCommands(result.ok ? grouped(result.value) : []);
    });
    return () => {
      live = false;
    };
  }, [paletteOpen, commands]);

  useEffect(() => {
    /*
     * The CAPTURE phase, on the window, for the same reason `ViewOverlay` uses
     * it: the focused element is usually an xterm, which claims the keyboard and
     * would eat this before it bubbled anywhere.
     *
     * Not a menu accelerator, deliberately. A menu key equivalent fires whatever
     * has focus — including while a modal is open — and this key has to be able
     * to mean "close" while the palette itself is the thing on screen.
     */
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'k' || !(event.metaKey || event.ctrlKey) || event.altKey) return;
      event.preventDefault();
      setPaletteOpen((open) => !open);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  /**
   * ⌘F — find in the focused terminal.
   *
   * Bound the same way ⌘K is, and for the first of the same two reasons: xterm
   * has focus and would eat it. NOT a menu accelerator — the file this bypasses
   * says why in its own words (`menu-template.ts`): AppKit resolves a key
   * equivalent before the page sees the keystroke, and a find that lived in the
   * menu bar could never be closed by the bar it opened.
   *
   * It only ever OPENS. Esc and the close button are the way out, both on the
   * bar itself, because ⌘F pressed while the bar is open is "find again" in
   * every editor — and with the bar already holding focus, that gesture reaches
   * its input rather than this handler.
   */
  const [findOpen, setFindOpen] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'f' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) {
        return;
      }
      event.preventDefault();
      setFindOpen(true);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

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
    const present = snapshots.roots.flatMap((root) => (root.tree === null ? [] : leafIds(root.tree)));
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

  /**
   * A factory rather than one callback, because a pane's behaviour now depends
   * on WHICH root it is in: every root is mounted, and only the active one's
   * panes hold a terminal (see `TerminalPane.visible`).
   */
  /**
   * The mode actually on screen — state, not a local, because a THIRD thing needs
   * it: each pane's chrome is painted with its grid's own colour
   * (`--sh-pane-title-bg`), and a head left on the default palette over a
   * re-themed grid is the seam that rule exists to prevent.
   */
  const [themeMode, setThemeMode] = useState<ThemeMode>(DEFAULT_THEME_MODE);

  /*
   * Read HERE rather than beside the dock, because `makeRenderPane` below needs
   * it: a pane that shows a contributed view resolves its component through the
   * same contribution list the sidebar draws from. One subscription, so the
   * stage and the rail cannot disagree about what is contributed.
   */
  const contributions = useContributions(viewsApi);

  /**
   * Closing a pane, as ONE callback for every pane on the stage.
   *
   * Written out here rather than inline at the call site, and that is the whole
   * point: the panes come out of a `map`, so a per-pane arrow cannot be
   * memoized, and a fresh one each render replaces every contributed pane's
   * props. `extension-pane.tsx` records what that cost in commands per minute.
   */
  const closePane = useCallback(
    (paneId: string) => {
      invoke(LAYOUT_COMMANDS.close, { pane: paneId });
    },
    [invoke],
  );

  const makeRenderPane = useCallback(
    (visible: boolean) =>
    (pane: Pane, focused: boolean): ReactNode => {
      /*
       * A pane that is a contributed view, and the branch is FIRST because it is
       * the one that must not fall through: `TerminalPane` attaches, and
       * attaching spawns a pty. A PR list with a shell behind it is the defect
       * ADR 0044's `view` field exists to make impossible.
       *
       * It does not wait for `terminals`. A view pane wants no session, so the
       * registry the guard below is about is nothing to do with it — and a
       * review tab drawing nothing until the terminal layer is ready would be a
       * dependency it does not have.
       */
      if (pane.view !== null) {
        return (
          <ExtensionPane
            pane={pane}
            view={pane.view}
            views={contributions}
            bridge={viewsApi}
            focused={focused}
            // Closing the pane IS what "I am finished" means for a place. The
            // kernel's own verb, off `LAYOUT_COMMANDS` — the same door ⌘W uses,
            // so a view cannot end its own life by a path that skips the one
            // terminator (ADR 0022).
            onClose={closePane}
          />
        );
      }
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
          visible={visible}
          // The colour this pane's grid is painted with. Passed rather than let
          // to default, or the head keeps the build's default palette while the
          // grid under it moves — which is exactly the two-palette seam the
          // custom property exists to prevent.
          background={terminalBackground(themeMode)}
          {...(sessionId === undefined ? {} : { sessionId })}
          {...(agent === undefined ? {} : { agentState: agent.state })}
          {...(agent?.reason === undefined ? {} : { agentReason: agent.reason })}
        />
      );
    },
    [terminals, sessionsByPane, agents, themeMode, contributions, viewsApi, invoke],
  );


  /**
   * The focused pane, for the find bar below.
   *
   * This used to also feed a titlebar breadcrumb (`task / pane`). That is gone:
   * it restated the rail and the pane head at once, and §1's rule is that
   * nothing repeats itself down the hierarchy. The pane is still resolved here
   * because ⌘F needs to know which grid it is searching.
   */
  const focused =
    active === null || active.tree === null || active.focusedPaneId === null
      ? null
      : findPane(active.tree, paneId(active.focusedPaneId));

  /**
   * The find bar's target: whichever pane is focused right now, re-resolved on
   * every render rather than captured when ⌘F was pressed. Clicking another
   * terminal retargets the bar — the alternative is a bar that keeps counting
   * matches in a pane you have stopped reading.
   *
   * `search` is a property of the terminal object, so its identity is stable for
   * the life of that terminal and the effects in `FindBar` that depend on it
   * only re-run when the pane really changes.
   */
  const focusedPaneId = active?.focusedPaneId ?? null;
  const findTarget =
    terminals === null || focusedPaneId === null ? null : (terminals.search(paneId(focusedPaneId)) ?? null);

  /**
   * What the focused pane is offering, for the strip's trailing edge.
   *
   * The FOCUSED pane's and nobody else's: the strip draws one trailing group and a
   * split holds several panes, so a union of them would put a button beside a tab
   * for something you are not looking at. Same rule the tab's own glyph follows
   * three hundred lines down, and the same rule `FindBar` follows for the grid it
   * searches.
   *
   * Glyph names go through `contributedIcon` — the allow-list, not the extension's
   * word — and an action whose glyph is not in it is DROPPED rather than drawn with
   * the fallback dots: a button with no picture in a 20px box is a button nobody
   * can read, and the pane still has the palette verb.
   */
  const paneActions = useMemo(
    () =>
      (focused?.actions ?? []).flatMap((action) => {
        const glyph = contributedIcon(action.glyph);
        return glyph === undefined ? [] : [{ id: action.id, label: action.label, glyph }];
      }),
    [focused],
  );

  /**
   * Which group a root is a tab of — the page's one answer to that question.
   *
   * Off the snapshot, so the sidebar's highlight, the tab strip and the stage
   * are three readings of one envelope. A root the envelope does not carry is
   * its own group, which is both the kernel's default and the honest answer for
   * a root that has not arrived yet.
   */
  const groupOfRoot = useCallback(
    (root: string) => snapshots?.roots.find((candidate) => candidate.root === root)?.group ?? root,
    [snapshots],
  );

  /**
   * The tabs of the group on screen.
   *
   * Derived from the same envelope the stage draws from — there is no tab state
   * anywhere in this file, and there must not be. A remembered "current tab"
   * would be a second copy of what the snapshot already says, which is how the
   * sidebar's equivalent went stale twice before ADR 0035 pinned it down.
   *
   * **A group of one still gets its tab.** The strip used to appear only at the
   * moment a second tab did; it is the app's one permanent row of chrome now, so
   * the window does not change shape under you when a second tab opens — and it
   * is the ONLY place a root is named, since the per-pane head is gone.
   */
  const tabs = useMemo(() => {
    if (snapshots === null || active === null) return [];
    const siblings = snapshots.roots.filter((root) => root.group === active.group);
    return siblings.map((root) => {
      /*
       * What this tab has to say, rolled up over EVERY session in the root — not
       * the focused pane's, which is the label's rule and the wrong one here. A
       * tab is a thing you are not looking at; the whole job of the dot is to
       * report the pane inside it you cannot see, and a split whose second pane
       * is blocked has something to say whichever half holds the focus.
       */
      const mark = tabMark(Object.values(root.sessions).map((session) => agents[session]?.state));
      const pane =
        root.tree === null || root.focusedPaneId === null
          ? null
          : findPane(root.tree, paneId(root.focusedPaneId));
      /*
       * The SAME resolution the sidebar uses, and `displayTitle`'s own doc
       * comment says so in as many words: the user's name, else the program's
       * live OSC title, else a tail of the cwd. Spelling it out here instead
       * would be the hand-synced pair this codebase keeps getting bitten by.
       *
       * `home` is empty because the renderer has no business knowing one; a
       * pane in `~` therefore reads as its own last component, which is what a
       * terminal tab has always shown.
       */
      /*
       * What the tab IS, for one with no agent to report — the glyph the view
       * declared, through the renderer's own allow-list.
       *
       * Only ever the FOCUSED pane's, because a tab draws one leading slot and a
       * root can hold several views. `undefined` for a terminal, for a view that
       * declared no glyph, and for a name the allow-list does not carry, which
       * all draw the empty slot rather than a wrong picture.
       */
      /*
       * The PANE's own glyph wins over its view type's.
       *
       * A contribution registers one glyph per type, which is right for a pull
       * request and wrong for a scratch pane: the same view is a notepad or a
       * skill depending on what is written in it, and only the pane knows which.
       * The type's glyph stays as the answer for every pane that has nothing to
       * say — which is nearly all of them.
       *
       * Both names go through the same allow-list, so a pane cannot reach the page
       * with a picture the build never saw any more than a manifest can.
       */
      const icon =
        pane === null || pane.view === null
          ? undefined
          : (contributedIcon(pane.icon ?? undefined) ??
            contributedIcon(contributions.find((view) => view.type === pane.view?.type)?.icon));
      // A root with no panes is a real state (its last pane was closed), and it
      // is still a tab you can switch to. It says so — a raw root id is an
      // internal name, and `window-1` on a tab teaches nothing.
      return {
        id: root.root,
        label: pane === null ? 'Empty' : displayTitle(pane),
        ...(mark === undefined ? {} : { mark }),
        ...(icon === undefined ? {} : { icon }),
      };
    });
  }, [snapshots, active, agents, contributions]);

  /**
   * The takeover layer's visibility, which is MAIN's answer rather than this
   * component's state.
   *
   * `window.settings` owns it, because the same value feeds `presence.overlay` and
   * ADR 0020 allows exactly one writer of "is the user looking at this". So ⌘,
   * (the menu), the palette entry, `shepherd raw window.settings` and Esc in the
   * screen all move one variable, and the page follows it the way it follows the
   * layout.
   */
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    if (settingsApi === null) return;
    return settingsApi.onVisibility((open) => setSettingsOpen(open));
  }, [settingsApi]);

  /**
   * The theme, in BOTH halves.
   *
   * `applyThemeVariables` paints the chrome and `terminals.retheme` paints every
   * grid, from one resolved mode. Both, or the app runs on two palettes — which is
   * exactly the drift `theme.ts`'s one-token-map rule exists to prevent, and what
   * v1 had between `Theme.swift` and `writeBaseTheme()`.
   *
   * `system` resolves through `matchMedia` here rather than through Electron's
   * `nativeTheme` in main: one place, and it re-resolves on its own when the OS
   * flips. No relaunch — a terminal's palette is a property of its xterm instance,
   * and a setting that needed a restart would be the first thing anyone tried and
   * the first thing that looked broken.
   */
  const themeSetting = useSetting(settingsApi, THEME_KEY);
  useEffect(() => {
    const paint = (): void => {
      const mode = resolveThemeMode(themeSetting, watcher.prefersDark());
      applyThemeVariables(document.documentElement, mode);
      terminals?.retheme(mode);
      setThemeMode(mode);
    };
    const watcher = watchPrefersDark(() => paint());
    paint();
    return () => watcher.dispose();
  }, [themeSetting, terminals]);

  /** Every accelerator an overlay declared, for the footer's keycap strip. */
  const raisable = contributions.filter((view) => view.surface === 'overlay' && view.key !== undefined);

  return (
    <div className="sh-app">
      {/*
        The window's OWN titlebar (`titleBarStyle: 'hiddenInset'`) — the traffic
        lights' clearance and the drag region, and nothing drawn of its own.

        It carries no name. An app's own name told back to you is the one fact
        you already have, and while it was there the band had to be opaque to
        hold it — which cut the rail's sky strip off at a seam 44px down and made
        the window open on a dead black bar. The strip runs to the top edge now
        and this layer floats over it, so the lights sit on the scene.

        The one cell that survives is the one no other surface can show: a
        renderer with no bridge looks exactly like an app with no panes.
      */}
      <header className="sh-plate">
        <span className="sh-plate-spacer" />
        {terminals === null && <span className="sh-plate-cell is-ember">NO BRIDGE</span>}
      </header>

      <div className="sh-body">
        <ViewDock
          views={viewsApi}
          // The same value the stage below draws from, so a row's highlight and
          // the pane group on screen cannot get out of step.
          activeRoot={snapshots?.active ?? null}
          // …and which group that root is a tab of, so a task's row stays lit
          // while you are on its second tab.
          groupOfRoot={groupOfRoot}
          actions={
            /*
              The panel's name lives on the sky strip, overlaid at its foot — one
              surface carrying the picture and the heading, which is what makes
              the strip a window rather than a band of decoration above a list.

              The panel's ONE primary action rides in the same row, which is also
              why `raisable` collapses to a single button here: §4 allows one
              primary per surface, and the rail is one surface.
            */
            <SkyStrip
              title="Work"
              action={
                <>
                  {raisable.map((view) => (
                <IconButton
                  key={view.type}
                  icon={raiseIcon(view.icon)}
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
            The tabs of the group on screen, ABOVE the roots and as a sibling of
            them — never wrapping them. Every root stays mounted whichever tab is
            showing, and a wrapper that re-parented them on a switch would be a
            remounted pane, which is a second pty.
          */}
          <TabStrip
            tabs={tabs}
            activeId={snapshots?.active ?? ''}
            onSelect={(root) => invoke(LAYOUT_COMMANDS.switchRoot, { root })}
            onNew={() => invoke(LAYOUT_COMMANDS.newTab, {})}
            newIcon={raiseIcon('plus')}
            actions={paneActions}
            /*
              A window EVENT, not a command, and `sh:raise-view` is the precedent
              one line up the same convention.
              The pane that published the action is the pane that knows what it
              means, and its component lives in this page — where a command
              dispatched into the extension host could not open a dialog, because
              the host has no DOM. So the shell draws the button and says which
              pane was asked; nothing here learns what the verb is.
            */
            onAction={(id) => {
              if (focusedPaneId === null) return;
              window.dispatchEvent(
                new CustomEvent('sh:pane-action', { detail: { pane: focusedPaneId, action: id } }),
              );
            }}
          />
          {/*
            TWO ways to have nothing on the stage, and they draw the same thing.

              - `snapshots === null` — the window before main's first push.
              - the active root has NO PANES — a real projection now (`tree:
                null`). Closing the last pane of the home root empties it rather
                than closing the window, so this is where you land after
                finishing your last task, and it is where a fresh profile starts.

            The second one is why this component was unreachable for its whole
            life, and the first is why nobody noticed: a snapshot arrives within
            milliseconds, so the only empty state that existed was one you could
            not see. Drawn INSIDE the stage and beside the roots rather than
            instead of them, because the hidden roots must stay mounted — a torn
            -down pane comes back as a second pty.
          */}
          {(snapshots === null || active?.tree == null) && (
            /*
              …and WHY it is empty, when the root says. Read off the active
              snapshot rather than held here: the same rule the tab strip and the
              sidebar highlight follow (ADR 0035), and the reason a wait cannot
              outlive the pane that ends it — the field is simply gone from the
              next envelope.
            */
            <EmptyState {...(active?.placeholder === undefined ? {} : { placeholder: active.placeholder })} />
          )}
          {/*
            …and the other root a placeholder can describe: one that HAS panes,
            all of them showing captured screens.

            Core answers with a placeholder there and refuses over any root with
            a live pane, so this condition is the whole of the decision — the
            page never asks whether a root is archived, it draws what the root
            said about itself. Outside the `.sh-root` map, because it belongs to
            the active root rather than to any pane in it.
          */}
          {active?.tree != null && active.placeholder !== undefined && (
            <ArchivedBanner placeholder={active.placeholder} onAction={invoke} />
          )}
          {(snapshots?.roots ?? []).map((root) => (
            <div
              className="sh-root"
              key={root.root}
              data-root={root.root}
              data-active={root.root === snapshots?.active}
              style={{ display: root.root === snapshots?.active ? 'flex' : 'none' }}
            >
              {root.tree === null ? null : (
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
                {...(terminals === null
                  ? {}
                  : { renderPane: makeRenderPane(root.root === snapshots?.active) })}
              />
              )}
            </div>
          ))}
          {/*
            Inside the stage, so it sits over the grid rather than over the
            sidebar, and AFTER the roots so it paints above them without a
            z-index of its own. Mounted only while open: the bar takes focus on
            mount, and a permanently mounted one would have to be told not to.
          */}
          {findOpen && (
            <FindBar
              search={findTarget}
              paneId={focusedPaneId === null ? null : paneId(focusedPaneId)}
              onClose={() => {
                setFindOpen(false);
                // Hand the keyboard back to the pane the user was reading.
                // Without this, focus stays on a field that has just been
                // removed and the next keystroke goes nowhere.
                if (focusedPaneId !== null) terminals?.focus(paneId(focusedPaneId));
              }}
            />
          )}

          {/*
            The stage's takeover layer.

            Inside `<main>` rather than beside it, which is the whole difference
            between this and `SettingsScreen`: absolutely positioned over the
            stage, it covers the tab strip and every root and leaves the rail
            alone. The roots stay MOUNTED underneath — a conditional mount is a
            released pty and then a second one.
          */}
          <ViewScreen views={contributions} bridge={viewsApi} />
        </main>
      </div>

      {/*
        The takeover layer.

        Painted OVER `.sh-body` rather than instead of it: every root underneath
        stays mounted, so every pty keeps running and comes back exactly as it
        was. A conditional mount around the stage is v1's `_ConditionalContent`
        lesson — a torn-down pane is a released terminal and then, on the way
        back, a second pty.

        Mounted only while open, like `FindBar`: it takes the keyboard on mount,
        and a permanently mounted one would have to be told not to.
      */}
      {settingsOpen && (
        <SettingsScreen
          settings={settingsApi}
          onClose={() => {
            // ASK main to close it; do not close it here. The answer comes back
            // through `onVisibility`, which is what keeps this page and the
            // viewing predicate from disagreeing about a takeover.
            void settingsApi?.setOpen(false);
            // Hand the keyboard back to the pane the user was reading — the fix
            // `FindBar` carries, for the same reason.
            if (focusedPaneId !== null) terminals?.focus(paneId(focusedPaneId));
          }}
        />
      )}

      <ViewOverlay views={contributions} bridge={viewsApi} />

      {/*
        The same job for panes, which run a verb rather than raising a layer.
        Draws nothing; it exists to hold one keydown listener.
      */}
      <PaneKeys views={contributions} invoke={(command) => void invoke(command, {})} />


      {/*
        ⌘K. Mounted always and open only when asked — `Modal` renders nothing at
        all while closed, so this costs one element in the tree and keeps the
        palette's own state (its query, its active row) from being a remount
        away from whatever else is on screen.
      */}
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        commands={paletteCommands}
        onRun={(id) => invoke(id, {})}
      />
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
