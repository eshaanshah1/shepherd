// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { mount } from './test-dom.ts';
import { Switch } from './switch.tsx';

describe('Switch', () => {
  it('is a switch whose state and name a screen reader can read', () => {
    const { container } = mount(<Switch checked label="Follow the system" onChange={() => {}} />);
    const control = container.querySelector('[role="switch"]');
    expect(control?.getAttribute('aria-checked')).toBe('true');
    expect(control?.getAttribute('aria-label')).toBe('Follow the system');
  });

  it('reports the value it would become, not the one it has', () => {
    const onChange = vi.fn();
    const { container } = mount(<Switch checked={false} label="X" onChange={onChange} />);
    container.querySelector<HTMLElement>('[role="switch"]')?.click();
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('does not report while disabled', () => {
    const onChange = vi.fn();
    const { container } = mount(<Switch checked={false} label="X" disabled onChange={onChange} />);
    container.querySelector<HTMLElement>('[role="switch"]')?.click();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('is a button, so the keyboard reaches it without a handler of ours', () => {
    // Space and Enter on a <button> are the platform's, and a div with
    // role="switch" would need both re-implemented — badly, twice.
    const { container } = mount(<Switch checked label="X" onChange={() => {}} />);
    expect(container.querySelector('[role="switch"]')?.tagName).toBe('BUTTON');
    expect(container.querySelector<HTMLButtonElement>('[role="switch"]')?.type).toBe('button');
  });
});
