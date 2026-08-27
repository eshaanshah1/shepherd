// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Clamp } from './pr-panels.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The clamp, with its geometry FAKED — which is the only way to test it.
 *
 * jsdom has no layout, so `scrollHeight` and `clientHeight` are both 0 and the
 * measurement can never be true. That is not a reason to leave it untested: an
 * expand button that fails to appear is content silently truncated with no way
 * to reach it, which is strictly worse than not clamping at all.
 */
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  // jsdom ships no ResizeObserver either.
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
  };
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

/** Make every element report `scroll`/`client` heights, as a browser would. */
function layout(scrollHeight: number, clientHeight: number): void {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(scrollHeight);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(clientHeight);
}

const draw = (): void => {
  act(() => root.render(<Clamp><p>a body</p></Clamp>));
};

describe('Clamp', () => {
  it('offers the way out when it is actually hiding something', () => {
    layout(900, 300);
    draw();
    const more = host.querySelector('.sh-pr-clamp__more');
    expect(more?.textContent).toBe('Show more');
    // And says so to the stylesheet, which cannot measure anything itself.
    expect(host.querySelector('.sh-pr-clamp')?.getAttribute('data-over')).toBe('true');
  });

  it('stays out of the way when the whole thing already fits', () => {
    // A control that reveals nothing is worse than no control — and the fade
    // that hints at more text would otherwise veil the last line of every short
    // comment, which is what it did before this was measured.
    layout(120, 300);
    draw();
    expect(host.querySelector('.sh-pr-clamp__more')).toBeNull();
    expect(host.querySelector('.sh-pr-clamp')?.hasAttribute('data-over')).toBe(false);
  });

  it('opens in place, and can be shut again', () => {
    layout(900, 300);
    draw();
    act(() => host.querySelector<HTMLButtonElement>('.sh-pr-clamp__more')?.click());
    expect(host.querySelector('.sh-pr-clamp')?.getAttribute('data-open')).toBe('true');
    expect(host.querySelector('.sh-pr-clamp__more')?.textContent).toBe('Show less');

    act(() => host.querySelector<HTMLButtonElement>('.sh-pr-clamp__more')?.click());
    expect(host.querySelector('.sh-pr-clamp')?.hasAttribute('data-open')).toBe(false);
  });

  it('keeps the way BACK once open, even though it then fits', () => {
    /*
     * Open, the box is unclamped — so it no longer overflows and the next
     * measurement says so. Keyed on that alone the button would vanish the
     * moment it worked, stranding an expanded section with no way to collapse
     * it. Hence `over || open`.
     */
    layout(900, 300);
    draw();
    act(() => host.querySelector<HTMLButtonElement>('.sh-pr-clamp__more')?.click());

    // Now it fits, and something re-measures — a changed body re-runs the effect
    // exactly as a resize would.
    layout(900, 900);
    act(() => root.render(<Clamp><p>a longer body</p></Clamp>));

    expect(host.querySelector('.sh-pr-clamp')?.hasAttribute('data-over')).toBe(false);
    expect(host.querySelector('.sh-pr-clamp__more')?.textContent).toBe('Show less');
  });

});
