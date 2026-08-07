import {
  callerLabel,
  err,
  formatIssues,
  ok,
  toDisposable,
  type Caller,
  type CommandError,
  type CommandSpec,
  type Disposable,
  type Logger,
  type Result,
} from '@shepherd/sdk';
import { authorize, type GrantSet } from './authorize.ts';

/**
 * The one verb table.
 *
 * Keyboard, palette, control socket, remote device, and extension are five
 * *transports* into this registry — never five implementations. v1 shipped
 * three (`ShortcutActions`, `controlRoute`, `applyRemoteCommand`) and they
 * disagreed about authorization, about argument shapes, and about what happened
 * when a verb was unknown.
 *
 * Two rules, and they are the reason the class exists:
 *
 *   1. **Nothing here throws at invoke time.** An unknown id, a failed schema, a
 *      denial and a handler that blew up are all typed `CommandError`s. A
 *      caller across a socket cannot take the main process down by naming a
 *      command wrong.
 *   2. **No silent no-ops.** Every failure is also logged, with the attributed
 *      caller. A verb that quietly does nothing is indistinguishable from a
 *      feature that has stopped working — which is exactly how v1's dead
 *      branches survived.
 *
 * Registration is the one place that *does* throw: see `DuplicateCommandError`.
 */

export class DuplicateCommandError extends Error {
  /**
   * Declared and assigned, not a constructor parameter property: Electron runs
   * our `.ts` entry directly on node's type stripping, which can only erase, and
   * a parameter property would be a *launch* failure. `erasableSyntaxOnly` turns
   * that into the typecheck error that sent you here.
   */
  readonly commandId: string;

  constructor(commandId: string) {
    super(
      `command "${commandId}" is already registered. ` +
        'Registering over it would silently replace a handler its author still believes in.',
    );
    this.name = 'DuplicateCommandError';
    this.commandId = commandId;
  }
}

export interface CommandRegistryOptions {
  readonly logger: Logger;
  /**
   * Read **per invocation**, not captured once: a permission granted while the
   * app runs (an install, a device pairing, an agent session starting) must take
   * effect without every command re-registering itself.
   */
  readonly grants: () => GrantSet;
}

interface Entry {
  readonly spec: CommandSpec<unknown, unknown>;
}

export class CommandRegistry {
  readonly #commands = new Map<string, Entry>();
  readonly #log;
  readonly #grants;

  constructor(options: CommandRegistryOptions) {
    this.#log = options.logger.child('command');
    this.#grants = options.grants;
  }

  register<A, R>(id: string, spec: CommandSpec<A, R>): Disposable {
    if (this.#commands.has(id)) throw new DuplicateCommandError(id);
    const entry: Entry = { spec: spec as unknown as CommandSpec<unknown, unknown> };
    this.#commands.set(id, entry);
    this.#log.debug(`registered ${id}`);
    return toDisposable(() => {
      // Identity-checked: a late dispose from an extension that has already been
      // replaced must not remove the *new* owner's registration.
      if (this.#commands.get(id) === entry) this.#commands.delete(id);
    });
  }

  has(id: string): boolean {
    return this.#commands.has(id);
  }

  list(): readonly { readonly id: string; readonly title?: string }[] {
    return [...this.#commands.entries()].map(([id, entry]) =>
      entry.spec.title === undefined ? { id } : { id, title: entry.spec.title },
    );
  }

  async invoke<R = unknown>(id: string, args: unknown, caller: Caller): Promise<Result<R, CommandError>> {
    const who = callerLabel(caller);
    const entry = this.#commands.get(id);
    if (!entry) return this.#fail({ code: 'unknown-command', message: `no command "${id}"`, commandId: id }, who);

    // Authorization FIRST, before the schema. A caller who may not invoke a
    // command must not be able to learn its argument shape by sending garbage
    // and reading the validation error back.
    const verdict = authorize(caller, entry.spec.permission, this.#grants());
    if (!verdict.allowed) {
      return this.#fail({ code: 'denied', message: verdict.reason, commandId: id }, who);
    }

    const parsed = entry.spec.schema.parse(args);
    if (!parsed.ok) {
      return this.#fail(
        {
          code: 'invalid-args',
          message: `invalid arguments for "${id}": ${formatIssues(parsed.error)}`,
          commandId: id,
          issues: parsed.error,
        },
        who,
      );
    }

    try {
      const value = await entry.spec.handler(parsed.value, caller);
      this.#log.debug(`${id} ok (${who})`);
      return ok(value as R);
    } catch (error) {
      return this.#fail(
        { code: 'handler-failed', message: `"${id}" failed: ${messageOf(error)}`, commandId: id },
        who,
      );
    }
  }

  #fail(error: CommandError, who: string): Result<never, CommandError> {
    // Every failure leaves a line. This is the logging rule, applied to the one
    // place every action in the app passes through.
    this.#log.warn(`${error.code}: ${error.message} (${who})`);
    return err(error);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
