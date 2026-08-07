import { ipcMain, webContents } from 'electron';
import { USER, type Disposable, type RootID } from '@shepherd/sdk';
import type { CommandRegistry } from '@shepherd/core';
import type { LayoutStore } from '@shepherd/core/layout';
import { EMIT, INVOKE, type IpcResult, type LayoutSnapshot } from '../shared/index.ts';
import { layoutSnapshot, parseViewport } from './layout-snapshot.ts';

/**
 * The layout's electron-shaped twenty lines: get the projection, push it when it
 * changes, take a viewport rect, and forward a command into the registry.
 *
 * Nothing here decides anything about the layout. That is the point of P4a — the
 * renderer is a projection plus a transport, and this file is the transport's
 * main-process end. Every decision (which pane is focused, what ⌘W does on the
 * last pane, whether a ratio is legal) is in core, reached through
 * `registry.invoke`.
 */

export interface LayoutIpcOptions {
  readonly store: LayoutStore;
  readonly registry: CommandRegistry;
  /** The single root this window shows. Multi-window is a later milestone. */
  readonly root: RootID;
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
}

export function registerLayoutIpc(options: LayoutIpcOptions): LayoutIpc {
  const { store, registry, root } = options;

  const snapshot = (): LayoutSnapshot | null => layoutSnapshot(store, root);

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

  ipcMain.handle(INVOKE.layoutGet, (): IpcResult<LayoutSnapshot> => {
    const current = snapshot();
    return current === null
      ? { ok: false, error: { code: 'no-root', message: `no layout root ${root}` } }
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
    store.setViewport(root, rect);
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

  const subscription = store.onDidChange((changed) => {
    if (changed === root) publish();
  });

  return {
    publish,
    dispose: () => {
      subscription.dispose();
      for (const channel of [INVOKE.layoutGet, INVOKE.layoutViewport, INVOKE.commandInvoke]) {
        ipcMain.removeHandler(channel);
      }
    },
  };
}
