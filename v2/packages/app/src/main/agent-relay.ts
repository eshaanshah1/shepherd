import type { AttentionLevel, Disposable, Logger, PaneID, SessionID } from '@shepherd/sdk';
import type { AttentionStore, EventBus } from '@shepherd/core';
import type { LayoutStore } from '@shepherd/core/layout';

/**
 * The one place an extension's events reach the chrome, and the only topic that
 * does.
 *
 * **An allow-list, not a subscription API.** `bridge.ts` refuses a generic
 * `invoke(channel, …)` because a compromised page must not be able to name its
 * own IPC channel; letting the renderer name its own *topic* is the same
 * widening pointed the other way. It matters concretely here: `claude.hook`
 * carries the entire hook payload — tool inputs, file contents, prompts — and
 * sits on the same bus. So main decides what crosses, and today that is one
 * topic.
 *
 * This table is what M3's declarative view contributions replace: an extension
 * will contribute a status item rather than main knowing an extension's topic
 * by name. Recorded as a deviation rather than left to look like architecture.
 */

/** The only topic relayed to the renderer. Not a list because one is honest. */
export const AGENT_STATE_TOPIC = 'agents.stateChanged';

/** What the renderer needs per session. Deliberately not the whole change. */
export interface AgentIndicator {
  readonly sessionId: string;
  readonly state: string;
  readonly reason?: string;
}

export interface AgentRelayOptions {
  readonly bus: EventBus;
  readonly layout: LayoutStore;
  readonly attention: AttentionStore;
  readonly logger: Logger;
  /** Push a snapshot to every live renderer. */
  readonly publish: (indicators: readonly AgentIndicator[]) => void;
  /** Where a banner/chime goes. Injected so a smoke can assert suppression. */
  readonly alerts: AlertSink;
  /** The dock badge. Injected for the same reason. */
  readonly badge: (count: number) => void;
}

export interface AlertSink {
  notify(alert: { readonly title: string; readonly body: string; readonly sessionId: string }): void;
}

export interface AgentRelay extends Disposable {
  /** The current indicators, for a renderer that has just mounted. */
  snapshot(): readonly AgentIndicator[];
  /** Forget everything. The host that produced these is gone. */
  clear(): void;
}

interface IncomingChange {
  readonly sessionId?: unknown;
  readonly to?: unknown;
  readonly reason?: unknown;
  readonly level?: unknown;
  readonly alertReason?: unknown;
  readonly turnFinished?: unknown;
}

const LEVELS = new Set(['none', 'info', 'attention', 'urgent']);

export function startAgentRelay(options: AgentRelayOptions): AgentRelay {
  const log = options.logger.child('agent');

  /**
   * The last state per session, and it answers three failures at once.
   *
   * A pushed channel with no replay hands a renderer that mounted late a blank
   * indicator until the next transition — and with dev HMR that is every reload,
   * not a rare case. The same map is what lets a dead extension host be
   * *reported* rather than leaving confident stale state on screen.
   */
  const latest = new Map<string, AgentIndicator>();

  const push = (): void => options.publish([...latest.values()]);

  const subscription = options.bus.on(AGENT_STATE_TOPIC, (payload) => {
    const change = payload as IncomingChange;
    if (typeof change.sessionId !== 'string' || typeof change.to !== 'string') {
      log.warn(`ignored an ${AGENT_STATE_TOPIC} payload with no session or state`);
      return;
    }
    const sessionId = change.sessionId;

    if (change.to === 'shell') latest.delete(sessionId);
    else {
      latest.set(sessionId, {
        sessionId,
        state: change.to,
        ...(typeof change.reason === 'string' ? { reason: change.reason } : {}),
      });
    }
    push();

    // The badge counts what attention holds, not what this map holds: attention
    // is the channel that decides what "needs you" means, and reading it keeps
    // one answer rather than two that can disagree.
    options.badge(options.attention.count());

    const pane = options.layout.paneForSession(sessionId as unknown as SessionID);
    if (pane === undefined) {
      // A headless session has no pane, so there is nothing to be viewing and no
      // banner to suppress. Said out loud because "my agent finished and nothing
      // happened" is otherwise unanswerable.
      log.debug(`${sessionId} has no pane; state ${change.to} reached the chrome but not the alert channel`);
      return;
    }

    // The level is threaded from the event, NOT read back from the store: the
    // emit and the store's write are two ordered crossings of one port, so on
    // receipt the store still holds the previous level.
    const level = typeof change.level === 'string' && LEVELS.has(change.level)
      ? (change.level as AttentionLevel)
      : undefined;

    const decision = options.attention.decide(pane as PaneID, {
      ...(level === undefined ? {} : { level }),
      turnFinished: change.turnFinished === true,
    });

    if (!decision.banner) return;
    options.alerts.notify({
      title: title(change.to),
      body: typeof change.alertReason === 'string' && change.alertReason !== '' ? change.alertReason : change.to,
      sessionId,
    });
  });

  push();

  return {
    snapshot: () => [...latest.values()],
    clear: () => latest.clear(),
    dispose: () => {
      subscription.dispose();
      latest.clear();
    },
  };
}

/**
 * What the extension host dying means for the chrome.
 *
 * Every indicator on screen came from a process that is no longer running, so
 * leaving them is a confident lie — a pane frozen at `WORKING` after the thing
 * that would have said otherwise is gone. Clearing attention wholesale is sound
 * **only while `agents-core` is the single writer**: the store does not record
 * which caller set an entry, so a selective clear would need bookkeeping nothing
 * else wants. That dependency is the line to change the day a second writer
 * exists.
 */
export function clearAgentState(options: {
  readonly relay: AgentRelay;
  readonly attention: AttentionStore;
  readonly logger: Logger;
  readonly reason: string;
  readonly publish: (indicators: readonly AgentIndicator[]) => void;
  readonly badge: (count: number) => void;
}): void {
  const held = options.relay.snapshot();
  if (held.length === 0) return;
  for (const indicator of held) {
    options.attention.clear(indicator.sessionId as unknown as SessionID);
  }
  options.relay.clear();
  options.publish([]);
  options.badge(options.attention.count());
  options.logger.warn(
    'agent',
    `cleared ${held.length} agent indicator(s): ${options.reason}. They are not stale — they are unknown.`,
  );
}

function title(state: string): string {
  switch (state) {
    case 'blocked':
      return 'Waiting on you';
    case 'error':
      return 'Turn failed';
    default:
      return 'Turn finished';
  }
}
