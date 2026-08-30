import { app } from 'electron';
import { KERNEL, type Disposable, type Logger } from '@shepherd/sdk';
import type { AttentionStore, EventBus, TopicRegistry } from '@shepherd/core';
import type { LayoutStore } from '@shepherd/core/layout';
import { CONTROL_TOPICS, type AgentIndicatorDTO } from '../shared/index.ts';
import { startAgentRelay, type AgentRelay, type AlertSink } from './agent-relay.ts';
import { createSystemAlerts } from './system-alerts.ts';

/**
 * The electron-shaped twenty lines around `agent-relay.ts`: publish the set,
 * raise a real banner, set the dock badge.
 *
 * Nothing here decides anything — same split as `layout-ipc.ts`. The decisions
 * (what crosses, whether a banner fires, what a dead host means) are in the
 * relay, where a test can reach them without an Electron process.
 *
 * **The push is a topic now, not a channel.** It used to be a
 * `webContents.send` per live page plus an `agents:get` handler for the pull,
 * and the page had to follow, pull, and merge the snapshot *under* whatever had
 * already arrived — because a transition landing between the two calls would
 * otherwise be overwritten by a snapshot taken before it. Declaring the topic
 * with a snapshot provider makes the subscribe hand over the current set in the
 * same step as the registration, so the race has no window to happen in and the
 * merge rule has nothing to be right about.
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
  /** Where the topic is declared, so every client gets the same snapshot rule. */
  readonly topics: TopicRegistry;
  /** Injected so a smoke can record alerts instead of stacking real banners. */
  readonly alerts?: AlertSink;
}

export function registerAgentIpc(options: AgentIpcOptions): AgentIpc {
  const publish = (indicators: readonly AgentIndicatorDTO[]): void => {
    // `KERNEL`: main derived this from what an extension reported, and no verb
    // was invoked. The same honest constant `viewing-topic.ts` uses.
    options.bus.emit(CONTROL_TOPICS.agents, indicators, KERNEL);
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

  const declared = options.topics.declare({
    topic: CONTROL_TOPICS.agents,
    delivery: 'push',
    /**
     * Push rather than nudge, and the difference is what the payload IS: an
     * indicator set is small, complete and drawn directly, so a nudge would buy
     * a round trip per change to fetch what the change already carried. ADR
     * 0031's rule is for payloads a reader has to go and assemble.
     */
    snapshot: () => relay.snapshot(),
  });

  return {
    relay,
    publish,
    badge,
    dispose: () => {
      declared.dispose();
      relay.dispose();
    },
  };
}
