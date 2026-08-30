import { app, ipcMain, webContents } from 'electron';
import type { Disposable, Logger } from '@shepherd/sdk';
import type { AttentionStore, EventBus } from '@shepherd/core';
import type { LayoutStore } from '@shepherd/core/layout';
import { EMIT, INVOKE, type AgentIndicatorDTO, type IpcResult } from '../shared/index.ts';
import { startAgentRelay, type AgentRelay, type AlertSink } from './agent-relay.ts';
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
}

export function registerAgentIpc(options: AgentIpcOptions): AgentIpc {
  const publish = (indicators: readonly AgentIndicatorDTO[]): void => {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      contents.send(EMIT.agentsChanged, indicators);
    }
  };

  const badge = (count: number): void => {
    // macOS shows nothing for 0, which is what we want — `setBadgeCount(0)`
    // clears it rather than drawing a zero.
    app.setBadgeCount(count);
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
    alerts: options.alerts ?? createSystemAlerts({ logger: options.logger }),
    badge,
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
