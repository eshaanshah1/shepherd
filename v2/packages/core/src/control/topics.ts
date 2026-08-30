import { toDisposable, type Disposable } from '@shepherd/sdk';
import type { Delivery, SnapshotResult } from './subscription.ts';

/**
 * Which topics a client may follow, and how each one behaves.
 *
 * The alternative was for every transport to decide, and the app already had one
 * of those: `agent-relay.ts` holds an allow-list of exactly one topic with a
 * comment calling itself a deviation. A declaration is the same protection,
 * generalised — a topic says once whether it has state worth snapshotting and
 * whether its changes are worth pushing, and every client gets the same answer.
 *
 * An UNDECLARED topic is still subscribable, as a stateless push stream. That is
 * deliberate rather than an oversight: `shepherd wait` subscribes to `*` today,
 * and refusing it would break the CLI in exchange for a guarantee the socket
 * cannot give anyway — opening `control.sock` already means being the user. What
 * a declaration buys is the two behaviours below, not permission.
 */

export interface TopicDeclaration {
  readonly topic: string;
  /**
   * `push` sends every event; `nudge` sends a signal and lets the reader read
   * (ADR 0031). Choose `nudge` when the payload is derivable from a read the
   * client already makes, which is most of the control plane.
   */
  readonly delivery: Delivery;
  /**
   * The topic's CURRENT value, for the first frame of a subscription.
   *
   * Absent = an event stream with no state, and a subscriber starts empty.
   * Present = the client never has to make a second call to find out where it
   * is, and therefore never has a window where an event lands between the read
   * and the subscribe.
   */
  readonly snapshot?: () => unknown;
  /**
   * Which subject a payload is about, so a nudge can name what changed instead
   * of making the reader re-read everything. Nudge topics only.
   */
  readonly key?: (payload: unknown) => string | undefined;
}

export interface TopicSummary {
  readonly topic: string;
  readonly delivery: Delivery;
  readonly stateful: boolean;
}

export class TopicRegistry {
  readonly #declared = new Map<string, TopicDeclaration>();

  declare(declaration: TopicDeclaration): Disposable {
    this.#declared.set(declaration.topic, declaration);
    return toDisposable(() => {
      // Only if it is still ours: a redeclaration replaced it, and disposing the
      // first registration must not delete the second.
      if (this.#declared.get(declaration.topic) === declaration) this.#declared.delete(declaration.topic);
    });
  }

  /** How a topic behaves. An undeclared one is a stateless push stream. */
  deliveryOf(topic: string): Delivery {
    return this.#declared.get(topic)?.delivery ?? 'push';
  }

  /** The subject extractor, if the topic declared one. */
  keyOf(topic: string): ((payload: unknown) => string | undefined) | undefined {
    return this.#declared.get(topic)?.key;
  }

  /**
   * The topic's current value.
   *
   * A snapshot provider that throws answers "no snapshot" rather than failing
   * the subscribe: a client that cannot start is worse off than one that starts
   * empty and folds the next change, and the throw is the provider's bug rather
   * than the subscriber's.
   */
  snapshotOf(topic: string): SnapshotResult {
    const provider = this.#declared.get(topic)?.snapshot;
    if (provider === undefined) return { has: false };
    return { has: true, value: provider() };
  }

  /** Self-describing, like `/commands`: a client can ask what it may follow. */
  list(): readonly TopicSummary[] {
    return [...this.#declared.values()].map((declaration) => ({
      topic: declaration.topic,
      delivery: declaration.delivery,
      stateful: declaration.snapshot !== undefined,
    }));
  }
}
