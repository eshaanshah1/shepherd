import type { SplitNode } from '@shepherd/core/layout';
import { leafIds } from '@shepherd/core/layout';
import type { LayoutState } from './commands.ts';
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
}

export interface SmokeHook {
  snapshot(): SmokeSnapshot;
}

export interface SmokeHandle {
  readonly onState: (state: LayoutState) => void;
}

export function installSmokeHook(terminals: PaneTerminals | null): SmokeHandle {
  let latest: LayoutState | null = null;

  const hook: SmokeHook = {
    snapshot: () => {
      if (latest === null) {
        return { ready: false, paneIds: [], focusedPaneId: null, outline: null, panes: [] };
      }
      const ids = leafIds(latest.tree);
      return {
        ready: true,
        paneIds: [...ids],
        focusedPaneId: latest.focusedPaneId,
        outline: outline(latest.tree),
        panes: ids
          .map((id) => terminals?.inspect(id))
          .filter((info): info is PaneDiagnostics => info !== undefined),
      };
    },
  };

  (globalThis as { __shepherdTest?: SmokeHook }).__shepherdTest = hook;

  return {
    onState: (state) => {
      latest = state;
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
