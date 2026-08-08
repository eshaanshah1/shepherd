import { ipcMain, webContents } from 'electron';
import { USER, type Disposable, type RootID } from '@shepherd/sdk';
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

  const setActive = (root: RootID): void => {
    if (root === active) return;
    active = root;
    onActiveChanged?.(root);
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

  ipcMain.handle(
    INVOKE.commandInvoke,
    async (_event, command: unknown, args: unknown): Promise<IpcResult<unknown>> => {
      if (typeof command !== 'string' || command.length === 0) {
        return {
          ok: false,
          error: { code: 'invalid-argument', message: 'command must be a non-empty string' },
        };
      }
      // `USER` is asserted HERE, never sent by the page. A renderer that could
      // name its own caller kind could name `{kind:'agent'}` and inherit an
      // agent's grants — the attribution has to be made by the side that knows.
      const result = await registry.invoke(command, args, USER);
      return result.ok
        ? { ok: true, value: result.value }
        : { ok: false, error: { code: result.error.code, message: result.error.message } };
    },
  );

  /**
   * What the palette lists.
   *
   * The FILTER IS HERE, not in the page, and it is not this handler's policy: the
   * SDK documents `title` as "shown in the palette … Absent = not user-facing",
   * so an untitled command is one whose author said it is plumbing. Doing it in
   * main means the page is never handed a list it has to remember not to draw,
   * and the narrowed type (`title: string`) carries the guarantee across the
   * port instead of a comment asking for it.
   *
   * Deliberately NOT filtered by permission. Every command here is invoked as
   * `{kind:'user'}`, which `authorize` allows unconditionally — so "can this
   * caller run it" has one answer for all of them, and pre-filtering would be a
   * second authorization model that could disagree with the real one.
   */
  ipcMain.handle(
    INVOKE.commandList,
    (): IpcResult<readonly { id: string; title: string }[]> => ({
      ok: true,
      value: registry
        .list()
        .flatMap((command) =>
          command.title === undefined ? [] : [{ id: command.id, title: command.title }],
        ),
    }),
  );

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
      for (const channel of [
        INVOKE.layoutGet,
        INVOKE.layoutViewport,
        INVOKE.commandInvoke,
        INVOKE.commandList,
      ]) {
        ipcMain.removeHandler(channel);
      }
    },
  };
}
