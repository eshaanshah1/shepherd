// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { mount } from './test-dom.ts';
import { BRAILLE_FRAMES } from './spinner.ts';
import { Select } from './select.tsx';

const OPTIONS = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

const open = (container: HTMLElement): void => {
  act(() => container.querySelector<HTMLElement>('[data-testid="select-trigger"]')?.click());
};

const options = (container: HTMLElement): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[role="option"]'),
];

describe('Select', () => {
  it('shows the LABEL of the current value, not the value', () => {
    const { container } = mount(<Select value="light" options={OPTIONS} label="Theme" onChange={() => {}} />);
    expect(container.textContent).toContain('Light');
    expect(container.textContent).not.toContain('light');
  });

  it('opens a listbox and reports the chosen value', () => {
    const onChange = vi.fn();
    const { container } = mount(<Select value="dark" options={OPTIONS} label="Theme" onChange={onChange} />);
    open(container);
    expect(options(container)).toHaveLength(2);
    act(() => options(container)[1]?.click());
    expect(onChange).toHaveBeenCalledWith('light');
  });

  it('closes once something is chosen', () => {
    const { container } = mount(<Select value="dark" options={OPTIONS} label="Theme" onChange={() => {}} />);
    open(container);
    act(() => options(container)[1]?.click());
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it('marks the current option selected, so the list says where you are', () => {
    const { container } = mount(<Select value="light" options={OPTIONS} label="Theme" onChange={() => {}} />);
    open(container);
    expect(options(container).map((option) => option.getAttribute('aria-selected'))).toEqual(['false', 'true']);
  });

  it('draws a Default entry for a nullable select and reports null for it', () => {
    const onChange = vi.fn();
    const { container } = mount(<Select value={null} nullable options={OPTIONS} label="Kind" onChange={onChange} />);
    expect(container.textContent).toContain('Default');
    open(container);
    act(() => options(container)[0]?.click());
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('shows the braille spinner and refuses to open while busy', () => {
    // An empty listbox would read as "there are no choices", which is a different
    // and wrong answer to "they have not arrived yet".
    const { container } = mount(<Select value={null} nullable busy options={[]} label="Kind" onChange={() => {}} />);
    open(container);
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(BRAILLE_FRAMES.some((frame) => container.textContent?.includes(frame))).toBe(true);
  });

  it('closes on Escape without reporting a change', () => {
    const onChange = vi.fn();
    const { container } = mount(<Select value="dark" options={OPTIONS} label="Theme" onChange={onChange} />);
    open(container);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('walks the list with the arrow keys and commits on Enter', () => {
    const onChange = vi.fn();
    const { container } = mount(<Select value="dark" options={OPTIONS} label="Theme" onChange={onChange} />);
    open(container);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith('light');
  });

  it('says what it is, on the trigger and on the list', () => {
    const { container } = mount(<Select value="dark" options={OPTIONS} label="Theme" onChange={() => {}} />);
    const trigger = container.querySelector('[data-testid="select-trigger"]');
    expect(trigger?.getAttribute('aria-label')).toBe('Theme');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    open(container);
    expect(container.querySelector('[role="listbox"]')?.getAttribute('aria-label')).toBe('Theme');
  });

  it('draws an em dash for a value that is in no option, rather than an empty control', () => {
    // Reachable: a stored model id the vendor has since retired.
    const { container } = mount(<Select value="retired" options={OPTIONS} label="Model" onChange={() => {}} />);
    expect(container.textContent).toContain('—');
  });
});
