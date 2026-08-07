import { disposeAll, s, type Disposable } from '@shepherd/sdk';
import type { CommandRegistry } from '../commands/registry.ts';
import { attentionTarget, type AttentionStore } from './store.ts';

/**
 * Attention as commands, so a keystroke, the palette, `shepherd`, a paired device
 * and an extension are five transports into one table rather than five
 * implementations (v1 shipped three that disagreed about authorization).
 *
 * Both verbs demand the `attention` permission: reaching the dock badge and the
 * user's notification centre is not something an extension gets for free.
 */

export interface AttentionCommandsOptions {
  readonly store: AttentionStore;
  readonly registry: CommandRegistry;
}

const LEVEL = s.enumOf(['none', 'info', 'attention', 'urgent'] as const);

export const ATTENTION_COMMANDS = {
  set: 'attention.set',
  clear: 'attention.clear',
} as const;

export function registerAttentionCommands(options: AttentionCommandsOptions): Disposable {
  const { store, registry } = options;

  const subscriptions: Disposable[] = [
    registry.register(ATTENTION_COMMANDS.set, {
      title: 'Set Attention',
      permission: 'attention',
      schema: s.object({
        /** A pane id or a session id — the store resolves which. */
        target: s.string(),
        level: LEVEL,
        /** Shown to the user. "answer needed", not "state 3". */
        reason: s.string(),
        /** A design-token name. Never a hex string — the theme owns colour. */
        color: s.optional(s.string()),
      }),
      handler: (args, caller) => {
        const pane = unwrap(
          store.set(
            attentionTarget(args.target),
            { level: args.level, reason: args.reason, ...(args.color === undefined ? {} : { color: args.color }) },
            // The attributed caller, threaded through so the emitted event says who
            // asked rather than the kernel claiming it of itself.
            caller,
          ),
        );
        return { pane, level: args.level };
      },
    }),

    registry.register(ATTENTION_COMMANDS.clear, {
      title: 'Clear Attention',
      permission: 'attention',
      schema: s.object({ target: s.string() }),
      handler: (args, caller) => {
        const pane = unwrap(store.clear(attentionTarget(args.target), caller));
        return { pane };
      },
    }),
  ];

  return { dispose: () => disposeAll(subscriptions) };
}

/**
 * Store failures are `Result`s; a handler reports failure by throwing, which the
 * registry turns into a typed `handler-failed` with the message intact. One
 * adapter between the two conventions, same as `layout/commands.ts`.
 */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (result.ok) return result.value;
  throw new Error(result.error);
}
