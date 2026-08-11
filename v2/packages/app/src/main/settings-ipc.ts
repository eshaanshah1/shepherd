import { ipcMain, webContents } from 'electron';
import { USER, extensionId, type Disposable, type SettingValue } from '@shepherd/sdk';
import type { CommandRegistry, EventBus, SettingsRegistry } from '@shepherd/core';
import { EMIT, INVOKE, type IpcResult, type SettingsSnapshotDTO } from '../shared/index.ts';
import { SETTINGS_CHANGED_TOPIC, SETTINGS_COMMANDS } from './settings-commands.ts';
import { SETTINGS_VISIBILITY_COMMAND } from './settings-visibility.ts';

/**
 * Settings, electron-shaped: four channels in, two pushes out.
 *
 * Every one of them goes through `registry.invoke`, never through the
 * `SettingsRegistry` directly — so the screen and `shepherd raw settings.set`
 * take the same path, with the same validation and the same one authorizer.
 * `layout-ipc.ts` makes the same choice for the same reason; a handler that
 * reached past the verb table would be a second way to write a setting, and the
 * two would eventually disagree.
 *
 * `USER` is asserted here and never sent by the page. A renderer that could name
 * its own caller kind could name `{kind:'agent'}` and inherit an agent's grants.
 */

export interface SettingsIpcOptions {
  readonly registry: CommandRegistry;
  readonly bus: EventBus;
  /**
   * Read for ONE question: who owns a page, so a command run by a contributed
   * page is attributed to the extension that contributed it.
   *
   * Values still go through the verb table — this is not a way around it. It is
   * the same lookup `ViewRegistry` does for a tree row's click (D14), against the
   * record that already exists.
   */
  readonly settings: SettingsRegistry;
}

export interface SettingsIpc extends Disposable {
  /**
   * Tell every live renderer whether the screen is up.
   *
   * Public because the state is `window.settings`'s, not this file's: main calls
   * this from that command's `onChange`, in the same turn it updates presence, so
   * the page and the viewing predicate can never disagree about a takeover.
   */
  pushVisibility(open: boolean): void;
}

/** Every live renderer, for the same reason `layout-ipc.ts` sends to all of them. */
function broadcast(channel: string, payload: unknown): void {
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed()) continue;
    contents.send(channel, payload);
  }
}

export function registerSettingsIpc(options: SettingsIpcOptions): SettingsIpc {
  const { registry, bus, settings } = options;

  const through = async (command: string, args: unknown): Promise<IpcResult<unknown>> => {
    const result = await registry.invoke(command, args, USER);
    return result.ok
      ? { ok: true, value: result.value }
      : { ok: false, error: { code: result.error.code, message: result.error.message } };
  };

  ipcMain.handle(INVOKE.settingsList, async (): Promise<IpcResult<SettingsSnapshotDTO>> => {
    const answer = await through(SETTINGS_COMMANDS.list, {});
    // The cast is the one place this file trusts the command it just called: the
    // handler is `settings-commands.ts`'s, in this process, and its return shape
    // is `SettingsSnapshotDTO` by construction. Nothing that crossed a port is
    // being trusted here.
    return answer.ok ? { ok: true, value: answer.value as SettingsSnapshotDTO } : answer;
  });

  ipcMain.handle(INVOKE.settingsSet, async (_event, key: unknown, value: unknown): Promise<IpcResult<void>> => {
    if (typeof key !== 'string' || key.length === 0) {
      return { ok: false, error: { code: 'invalid-argument', message: 'a setting key must be a non-empty string' } };
    }
    const answer = await through(SETTINGS_COMMANDS.set, { key, value });
    return answer.ok ? { ok: true, value: undefined } : answer;
  });

  ipcMain.handle(INVOKE.settingsReset, async (_event, key: unknown): Promise<IpcResult<void>> => {
    if (typeof key !== 'string' || key.length === 0) {
      return { ok: false, error: { code: 'invalid-argument', message: 'a setting key must be a non-empty string' } };
    }
    const answer = await through(SETTINGS_COMMANDS.reset, { key });
    return answer.ok ? { ok: true, value: undefined } : answer;
  });

  ipcMain.handle(INVOKE.settingsOpen, async (_event, open: unknown): Promise<IpcResult<void>> => {
    if (typeof open !== 'boolean') {
      return { ok: false, error: { code: 'invalid-argument', message: 'open must be a boolean' } };
    }
    const answer = await through(SETTINGS_VISIBILITY_COMMAND, { open });
    return answer.ok ? { ok: true, value: undefined } : answer;
  });

  /**
   * A contributed page running a command — as the EXTENSION that contributed the
   * page, never as the user.
   *
   * D14, one surface along: the click is the user's, the command id is the
   * extension's, and the user cannot see it. A page whose command ran with
   * `USER`'s unconditional trust would be a way for any extension to reach past
   * its own grant, which is the hole `ViewRegistry.invoke` closed for tree rows.
   */
  ipcMain.handle(
    INVOKE.settingsInvoke,
    async (_event, page: unknown, command: unknown, args: unknown): Promise<IpcResult<unknown>> => {
      if (typeof page !== 'string' || typeof command !== 'string') {
        return { ok: false, error: { code: 'invalid-argument', message: 'page and command must be strings' } };
      }
      const owner = settings.pages().find((candidate) => candidate.id === page)?.owner;
      if (owner === undefined) {
        // Reported rather than silently resolved: a form whose submit does
        // nothing is the "and then nothing happens" branch the log rule exists for.
        return { ok: false, error: { code: 'unknown-page', message: `no extension owns the settings page "${page}"` } };
      }
      const result = await registry.invoke(command, args, { kind: 'extension', id: extensionId(owner) });
      return result.ok
        ? { ok: true, value: result.value }
        : { ok: false, error: { code: result.error.code, message: result.error.message } };
    },
  );

  /**
   * A changed setting reaches the page from the BUS, not from the write.
   *
   * So a change made anywhere — the CLI in a pane behind the window, an extension
   * migrating a key on activation — updates an open settings screen. A push built
   * into the write handler would only ever tell the window about its own writes.
   */
  const relay = bus.on(SETTINGS_CHANGED_TOPIC, (payload) => {
    broadcast(EMIT.settingsChanged, payload as { key: string; value: SettingValue });
  });

  return {
    pushVisibility: (open) => broadcast(EMIT.settingsVisibility, open),
    dispose: () => {
      relay.dispose();
      ipcMain.removeHandler(INVOKE.settingsList);
      ipcMain.removeHandler(INVOKE.settingsSet);
      ipcMain.removeHandler(INVOKE.settingsReset);
      ipcMain.removeHandler(INVOKE.settingsOpen);
      ipcMain.removeHandler(INVOKE.settingsInvoke);
    },
  };
}
