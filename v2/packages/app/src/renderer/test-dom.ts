import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';

/**
 * The three lines of setup every renderer test needs, without a testing-library
 * dependency: React 19 exports `act` itself, and `createRoot` is the whole API.
 */

// React refuses to run `act` outside an act environment, and says so at the top
// of the first failure rather than where the problem is.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Mounted {
  readonly container: HTMLElement;
  readonly root: Root;
  rerender(node: ReactNode): void;
  unmount(): void;
}

export function mount(node: ReactNode): Mounted {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return {
    container,
    root,
    rerender: (next) => act(() => root.render(next)),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

export function all(container: HTMLElement, testid: string): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(`[data-testid="${testid}"]`)];
}

export function one(container: HTMLElement, testid: string): HTMLElement {
  const found = all(container, testid);
  if (found.length !== 1) throw new Error(`expected exactly one [${testid}], found ${found.length}`);
  return found[0] as HTMLElement;
}

/**
 * jsdom lays nothing out: every `getBoundingClientRect()` is 0×0. A drag whose
 * ratio is `offset / width` therefore divides by zero, so a test about dragging
 * has to say how big the thing being dragged is. This stubs the prototype for
 * one test and hands back the undo.
 */
export function withFixedLayout(width: number, height: number): () => void {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function fixed(this: Element): DOMRect {
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    } as DOMRect;
  };
  return () => {
    Element.prototype.getBoundingClientRect = original;
  };
}

/** A mousedown on `target`, then moves and a mouseup dispatched on the window. */
export function drag(target: HTMLElement, points: ReadonlyArray<readonly [number, number]>): void {
  const [startX = 0, startY = 0] = points[0] ?? [];
  act(() => {
    target.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, clientX: startX, clientY: startY }),
    );
  });
  for (const [x, y] of points.slice(1)) {
    act(() => {
      globalThis.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
    });
  }
  const [endX = 0, endY = 0] = points[points.length - 1] ?? [];
  act(() => {
    globalThis.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: endX, clientY: endY }));
  });
}
