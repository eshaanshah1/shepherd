import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';

/**
 * The three lines of setup every component test needs, without a testing-library
 * dependency: React 19 exports `act` itself, and `createRoot` is the whole API.
 * The same helper the renderer uses (`app/src/renderer/test-dom.ts`) — copied
 * rather than shared, because a package that exists so extensions can import it
 * must not gain a dependency on the app to be testable.
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
