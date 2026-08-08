import type { SplitNode } from '@shepherd/core/layout';
import { leafIds } from '@shepherd/core/layout';
import type { LayoutSnapshot } from '../shared/index.ts';
import type { PaneDiagnostics, PaneTerminals } from './pane-sessions.ts';

/**
 * The window the terminal smoke reads the renderer through.
 *
 * Installed only when main loads the page with `?smoke=1`, which nothing but
 * `smoke-terminal.ts` does. It exposes no new capability — every field is
 * something the page already computed — and it is what lets the smoke drive the
 * REAL app (real registry, real xterm, real menu items) instead of a parallel
 * harness whose passing would say nothing about the app that ships.
 *
 * The interesting field is `panes[].text`: the xterm BUFFER, not the bytes the
 * IPC listener saw. Asserting on the listener would pass even if xterm never
 * parsed a thing.
 */

export interface PaneOutline {
  readonly kind: 'leaf' | 'split';
  readonly paneId?: string;
  readonly axis?: string;
  readonly ratio?: number;
  readonly first?: PaneOutline;
  readonly second?: PaneOutline;
}

export interface SmokeSnapshot {
  readonly ready: boolean;
  readonly paneIds: string[];
  readonly focusedPaneId: string | null;
  readonly outline: PaneOutline | null;
  readonly panes: PaneDiagnostics[];
  /** paneId → sessionId as MAIN sees it. The renderer's view is in `panes`. */
  readonly sessions: Readonly<Record<string, string>>;
}

export interface SmokeHook {
  snapshot(): SmokeSnapshot;
}

export interface SmokeHandle {
  readonly onSnapshot: (snapshot: LayoutSnapshot) => void;
}

const EMPTY: SmokeSnapshot = {
  ready: false,
  paneIds: [],
  focusedPaneId: null,
  outline: null,
  panes: [],
  sessions: {},
};

export function installSmokeHook(terminals: PaneTerminals | null): SmokeHandle {
  let latest: LayoutSnapshot | null = null;

  const hook: SmokeHook = {
    snapshot: () => {
      if (latest === null) return EMPTY;
      /*
       * A root with NO PANES is `ready` with an empty list — not `EMPTY`, which
       * means "main has not answered yet". They are different facts and a smoke
       * that could not tell them apart would wait out its timeout on a window
       * that is working exactly as intended.
       */
      const tree = latest.tree;
      const ids = tree === null ? [] : leafIds(tree);
      return {
        ready: true,
        paneIds: [...ids],
        focusedPaneId: latest.focusedPaneId,
        outline: tree === null ? null : outline(tree),
        panes: ids
          .map((id) => terminals?.inspect(id))
          .filter((info): info is PaneDiagnostics => info !== undefined),
        sessions: latest.sessions,
      };
    },
  };

  (globalThis as { __shepherdTest?: SmokeHook }).__shepherdTest = hook;

  return {
    onSnapshot: (snapshot) => {
      latest = snapshot;
    },
  };
}

/** The tree's shape, plain enough to cross `executeJavaScript`'s serializer. */
export function outline(node: SplitNode): PaneOutline {
  return node.kind === 'leaf'
    ? { kind: 'leaf', paneId: node.pane.id }
    : {
        kind: 'split',
        axis: node.axis,
        ratio: node.ratio,
        first: outline(node.first),
        second: outline(node.second),
      };
}
