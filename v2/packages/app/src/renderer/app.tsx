import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  leaf,
  leafIds,
  makePane,
  type Pane,
  type Rect,
  type SplitNode,
} from '@shepherd/core/layout';
import { COMMANDS, type CommandID, type CommandsApi, type WindowApi } from '../shared/index.ts';
import { runCommand, type CommandContext, type LayoutState } from './commands.ts';
import { SplitView } from './split-view.tsx';
import { TerminalPane } from './terminal-pane.tsx';
import type { PaneTerminals } from './pane-sessions.ts';

/**
 * The M0 shell: a layout, a focused pane, and one dispatch point.
 *
 * Every gesture — the toolbar buttons AND the menu keys arriving over the
 * bridge — goes through `dispatch`, so a button and its accelerator cannot come
 * to mean different things. The command itself is `runCommand`, which is pure
 * and tested against the layout ops; this component is the part that has a DOM
 * to measure and a registry to tell.
 */

export interface AppProps {
  /** Null when there is no preload bridge (a plain `vite` page): panes draw as cards. */
  readonly terminals: PaneTerminals | null;
  readonly commands: CommandsApi | null;
  readonly windowApi: WindowApi | null;
  readonly initialTree?: SplitNode;
  /** Diagnostics seam: the smoke reads the live layout through this. */
  readonly onState?: (state: LayoutState) => void;
}

export function defaultTree(): SplitNode {
  return leaf(makePane({}));
}

export function App({ terminals, commands, windowApi, initialTree, onState }: AppProps): ReactNode {
  const [state, setState] = useState<LayoutState>(() => {
    const tree = initialTree ?? defaultTree();
    return { tree, focusedPaneId: leafIds(tree)[0] ?? null };
  });
  const stageRef = useRef<HTMLElement>(null);

  // `dispatch` must not be rebuilt per state change, or the command
  // subscription below would tear down and re-subscribe every time a pane
  // moves. So state travels through a ref and the callback stays stable.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => onState?.(state), [state, onState]);

  const dispatch = useCallback(
    (command: CommandID) => {
      const context: CommandContext = {
        viewport: measure(stageRef.current),
        newPane: () => makePane({ cwd: focusedCwd(stateRef.current) }),
      };
      const outcome = runCommand(stateRef.current, command, context);

      if (outcome.handled) setState(outcome.state);

      switch (outcome.effect.kind) {
        case 'closed-pane':
          // THE one place a session is ended. Everything else — unmounting,
          // re-rendering, switching focus — leaves it running.
          terminals?.close(outcome.effect.paneId);
          break;
        case 'close-window':
          void windowApi?.close();
          break;
        case 'opened-pane':
        case 'none':
          break;
      }
    },
    [terminals, windowApi],
  );

  useEffect(() => {
    if (commands === null) return;
    return commands.onCommand((message) => dispatch(message.command));
  }, [commands, dispatch]);

  const renderPane = useCallback(
    (pane: Pane, focused: boolean): ReactNode =>
      terminals === null ? null : (
        <TerminalPane pane={pane} terminals={terminals} focused={focused} />
      ),
    [terminals],
  );

  const paneCount = leafIds(state.tree).length;

  return (
    <div className="sh-app">
      <header className="sh-bar">
        <span className="sh-brand">SHEPHERD</span>
        <span className="sh-bar-sep" />
        <button className="sh-key" onClick={() => dispatch(COMMANDS.splitRight)} type="button">
          SPLIT RIGHT
        </button>
        <button className="sh-key" onClick={() => dispatch(COMMANDS.splitDown)} type="button">
          SPLIT DOWN
        </button>
        <button className="sh-key" onClick={() => dispatch(COMMANDS.closePane)} type="button">
          CLOSE PANE
        </button>
        <span className="sh-bar-spacer" />
        <span className="sh-plate">
          PANES · {paneCount}
          <span className="sh-plate-dim">{terminals === null ? ' / NO BRIDGE' : ''}</span>
        </span>
      </header>
      <main className="sh-stage" ref={stageRef}>
        <SplitView
          tree={state.tree}
          onTreeChange={(tree) => setState((prev) => ({ ...prev, tree }))}
          focusedPaneId={state.focusedPaneId}
          onFocusPane={(id) => setState((prev) => ({ ...prev, focusedPaneId: id }))}
          {...(terminals === null ? {} : { renderPane })}
          home=""
        />
      </main>
    </div>
  );
}

/**
 * The pane area in its own coordinates. `neighbor` only ever compares frames
 * within this rect, so the origin is irrelevant and 0,0 keeps the arithmetic
 * readable in a test.
 */
function measure(element: HTMLElement | null): Rect {
  const box = element?.getBoundingClientRect();
  return { x: 0, y: 0, width: box?.width ?? 0, height: box?.height ?? 0 };
}

/** A new pane opens where the one it was split from is. */
function focusedCwd(state: LayoutState): string | null {
  const id = state.focusedPaneId;
  if (id === null) return null;
  return findCwd(state.tree, id);
}

function findCwd(node: SplitNode, id: string): string | null {
  if (node.kind === 'leaf') return node.pane.id === id ? node.pane.cwd : null;
  return findCwd(node.first, id) ?? findCwd(node.second, id);
}
