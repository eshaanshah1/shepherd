import { KERNEL, s, toDisposable, type Disposable } from '@shepherd/sdk';
import type { CommandRegistry, EventBus, SettingsRegistry } from '@shepherd/core';

/**
 * The settings verbs — one table, reached by the ⌘K palette, by the control
 * socket, and (through `settings-ipc.ts`) by the settings screen.
 *
 * Commands rather than a bespoke surface per caller, for the reason the layout is
 * commands: a second path that wrote a setting a second way would be a second
 * authorization path, and the one verb table exists to prevent exactly that.
 */
export const SETTINGS_COMMANDS = {
  list: 'settings.list',
  get: 'settings.get',
  set: 'settings.set',
  reset: 'settings.reset',
} as const;

/**
 * A changed setting, on the bus.
 *
 * Pushed rather than pulled because there are three writers — the screen, the
 * CLI, and an extension — and every reader (the shell's theme, an extension's
 * seeded mirror) would otherwise have to guess when to re-read. Same shape and
 * same argument as `viewing-topic.ts`.
 */
export const SETTINGS_CHANGED_TOPIC = 'settings.changed';

export interface SettingsCommandsOptions {
  readonly registry: CommandRegistry;
  readonly settings: SettingsRegistry;
  readonly bus: EventBus;
}

/** Every key that has a spec, in nav order. The one place this walk is written. */
function declaredKeys(settings: SettingsRegistry): readonly string[] {
  return settings.pages().flatMap((page) => (page.settings ?? []).map((spec) => spec.key));
}

export function registerSettingsCommands(options: SettingsCommandsOptions): Disposable {
  const { registry, settings, bus } = options;

  /**
   * One publish per change, wherever it came from — which is why this subscribes
   * to the registry rather than emitting inside each handler. An extension's own
   * `settings.set` and the screen's write reach the bus the same way.
   */
  const relay = settings.onDidChange((key, value) => {
    bus.emit(SETTINGS_CHANGED_TOPIC, { key, value }, KERNEL);
  });

  const registrations = [
    registry.register(SETTINGS_COMMANDS.list, {
      title: 'Settings: List',
      schema: s.nothing(),
      handler: () => ({
        pages: settings.pages(),
        values: Object.fromEntries(declaredKeys(settings).map((key) => [key, settings.get(key)])),
        /**
         * Which keys are untouched, as a list rather than a flag beside every
         * value: the screen needs it to decide whether to draw a reset
         * affordance, and a caller that does not care ignores one field instead
         * of unwrapping every value.
         */
        defaults: declaredKeys(settings).filter((key) => settings.isDefault(key)),
      }),
    }),

    registry.register(SETTINGS_COMMANDS.get, {
      title: 'Settings: Get',
      schema: s.object({ key: s.string() }),
      handler: (args) => {
        const value = settings.get(args.key);
        if (value === undefined) throw new Error(`no setting "${args.key}" is declared`);
        return { key: args.key, value, isDefault: settings.isDefault(args.key) };
      },
    }),

    registry.register(SETTINGS_COMMANDS.set, {
      title: 'Settings: Set',
      /**
       * `settings`, so an extension needs the grant and the ONE authorizer in the
       * dispatcher enforces it. The screen invokes as `USER`, which is
       * unconditionally trusted — and that asymmetry is deliberate: a user typing
       * in their own settings screen is not an extension writing behind them.
       */
      permission: 'settings',
      schema: s.object({ key: s.string(), value: s.unknown() }),
      handler: (args) => {
        const result = settings.set(args.key, args.value);
        // A throw, so the failure reaches the caller as a typed `handler-failed`
        // carrying the registry's own sentence. Answering `{ok:false}` inside a
        // command that succeeded would make a refusal look like a success to
        // everything that only checks `ok`.
        if (!result.ok) throw new Error(result.error.message);
        return { key: args.key, value: result.value };
      },
    }),

    registry.register(SETTINGS_COMMANDS.reset, {
      title: 'Settings: Reset to Default',
      permission: 'settings',
      schema: s.object({ key: s.string() }),
      handler: (args) => {
        const result = settings.reset(args.key);
        if (!result.ok) throw new Error(result.error.message);
        return { key: args.key, value: result.value };
      },
    }),
  ];

  return toDisposable(() => {
    for (const registration of registrations) registration.dispose();
    relay.dispose();
  });
}
