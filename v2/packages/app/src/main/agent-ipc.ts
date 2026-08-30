import { app, BrowserWindow, ipcMain, webContents } from 'electron';
import { KERNEL, type Disposable, type Logger } from '@shepherd/sdk';
import type { AttentionStore, CommandRegistry, EventBus } from '@shepherd/core';
import type { LayoutStore } from '@shepherd/core/layout';
import { EMIT, INVOKE, type AgentIndicatorDTO, type IpcResult, type NavigateMessage } from '../shared/index.ts';
import { startAgentRelay, type AgentRelay, type AlertSink } from './agent-relay.ts';
import { alertDispatcher } from './alert-dispatch.ts';
import { ALERTS_DESCRIBE } from './alert-spec.ts';
import { createSystemAlerts } from './system-alerts.ts';

/**
 * The electron-shaped twenty lines around `agent-relay.ts`: push to every live
 * renderer, answer the pull, raise a real banner, set the dock badge.
 *
 * Nothing here decides anything — same split as `layout-ipc.ts`. The decisions
 * (what crosses, whether a banner fires, what a dead host means) are in the
 * relay, where a test can reach them without an Electron process.
 */

export interface AgentIpc extends Disposable {
  readonly relay: AgentRelay;
  publish(indicators: readonly AgentIndicatorDTO[]): void;
  badge(count: number): void;
}

export interface AgentIpcOptions {
  readonly bus: EventBus;
  readonly layout: LayoutStore;
  readonly attention: AttentionStore;
  readonly logger: Logger;
  /** Injected so a smoke can record alerts instead of stacking real banners. */
  readonly alerts?: AlertSink;
  /**
   * Where `alerts.describe` is asked, and where a pressed button is run.
   *
   * Optional so the smokes and the tests can build this without a kernel: with
   * no registry there is nobody to describe an alert and nothing a button could
   * do, which is exactly the degradation `resolveAlert` already answers.
   */
  readonly registry?: CommandRegistry;
}

export function registerAgentIpc(options: AgentIpcOptions): AgentIpc {
  const log = options.logger.child('app');

  const publish = (indicators: readonly AgentIndicatorDTO[]): void => {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      contents.send(EMIT.agentsChanged, indicators);
    }
  };

  /**
   * Where a banner sends you: raise the window, then tell the page.
   *
   * The window is resolved LATE, per press, for `registerCaptureCommand`'s
   * reason — the app outlives its last window and macOS can hand it a new one,
   * so a captured reference photographs a destroyed window forever.
   */
  const navigate = (message: NavigateMessage): void => {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      contents.send(EMIT.navigate, message);
    }
  };

  const raise = (): void => {
    const target = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
    if (target === undefined) {
      // Said out loud: a click that reached us and moved nothing is exactly the
      // silence this whole file's logging rule exists to forbid.
      log.warn('a notification was clicked with no window to raise');
      return;
    }
    if (target.isMinimized()) target.restore();
    target.show();
    // `steal: true` because the click IS the user asking for the app; without it
    // macOS bounces the dock icon and leaves you in the app you were reading.
    app.focus({ steal: true });
  };

  const badge = (count: number): void => {
    // macOS shows nothing for 0, which is what we want — `setBadgeCount(0)`
    // clears it rather than drawing a zero.
    app.setBadgeCount(count);
  };

  const registry = options.registry;

  /**
   * Ask whoever registered `alerts.describe` what this banner should say.
   *
   * As `KERNEL`, because this is the shell asking on its own behalf — no user
   * gesture has happened yet, and the thing that eventually does (a click, a
   * button) is attributed to the user where it is dispatched.
   *
   * A result that is not `ok` is `null` rather than an error: the commonest
   * reason by far is that nobody registered the command, which is a supported
   * configuration and not a fault.
   */
  const describe =
    registry === undefined
      ? undefined
      : async (input: {
          readonly sessionId: string;
          readonly paneId: string;
          readonly state: string;
          readonly reason?: string;
          readonly turnFinished: boolean;
        }): Promise<unknown> => {
          const result = await registry.invoke(ALERTS_DESCRIBE, input, KERNEL);
          return result.ok ? result.value : null;
        };

  const relay = startAgentRelay({
    bus: options.bus,
    layout: options.layout,
    attention: options.attention,
    logger: options.logger,
    publish,
    // The production sink lives in its own file so a test can reach both of its
    // failure paths; `alerts` stays injected so `smoke:m2` can assert that a turn
    // finishing under the user's eyes raises NOTHING (ADR 0020), which cannot be
    // asserted against a real Notification Center.
    alerts:
      options.alerts ??
      createSystemAlerts({
        logger: options.logger,
        // No registry means nothing can answer a press, and `system-alerts`
        // draws no buttons at all in that case rather than dead ones.
        ...(registry === undefined
          ? {}
          : {
              dispatch: alertDispatcher({
                registry,
                raise,
                navigate,
                onFailure: (command, message) =>
                  log.warn(`a notification's "${command}" did nothing: ${message}`),
              }),
            }),
      }),
    badge,
    ...(describe === undefined ? {} : { describe }),
  });

  ipcMain.handle(
    INVOKE.agentsGet,
    (): IpcResult<readonly AgentIndicatorDTO[]> => ({ ok: true, value: relay.snapshot() }),
  );

  return {
    relay,
    publish,
    badge,
    dispose: () => {
      ipcMain.removeHandler(INVOKE.agentsGet);
      relay.dispose();
    },
  };
}
