// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type { SettingSpec } from '@shepherd/sdk';
import { mount } from './test-dom.ts';
import { SettingRow } from './settings-rows.tsx';

const base = { isDefault: true, onChange: () => {}, onReset: () => {} };

const type = (input: HTMLInputElement, text: string): void => {
  act(() => {
    // React's own setter, so the synthetic change carries the new value —
    // assigning `input.value` directly is invisible to React's state. Same helper
    // `command-palette.test.tsx` uses, and for the same reason.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('SettingRow', () => {
  it('draws a boolean as a Switch and reports the flipped value', () => {
    const onChange = vi.fn();
    const { container } = mount(
      <SettingRow
        {...base}
        spec={{ key: 'x.flag', type: 'boolean', label: 'Flag', default: false }}
        value={false}
        onChange={onChange}
      />,
    );
    act(() => container.querySelector<HTMLElement>('[role="switch"]')?.click());
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('draws a string as a Field and reports what was typed', () => {
    const onChange = vi.fn();
    const { container } = mount(
      <SettingRow
        {...base}
        spec={{ key: 'x.name', type: 'string', label: 'Name', default: '' }}
        value=""
        onChange={onChange}
      />,
    );
    type(container.querySelector<HTMLInputElement>('input')!, 'hello');
    expect(onChange).toHaveBeenCalledWith('hello');
  });

  it('draws an enum with static choices as a Select', () => {
    const spec: SettingSpec = {
      key: 'x.theme',
      type: 'enum',
      label: 'Theme',
      default: 'dark',
      choices: [{ value: 'dark', label: 'Dark' }],
    };
    const { container } = mount(<SettingRow {...base} spec={spec} value="dark" />);
    expect(container.querySelector('[data-testid="select-trigger"]')).not.toBeNull();
  });

  it('never reports NaN from a half-typed number', () => {
    const onChange = vi.fn();
    const { container } = mount(
      <SettingRow
        {...base}
        spec={{ key: 'x.n', type: 'number', label: 'N', default: 1 }}
        value={1}
        onChange={onChange}
      />,
    );
    const input = container.querySelector<HTMLInputElement>('input')!;
    type(input, '');
    type(input, '12');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(12);
  });

  it('shows no reset affordance for an untouched value, and one for a changed value', () => {
    const spec: SettingSpec = { key: 'x.n', type: 'string', label: 'N', default: 'a' };
    const untouched = mount(<SettingRow {...base} spec={spec} value="a" />);
    expect(untouched.container.querySelector('[data-testid="setting-reset"]')).toBeNull();
    const changed = mount(<SettingRow {...base} isDefault={false} spec={spec} value="b" />);
    expect(changed.container.querySelector('[data-testid="setting-reset"]')).not.toBeNull();
  });

  it('resets through the callback rather than writing a default itself', () => {
    const onReset = vi.fn();
    const { container } = mount(
      <SettingRow
        {...base}
        isDefault={false}
        spec={{ key: 'x.n', type: 'string', label: 'N', default: 'a' }}
        value="b"
        onReset={onReset}
      />,
    );
    act(() => container.querySelector<HTMLElement>('[data-testid="setting-reset"]')?.click());
    expect(onReset).toHaveBeenCalled();
  });

  it('keeps a stored value VISIBLE when its choices failed to load, and says why', () => {
    /**
     * The vendor could not be asked. A stored value you can neither see nor change
     * is a setting you cannot undo — the claim this test has always made.
     *
     * What changed is the CONTROL, not the claim: the row used to degrade to a
     * free-text `Field` (hence the old `querySelector('input')`), and it now keeps
     * its shape as a disabled `Select` showing the stored value. So the value is
     * still visible and the reason still reachable; it is no longer editable
     * in place, and the affordance for acting on it is `retry` — asserted below.
     */
    const { container } = mount(
      <SettingRow
        {...base}
        spec={{ key: 'x.model', type: 'enum', label: 'Model', default: null, nullable: true, choicesFrom: 'x.models' }}
        value="opus"
        choicesError="x.models is not a registered command"
        onRetryChoices={() => {}}
      />,
    );
    expect(container.textContent).toContain('opus');
    expect(container.textContent).toContain('not a registered command');
    expect(container.querySelector('[data-testid="setting-retry"]')).not.toBeNull();
  });

  it('says No choices only when there is no stored value to show', () => {
    const { container } = mount(
      <SettingRow
        {...base}
        spec={{ key: 'x.model', type: 'enum', label: 'Model', default: null, nullable: true, choicesFrom: 'x.models' }}
        value={null}
        choicesError="x.models is not a registered command"
      />,
    );
    expect(container.textContent).toContain('No choices');
  });

  it('keeps the raw message reachable but CLOSED, so the page is not shouting', () => {
    // It is the only place the failing command's own words are visible, and a
    // failure whose text nobody can reach is a failure nobody can report.
    const { container } = mount(
      <SettingRow
        {...base}
        spec={{ key: 'x.model', type: 'enum', label: 'Model', default: null, nullable: true, choicesFrom: 'x.models' }}
        value={null}
        choicesError="x.models is not a registered command"
      />,
    );
    const raw = container.querySelector<HTMLDetailsElement>('[data-testid="setting-raw"]');
    expect(raw).not.toBeNull();
    expect(raw?.open).toBe(false);
  });

  it('keeps a failed write visible on its own row', () => {
    const { container } = mount(
      <SettingRow
        {...base}
        spec={{ key: 'x.n', type: 'string', label: 'N', default: 'a' }}
        value="a"
        error="shepherd.theme: must be one of system, dark, light"
      />,
    );
    expect(container.textContent).toContain('must be one of');
  });

  it('re-syncs a field when the value changes underneath it', () => {
    // A write from the CLI in a pane behind the window reaches the screen as a
    // new value, and a field holding only its own draft would ignore it.
    const spec: SettingSpec = { key: 'x.name', type: 'string', label: 'Name', default: '' };
    const ui = mount(<SettingRow {...base} spec={spec} value="one" />);
    ui.rerender(<SettingRow {...base} spec={spec} value="two" />);
    expect(ui.container.querySelector<HTMLInputElement>('input')?.value).toBe('two');
  });

  it('points its label at its own control', () => {
    const { container } = mount(
      <SettingRow {...base} spec={{ key: 'x.name', type: 'string', label: 'Name', default: '' }} value="" />,
    );
    const label = container.querySelector('label');
    expect(label?.getAttribute('for')).toBe(container.querySelector('input')?.id);
  });
});
