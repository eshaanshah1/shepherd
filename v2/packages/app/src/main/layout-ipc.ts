import { readFile } from 'node:fs/promises';
import { ipcMain, webContents } from 'electron';
import { paneId, USER, type Disposable, type RootID } from '@shepherd/sdk';
import type { CommandRegistry } from '@shepherd/core';
import type { LayoutStore } from '@shepherd/core/layout';
import { EMIT, INVOKE, type IpcResult, type LayoutSnapshots } from '../shared/index.ts';
import { layoutSnapshots, parseViewport } from './layout-snapshot.ts';

/**
 * The layout's electron-shaped twenty lines: get the projection, push it when it
 * changes, take a viewport rect, and forward a command into the registry.
 *
 * Nothing here decides anything about the layout. That is the point of P4a — the
 * renderer is a projection plus a transport, and this file is the transport's
 * main-process end. Every decision (which pane is focused, what ⌘W does on the
 * last pane, whether a ratio is legal) is in core, reached through
 * `registry.invoke`.
 *
 * The one piece of state it does own is **which root is active** — which is a
 * property of the window, not of the layout: the store holds N pane groups and
 * has no opinion about which one a window puts on screen. It lives here so that
 * the snapshot, the viewport and presence all read the same answer.
 */

export interface LayoutIpcOptions {
  readonly store: LayoutStore;
  readonly registry: CommandRegistry;
  /** The root the window shows to begin with. */
  readonly active: RootID;
  /**
   * The active root changed. Presence follows it (`ViewingResolver`), and a
   * callback here rather than a duty on each caller is what stops the two from
   * drifting: a switch that updated the window but not `focusedRoot` would make
   * `isFrontPane` answer about a root nobody can see, and attention would clear
   * on panes the user never looked at.
   */
  readonly onActiveChanged?: (root: RootID) => void;
}

export interface LayoutIpc extends Disposable {
  /**
   * Push the current projection to every live renderer.
   *
   * Public because two things change the snapshot from outside the store's own
   * change notification: a session being bound to a pane and a session exiting.
   * `LayoutStore.bindSession` deliberately does not announce itself (it is not a
   * structural change and would re-render the renderer that caused it), so the
   * one caller that knows better says so.
   */
  publish(): void;
  /** Show this root. Publishes, so the page follows in the same turn. */
  setActive(root: RootID): void;
  getActive(): RootID;
}

