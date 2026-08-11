import { beforeEach, describe, expect, it } from 'vitest';
import { CommandRegistry, EventBus, SettingsRegistry, SqliteStore, emptyGrants } from '@shepherd/core';
import { KERNEL, USER, manualClock, nullLogger } from '@shepherd/sdk';
import { SETTINGS_CHANGED_TOPIC, SETTINGS_COMMANDS, registerSettingsCommands } from './settings-commands.ts';
import { GENERAL_PAGE, THEME_KEY } from './settings-general.ts';

let settings: SettingsRegistry;
let commands: CommandRegistry;
let bus: EventBus;

beforeEach(() => {
  const store = new SqliteStore({ location: ':memory:', logger: nullLogger });
  settings = new SettingsRegistry({ store, logger: nullLogger });
  settings.contribute('shepherd', [GENERAL_PAGE]);
  bus = new EventBus({ clock: manualClock(0), logger: nullLogger });
  commands = new CommandRegistry({ logger: nullLogger, grants: () => emptyGrants() });
  registerSettingsCommands({ registry: commands, settings, bus });
});

describe('settings.list', () => {
  it('lists every page with its values and which of them are untouched', async () => {
    const answer = await commands.invoke(SETTINGS_COMMANDS.list, {}, USER);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    const listed = answer.value as {
      pages: { id: string }[];
      values: Record<string, unknown>;
      defaults: string[];
    };
    expect(listed.pages.map((page) => page.id)).toContain(GENERAL_PAGE.id);
    expect(listed.values[THEME_KEY]).toBe('system');
    expect(listed.defaults).toContain(THEME_KEY);
  });

  it('stops calling a changed key a default', async () => {
    await commands.invoke(SETTINGS_COMMANDS.set, { key: THEME_KEY, value: 'light' }, USER);
    const answer = await commands.invoke(SETTINGS_COMMANDS.list, {}, USER);
    if (!answer.ok) throw new Error('expected the list to succeed');
    const listed = answer.value as { values: Record<string, unknown>; defaults: string[] };
    expect(listed.values[THEME_KEY]).toBe('light');
    expect(listed.defaults).not.toContain(THEME_KEY);
  });
});

describe('settings.set', () => {
  it('sets the value and publishes it on the bus', async () => {
    const seen: unknown[] = [];
    bus.on(SETTINGS_CHANGED_TOPIC, (payload) => seen.push(payload));
    const answer = await commands.invoke(SETTINGS_COMMANDS.set, { key: THEME_KEY, value: 'light' }, USER);
    expect(answer.ok).toBe(true);
    expect(settings.get(THEME_KEY)).toBe('light');
    expect(seen).toEqual([{ key: THEME_KEY, value: 'light' }]);
  });

  it('reports an unknown key as a FAILED command rather than a silent no-op', async () => {
    const answer = await commands.invoke(SETTINGS_COMMANDS.set, { key: 'nope.nope', value: 1 }, USER);
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.error.message).toContain('nope.nope');
  });

  it('reports a value the spec refuses', async () => {
    const answer = await commands.invoke(SETTINGS_COMMANDS.set, { key: THEME_KEY, value: 'sepia' }, USER);
    expect(answer.ok).toBe(false);
  });
});

describe('settings.reset', () => {
  it('puts the declared default back', async () => {
    await commands.invoke(SETTINGS_COMMANDS.set, { key: THEME_KEY, value: 'light' }, USER);
    await commands.invoke(SETTINGS_COMMANDS.reset, { key: THEME_KEY }, USER);
    expect(settings.get(THEME_KEY)).toBe('system');
  });
});

describe('settings.get', () => {
  it('answers the effective value and says whether it is the default', async () => {
    const answer = await commands.invoke(SETTINGS_COMMANDS.get, { key: THEME_KEY }, KERNEL);
    expect(answer.ok).toBe(true);
    if (answer.ok) expect(answer.value).toEqual({ key: THEME_KEY, value: 'system', isDefault: true });
  });

  it('fails for a key nobody declared', async () => {
    const answer = await commands.invoke(SETTINGS_COMMANDS.get, { key: 'nope.nope' }, KERNEL);
    expect(answer.ok).toBe(false);
  });
});

describe('the general page', () => {
  it('offers exactly system, dark and light, defaulting to system', () => {
    const theme = (GENERAL_PAGE.settings ?? []).find((spec) => spec.key === THEME_KEY);
    expect(theme?.default).toBe('system');
    expect(theme?.choices?.map((choice) => choice.value)).toEqual(['system', 'dark', 'light']);
  });

  it('sorts first, so a contributed page cannot land in front of it', () => {
    expect(GENERAL_PAGE.order).toBe(0);
  });
});
