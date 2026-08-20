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

const list = (container: HTMLElement): HTMLElement | null =>
  container.querySelector<HTMLElement>('[role="listbox"]');

/**
 * jsdom lays nothing out — every rect is zero and every `scrollHeight` is zero —
 * so the geometry the flip reads has to be supplied. `top`/`bottom` are the
 * trigger's; `panel` is the list's content height.
 */
const geometry = ({
  top,
  bottom,
  viewport,
  panel,
  clip = { top: 0, bottom: viewport },
}: {
  top: number;
  bottom: number;
  viewport: number;
  panel: number;
  clip?: { top: number; bottom: number };
}): (() => void) => {
  const rect = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect');
  const height = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
  const innerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
  Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: Element): DOMRect {
      // A `.clip` ancestor stands in for a scroll box; everything else answers as
      // the trigger.
      const box = this.classList.contains('clip') ? clip : { top, bottom };
      return { ...box, left: 0, right: 0, width: 0, height: box.bottom - box.top } as DOMRect;
    },
  });
  Object.defineProperty(Element.prototype, 'scrollHeight', { configurable: true, get: () => panel });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: viewport });
  return () => {
    if (rect !== undefined) Object.defineProperty(Element.prototype, 'getBoundingClientRect', rect);
    if (height !== undefined) Object.defineProperty(Element.prototype, 'scrollHeight', height);
    if (innerHeight !== undefined) Object.defineProperty(window, 'innerHeight', innerHeight);
  };
};

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

  it('draws a label and nothing else — no metadata, no leading slot', () => {
    // A list of labels. `Row` holds a 12px leading slot open for a `StateMark` so a
    // list's labels share an x position, and an option never has one — kept, it is
    // an indent nothing can fill.
    const { container } = mount(<Select value="dark" options={OPTIONS} label="Theme" onChange={() => {}} />);
    open(container);
    const option = options(container)[0];
    expect(option?.textContent).toBe('Dark');
    expect(option?.querySelector('.sh-ui-row__leading')).toBeNull();
  });

  it('opens upward when the room below the trigger has run out', () => {
    // The composer's control row is the LAST row of a card inside a modal that is
    // `overflow: auto`, so a list that only ever opens downward is a list that is
    // always clipped.
    const restore = geometry({ top: 700, bottom: 728, viewport: 740, panel: 200 });
    try {
      const { container } = mount(<Select value="dark" options={OPTIONS} label="Theme" onChange={() => {}} />);
      open(container);
      expect(list(container)?.getAttribute('data-drop')).toBe('up');
      // The room it reported is the space it opened INTO, measured from the
      // trigger — the stylesheet clamps `max-height` to it.
      expect(list(container)?.style.getPropertyValue('--sh-ui-select-room')).toBe('700px');
    } finally {
      restore();
    }
  });

  it('opens downward when there is room, and does not flip for the sake of it', () => {
    const restore = geometry({ top: 40, bottom: 68, viewport: 740, panel: 200 });
    try {
      const { container } = mount(<Select value="dark" options={OPTIONS} label="Theme" onChange={() => {}} />);
      open(container);
      expect(list(container)?.getAttribute('data-drop')).toBe('down');
      expect(list(container)?.style.getPropertyValue('--sh-ui-select-room')).toBe('672px');
    } finally {
      restore();
    }
  });

  it('stays put when neither side fits, rather than flipping into a worse one', () => {
    // 200px of list, 100px below and 60px above. Upward is the smaller side, so
    // the list opens down and the room it reports is what the sheet clamps to.
    const restore = geometry({ top: 60, bottom: 88, viewport: 188, panel: 200 });
    try {
      const { container } = mount(<Select value="dark" options={OPTIONS} label="Theme" onChange={() => {}} />);
      open(container);
      expect(list(container)?.getAttribute('data-drop')).toBe('down');
      expect(list(container)?.style.getPropertyValue('--sh-ui-select-room')).toBe('100px');
    } finally {
      restore();
    }
  });

  it('measures the nearest CLIPPING ancestor, not the viewport', () => {
    // The composer's card sits in a `Modal` that is `overflow: auto`, so a list
    // opening from its last row has half a screen of viewport under it and one row
    // of the box it is actually inside. Measuring the window says there is room
    // and the scroll box cuts it off anyway.
    const restore = geometry({ top: 340, bottom: 368, viewport: 900, panel: 120, clip: { top: 100, bottom: 400 } });
    try {
      const { container } = mount(
        <div className="clip" style={{ overflowY: 'auto' }}>
          <Select value="dark" options={OPTIONS} label="Theme" onChange={() => {}} />
        </div>,
      );
      open(container);
      expect(list(container)?.getAttribute('data-drop')).toBe('up');
      // 340 − 100: from the trigger's top to the SCROLL BOX's top edge, not the
      // window's.
      expect(list(container)?.style.getPropertyValue('--sh-ui-select-room')).toBe('240px');
    } finally {
      restore();
    }
  });

  it('draws an em dash for a value that is in no option, rather than an empty control', () => {
    // Reachable: a stored model id the vendor has since retired.
    const { container } = mount(<Select value="retired" options={OPTIONS} label="Model" onChange={() => {}} />);
    expect(container.textContent).toContain('—');
  });
});