export function registerLayoutIpc(options: LayoutIpcOptions): LayoutIpc {
  const { store, registry, onActiveChanged } = options;
  let active: RootID = options.active;

  const snapshot = (): LayoutSnapshots | null => layoutSnapshots(store, active);

  const publish = (): void => {
    const current = snapshot();
    if (current === null) return;
    // Every live renderer, not the focused one: a window that is not focused
    // still draws its panes, and a snapshot it never received is a window whose
    // layout has silently stopped updating.
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      contents.send(EMIT.layoutChanged, current);
    }
  };

  /**
   * The tab each group was last showing.
   *
   * Transient, and here rather than in the store for the same reason `active`
   * is: it is a property of the WINDOW. The store holds N pane groups and has no
   * opinion about which one anybody is looking at, let alone which tab of it.
   */
  const lastInGroup = new Map<string, RootID>();

  const setActive = (root: RootID): void => {
    /*
     * Asking for a group's ANCHOR is asking for the group.
     *
     * A root whose id is its own group is the thing a sidebar row names — and
     * "show me this task" means the tab you left it on, which is how every
     * tabbed application in existence reads it. Landing on tab 1 instead would
     * lose your place every time you glanced at something else.
     *
     * Any other root is a specific tab and is honoured exactly.
     *
     * **And only from OUTSIDE the group.** Once you are already in it, naming
     * the anchor is a tab click — the strip's first tab is the anchor, and a
     * rule that redirected it could never move you off the remembered tab. The
     * two gestures share a verb and are told apart by where you are standing,
     * which is the only thing that distinguishes them.
     */
    const anchor = store.groupOf(root) === String(root);
    const fromOutside = store.groupOf(active) !== String(root);
    const remembered = anchor && fromOutside ? lastInGroup.get(String(root)) : undefined;
    const target = remembered !== undefined && store.hasRoot(remembered) ? remembered : root;
    if (target === active) return;
    active = target;
    const group = store.groupOf(target);
    if (group !== undefined) lastInGroup.set(group, target);
    onActiveChanged?.(target);
    publish();
  };

  ipcMain.handle(INVOKE.layoutGet, (): IpcResult<LayoutSnapshots> => {
    const current = snapshot();
    return current === null
      ? { ok: false, error: { code: 'no-root', message: 'no layout root is open' } }
      : { ok: true, value: current };
  });

  ipcMain.handle(INVOKE.layoutViewport, (_event, raw: unknown): IpcResult<void> => {
    const rect = parseViewport(raw);
    if (rect === null) {
      return {
        ok: false,
        error: { code: 'invalid-argument', message: 'viewport expects finite x/y/width/height' },
      };
    }
    // The ACTIVE root: every root is drawn into the same stage, and a hidden one
    // measures 0x0, so the rect the page just measured describes exactly this
    // one. The page re-publishes on a switch, which is what gives a root that
    // has never been on screen a viewport at all.
    store.setViewport(active, rect);
    return { ok: true, value: undefined };
  });

  /**
   * The screen a read-only pane was archived with, read off disk.
   *
   * It takes a PANE ID and never a path. The page has no filesystem and must not
   * be handed one: main resolves `snapshotFile` from the tree it owns, so a
   * compromised renderer can ask for the screen of a pane that exists and for
   * nothing else on the machine.
   *
   * A file that has gone is `no-snapshot` and the pane comes back BLANK — the
   * same stance `tasks`' own `readHistory` takes one layer up. An archive that
   * was expired or hand-cleaned must not stop a tab from opening.
   */
  ipcMain.handle(
    INVOKE.layoutSnapshot,
    async (_event, raw: unknown): Promise<IpcResult<{ bytes: Uint8Array }>> => {
      if (typeof raw !== 'string' || raw === '') {
        return { ok: false, error: { code: 'invalid-argument', message: 'a pane id is required' } };
      }
      const file = store.pane(paneId(raw))?.snapshotFile ?? null;
      if (file === null || file === '') {
        return {
          ok: false,
          error: { code: 'no-snapshot', message: `pane ${raw} shows no captured screen` },
        };
      }
      try {
        return { ok: true, value: { bytes: new Uint8Array(await readFile(file)) } };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'no-snapshot',
            message: `could not read ${file}: ${error instanceof Error ? error.message : String(error)}`,
          },
        };
      }
    },
  );

  /*
   * `command:invoke` and `command:list` used to live here, and they were the
   * renderer's own private door into `CommandRegistry`. They are `control:invoke`
   * and `control:list` now (`control-ipc.ts`) — the same pair `control.sock`
   * offers, so the page reaches the verb table exactly the way a phone and the
   * CLI do. `USER` is still asserted by main and never sent by the page; see
   * `control-ipc.ts` for why that is the one privilege left and where it ends.
   */

  // ANY root's change republishes the whole envelope. The page holds all of them
  // mounted, so a change in a hidden root is one it still has to draw — its
  // panes keep running, and a snapshot that stopped at the active root would
  // leave a task's layout frozen at whatever it looked like when you left it.
  const subscription = store.onDidChange(() => publish());

  return {
    publish,
    setActive,
    getActive: () => active,
    dispose: () => {
      subscription.dispose();
      for (const channel of [INVOKE.layoutGet, INVOKE.layoutViewport, INVOKE.layoutSnapshot]) {
        ipcMain.removeHandler(channel);
      }
    },
  };
}
