import type {
  Caller,
  CommandError,
  Disposable,
  InvokeOptions,
  Logger,
  Result,
} from '@shepherd/sdk';
import type { CommandRegistry } from '../commands/registry.ts';
import type { EventBus } from '../events/bus.ts';
import { SubscriptionState, type ControlFrame } from './subscription.ts';
import { TopicRegistry } from './topics.ts';

/**
 * The control plane, once — commands and subscriptions — with every transport an
 * adapter over it.
 *
 * `control.sock` was already a thin adapter over `commands.invoke`, which was
 * the right shape and had exactly one consumer that never exercised it. The
 * renderer, meanwhile, reached main through nine bespoke `ipcMain.handle`
 * channels, each with its own validation, its own error mapping and its own
 * push. A protocol with one in-process consumer is a protocol nobody has tested,
 * so the renderer becomes the second consumer of this one and the channels go.
 *
 * What lives here and nowhere else:
 *   - **invoke**, with the caller attributed by the transport that knows;
 *   - **the verb list**, self-describing;
 *   - **subscribe**, where the snapshot and the registration are ONE step;
 *   - **pull**, which is what makes a nudge back-pressure rather than a hint.
 *
 * It owns no verbs. Adding a command adds nothing to this file — the property
 * `control-ingress.ts` has had since M2 and the renderer never had.
 */

export interface ControlSurfaceOptions {
  readonly commands: CommandRegistry;
  readonly bus: EventBus;
  readonly logger: Logger;
  /** Shared with every transport, so a topic behaves the same on all of them. */
  readonly topics?: TopicRegistry;
}

export interface Subscription extends Disposable {
  /**
   * "I have read." Answers a fresh nudge if anything changed while the reader
   * was reading, and nothing if it is caught up.
   */
  pull(): void;
}

export class ControlSurface {
  readonly #commands: CommandRegistry;
  readonly #bus: EventBus;
  readonly #log;
  readonly #topics: TopicRegistry;

  constructor(options: ControlSurfaceOptions) {
    this.#commands = options.commands;
    this.#bus = options.bus;
    this.#log = options.logger.child('ingress');
    this.#topics = options.topics ?? new TopicRegistry();
  }

  get topics(): TopicRegistry {
    return this.#topics;
  }

  invoke(
    command: string,
    args: unknown,
    caller: Caller,
    options?: InvokeOptions,
  ): Promise<Result<unknown, CommandError>> {
    return this.#commands.invoke(command, args, caller, options);
  }

  list(): readonly { readonly id: string; readonly title?: string }[] {
    return this.#commands.list();
  }

  /**
   * Subscribe, and be handed where the topic currently is in the same step.
   *
   * The ordering is the whole point and it is why this is a method rather than
   * two calls a client makes: the snapshot is taken and the listener registered
   * with no `await` between them, so nothing can be emitted into the gap. A
   * client that read and then subscribed would lose whatever landed in between;
   * one that subscribed and then read would apply it twice.
   */
  subscribe(topic: string, sink: (frame: ControlFrame) => void): Subscription {
    const key = this.#topics.keyOf(topic);
    const state = new SubscriptionState({
      topic,
      delivery: this.#topics.deliveryOf(topic),
      ...(key === undefined ? {} : { key }),
    });

    let snapshot;
    try {
      snapshot = this.#topics.snapshotOf(topic);
    } catch (error) {
      // The provider's bug, not the subscriber's. Starting empty and folding the
      // next change is strictly better than refusing to start.
      this.#log.error(`snapshot for ${topic} threw: ${messageOf(error)} — subscribing without one`);
      snapshot = { has: false } as const;
    }

    const subscription = this.#bus.on(topic, (payload, envelope) => {
      for (const frame of state.receive(payload, envelope)) sink(frame);
    });
    for (const frame of state.open(snapshot)) sink(frame);

    this.#log.debug(`subscriber attached to ${topic} (${this.#topics.deliveryOf(topic)})`);
    return {
      pull: () => {
        for (const frame of state.pulled()) sink(frame);
      },
      dispose: () => {
        subscription.dispose();
        this.#log.debug(`subscriber left ${topic}`);
      },
    };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
