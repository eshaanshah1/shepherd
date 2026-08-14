import { s, toDisposable, type Caller, type Disposable } from '@shepherd/sdk';
import type { CommandRegistry, SecretsRegistry } from '@shepherd/core';

/**
 * The secrets verbs — one table, reached by the Secrets screen, by the control
 * socket, and by an extension asking for its own credential.
 *
 * Commands rather than a bespoke surface per caller, for the reason settings and
 * the layout are commands: a second path that read a secret a second way would
 * be a second authorization path, and the one verb table exists to prevent
 * exactly that.
 *
 * ── the whole security model, in one paragraph ───────────────────────────────
 *
 * **An extension may only ever touch its own.** The owner is taken from the
 * CALLER, never from an argument, so there is no shape of request in which
 * `shepherd.github` reads `acme.thing`'s token — not a malicious one, not a
 * mistaken one. A `user` caller may name an owner, because the person at the
 * keyboard is who the declarations were shown to and the screen is how they act
 * on them; and a user may WRITE any declared secret and READ none, which is the
 * asymmetry that keeps the screen from being a place credentials are displayed.
 */
export const SECRETS_COMMANDS = {
  /** Every declared secret and whether it holds a value. Never a value. */
  list: 'secrets.list',
  /** This extension's own secret. Extensions only — see the note above. */
  get: 'secrets.get',
  set: 'secrets.set',
  delete: 'secrets.delete',
} as const;

export interface SecretsCommandsOptions {
  readonly registry: CommandRegistry;
  readonly secrets: SecretsRegistry;
}

/**
 * Whose secret is this request about?
 *
 * An extension is always itself. Anybody else — the user at the screen, the CLI
 * — has to say, because there is no identity to infer and guessing one would be
 * inventing an owner for a credential.
 */
function ownerFor(caller: Caller, named: string | undefined): string | undefined {
  if (caller.kind === 'extension') return caller.id;
  return named;
}

export function registerSecretsCommands(options: SecretsCommandsOptions): Disposable {
  const { registry, secrets } = options;

  const registrations = [
    registry.register(SECRETS_COMMANDS.list, {
      title: 'Secrets: List',
      /*
       * No permission, deliberately. This answers what extensions have ASKED
       * for and whether each is filled in — which is exactly the information a
       * user needs in order to decide, and contains no credential. Gating it
       * would mean the screen listing what is wanted required the permission to
       * hold what is wanted.
       */
      schema: s.nothing(),
      handler: () => ({ secrets: secrets.list() }),
    }),

    registry.register(SECRETS_COMMANDS.get, {
      // No title: not a palette verb. Its whole effect is a return value, and
      // that value is a credential — a "Secrets: Get" row would be a way to
      // print one into a terminal.
      permission: 'secrets',
      schema: s.object({ key: s.string() }),
      /**
       * **Extensions only, and only their own.**
       *
       * A `user` caller is refused outright rather than being asked which owner
       * they mean. The palette and the control socket both invoke as `user`, so
       * answering here would make `shepherd raw secrets.get` a way to print any
       * stored credential to a terminal — and there is no legitimate use for it:
       * a person who wants their token has the place they got it from.
       */
      handler: (args, caller) => {
        if (caller.kind !== 'extension') {
          throw new Error('secrets.get answers an extension asking for its own secret, and nobody else');
        }
        const value = secrets.get(caller.id, args.key);
        // `undefined` for "not set" and for "never declared" alike — the
        // registry's own rule, and the caller can act on neither differently.
        return { key: args.key, value: value ?? null };
      },
    }),

    registry.register(SECRETS_COMMANDS.set, {
      title: 'Secrets: Set',
      /**
       * `secrets`, so an extension needs the grant and the ONE authorizer in the
       * dispatcher enforces it. The screen invokes as `USER`, which is
       * unconditionally trusted — the same asymmetry `settings.set` makes, for
       * the same reason: a user typing into their own secrets screen is not an
       * extension writing behind them.
       */
      permission: 'secrets',
      schema: s.object({
        key: s.string(),
        value: s.string(),
        /** Whose. Ignored for an extension caller, which is always itself. */
        extension: s.optional(s.string()),
      }),
      handler: (args, caller) => {
        const owner = ownerFor(caller, args.extension);
        if (owner === undefined) throw new Error('secrets.set needs an extension to store this for');
        const result = secrets.set(owner, args.key, args.value);
        // A throw, so the failure reaches the caller as a typed `handler-failed`
        // carrying the registry's own sentence — including "there is no
        // keychain", which is the one a user has to be able to read.
        if (!result.ok) throw new Error(result.error.message);
        return { key: args.key, extension: owner, set: args.value !== '' };
      },
    }),

    registry.register(SECRETS_COMMANDS.delete, {
      title: 'Secrets: Clear',
      permission: 'secrets',
      schema: s.object({ key: s.string(), extension: s.optional(s.string()) }),
      handler: (args, caller) => {
        const owner = ownerFor(caller, args.extension);
        if (owner === undefined) throw new Error('secrets.delete needs an extension to clear this for');
        secrets.delete(owner, args.key);
        return { key: args.key, extension: owner };
      },
    }),
  ];

  return toDisposable(() => {
    for (const registration of registrations) registration.dispose();
  });
}
