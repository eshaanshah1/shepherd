import { describe, expect, it, vi } from 'vitest';
import { CommandRegistry, emptyGrants } from '@shepherd/core';
import { USER, nullLogger } from '@shepherd/sdk';
import { SETTINGS_VISIBILITY_COMMAND, registerSettingsVisibility } from './settings-visibility.ts';

const build = () => {
  const onChange = vi.fn();
  const registry = new CommandRegistry({ logger: nullLogger, grants: () => emptyGrants() });
  registerSettingsVisibility({ registry, onChange });
  return { onChange, registry };
};

describe('window.settings', () => {
  it('opens, closes, and reports the state it moved to', async () => {
    const { onChange, registry } = build();
    expect(await registry.invoke(SETTINGS_VISIBILITY_COMMAND, { open: true }, USER)).toMatchObject({ ok: true });
    expect(onChange).toHaveBeenLastCalledWith(true);
    await registry.invoke(SETTINGS_VISIBILITY_COMMAND, { open: false }, USER);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('toggles when no argument is given, which is what a menu item and a keystroke send', async () => {
    const { onChange, registry } = build();
    await registry.invoke(SETTINGS_VISIBILITY_COMMAND, {}, USER);
    expect(onChange).toHaveBeenLastCalledWith(true);
    await registry.invoke(SETTINGS_VISIBILITY_COMMAND, {}, USER);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('does not report a change that is not one', async () => {
    const { onChange, registry } = build();
    await registry.invoke(SETTINGS_VISIBILITY_COMMAND, { open: false }, USER);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('answers the state it is now in, so a caller need not track it', async () => {
    const { registry } = build();
    const answer = await registry.invoke(SETTINGS_VISIBILITY_COMMAND, { open: true }, USER);
    expect(answer).toMatchObject({ ok: true, value: { open: true } });
  });
});
