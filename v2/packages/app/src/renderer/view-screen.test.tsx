// @vitest-environment jsdom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ExtensionViewProps } from '@shepherd/sdk';
import type { ViewContributionDTO, ViewsApi } from '../shared/index.ts';
import { mount } from './test-dom.ts';

/**
 * The takeover layer — `surface: 'screen'`.
 *
 * Four claims, and each one is a thing the OVERLAY got for free from Radix and
 * this layer has to do itself. That asymmetry is the reason the file exists:
 * every line below covers behaviour that was previously somebody else's, which
 * is exactly the class of thing a port loses silently.
 *
 * The fifth claim — that it does not cover the rail — is a CSS fact and is
 * asserted where CSS facts are, in `view-screen.css.test.ts`'s absence: the rule
 * lives in `styles.css` under `.sh-screen`, positioned against `.sh-stage`, and
 * jsdom computes no layout to assert it with. It is called out here so the gap
 * is a decision rather than an oversight.
 */

function Composer(props: ExtensionViewProps): React.JSX.Element {
  return (
    <div data-testid="composer">
      <button type="button" data-testid="composer-done" onClick={() => props.done()}>
        done
      </button>
    </div>
  );
}

function Palette(): React.JSX.Element {
  return <div data-testid="palette" />;
}

vi.mock('./extension-ui.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('./extension-ui.ts')>();
  return {
    ...original,
    resolveExtensionUi: (component: string | undefined) =>
      component === 'tasks.composer' ? Composer : component === 'x.palette' ? Palette : undefined,
  };
});

const { ViewScreen } = await import('./view-screen.tsx');

const COMPOSER: ViewContributionDTO = {
  extension: 'shepherd.tasks',
  type: 'tasks.composer',
  kind: 'component',
  component: 'tasks.composer',
  surface: 'screen',
  key: 'CmdOrCtrl+N',
  title: 'New task',
};

const SECOND: ViewContributionDTO = {
  extension: 'x',
  type: 'x.palette',
  kind: 'component',
  component: 'x.palette',
  surface: 'screen',
  key: 'CmdOrCtrl+J',
  title: 'Palette',
};

/** A view on every OTHER surface, none of which this layer may draw. */
const OTHERS: readonly ViewContributionDTO[] = [
  { extension: 'a', type: 'a.dock', kind: 'component', component: 'x.palette', surface: 'dock' },
  { extension: 'b', type: 'b.card', kind: 'component', component: 'x.palette', surface: 'overlay', key: 'CmdOrCtrl+B' },
  { extension: 'c', type: 'c.pane', kind: 'component', component: 'x.palette', surface: 'pane' },
];

const bridge = (): ViewsApi =>
  ({
    list: () => Promise.resolve({ ok: true, value: [] }),
    children: () => Promise.resolve({ ok: true, value: [] }),
    activate: () => Promise.resolve({ ok: true, value: undefined }),
    invoke: () => Promise.resolve({ ok: true, value: undefined }),
  }) as unknown as ViewsApi;

const press = (key: string, mods: { meta?: boolean; shift?: boolean } = {}): void => {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, metaKey: mods.meta ?? false }),
    );
  });
};

describe('the takeover screen', () => {
  it('draws nothing until its accelerator is pressed', () => {
    const { container, unmount } = mount(<ViewScreen views={[COMPOSER]} bridge={bridge()} />);
    expect(container.querySelector('[data-testid="view-screen"]')).toBeNull();
    press('n', { meta: true });
    expect(container.querySelector('[data-testid="composer"]')).not.toBeNull();
    unmount();
  });

  it('closes on the same key that opened it', () => {
    const { container, unmount } = mount(<ViewScreen views={[COMPOSER]} bridge={bridge()} />);
    press('n', { meta: true });
    press('n', { meta: true });
    expect(container.querySelector('[data-testid="view-screen"]')).toBeNull();
    unmount();
  });

  /*
   * Esc is OURS here, and it was Radix's in the overlay.
   *
   * `ViewOverlay` has a comment saying Esc is deliberately not handled there,
   * because the Dialog closes on it and a second listener would fire after the
   * modal is gone. There is no Dialog on this layer, so the same comment would
   * be a bug — the key had to come back, and this is what says it did.
   */
  it('closes on Escape, which nothing else on this layer does for it', () => {
    const { container, unmount } = mount(<ViewScreen views={[COMPOSER]} bridge={bridge()} />);
    press('n', { meta: true });
    press('Escape');
    expect(container.querySelector('[data-testid="view-screen"]')).toBeNull();
    unmount();
  });

  /*
   * And it stays off the terminal's keyboard while nothing is up.
   *
   * A global Escape listener that runs whether or not a screen is open is a key
   * deleted from every pty in the app — v1's menu-accelerator lesson, arriving
   * this time as a plain `window` handler. The guard is `open !== null`, and an
   * Escape that reaches an unopened layer must be left entirely alone.
   */
  it('does not swallow Escape while it is closed', () => {
    const { unmount } = mount(<ViewScreen views={[COMPOSER]} bridge={bridge()} />);
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    unmount();
  });

  it('swallows its own accelerator, so the focused pty never sees it', () => {
    const { unmount } = mount(<ViewScreen views={[COMPOSER]} bridge={bridge()} />);
    const event = new KeyboardEvent('keydown', { key: 'n', metaKey: true, bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    unmount();
  });

  /*
   * A SINGLETON, which is the claim that separates this from every other layer.
   *
   * Two takeovers on one stage is a state with no way out that the user can see:
   * nothing about a full-bleed surface suggests there is another one behind it,
   * so Escape appears to do nothing the first time it is pressed.
   */
  it('shows one screen at a time, and raising a second replaces the first', () => {
    const { container, unmount } = mount(<ViewScreen views={[COMPOSER, SECOND]} bridge={bridge()} />);
    press('n', { meta: true });
    press('j', { meta: true });
    expect(container.querySelectorAll('[data-testid="view-screen"]').length).toBe(1);
    expect(container.querySelector('[data-testid="palette"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="composer"]')).toBeNull();
    unmount();
  });

  it('closes when the component says it is finished', () => {
    const { container, unmount } = mount(<ViewScreen views={[COMPOSER]} bridge={bridge()} />);
    press('n', { meta: true });
    act(() => {
      container.querySelector<HTMLElement>('[data-testid="composer-done"]')?.click();
    });
    expect(container.querySelector('[data-testid="view-screen"]')).toBeNull();
    unmount();
  });

  /*
   * The filter, asserted from the other side.
   *
   * `screen` was added to a `surface` union that four hand-maintained copies
   * spell out, and the failure mode CLAUDE.md records for exactly this shape is
   * a value that type-checks everywhere and is drawn by two layers at once. A
   * dock view, an overlay and a pane are all in this list; none of them may
   * appear here, and the overlay's accelerator must not raise this layer either.
   */
  it('draws no view from another surface, and answers no other surface’s key', () => {
    const { container, unmount } = mount(<ViewScreen views={OTHERS} bridge={bridge()} />);
    press('b', { meta: true });
    expect(container.querySelector('[data-testid="view-screen"]')).toBeNull();
    expect(container.querySelector('[data-testid="palette"]')).toBeNull();
    unmount();
  });

  /*
   * The click path the rail's own buttons use. An event rather than a prop for
   * the reason `ViewOverlay` gives: the button lives in the dock's header and
   * this layer is a sibling three levels up.
   */
  it('is raised by the same event the sidebar button dispatches', () => {
    const { container, unmount } = mount(<ViewScreen views={[COMPOSER]} bridge={bridge()} />);
    act(() => {
      window.dispatchEvent(new CustomEvent('sh:raise-view', { detail: 'tasks.composer' }));
    });
    expect(container.querySelector('[data-testid="composer"]')).not.toBeNull();
    unmount();
  });

  it('names itself for anyone who cannot see that the stage was taken over', () => {
    const { container, unmount } = mount(<ViewScreen views={[COMPOSER]} bridge={bridge()} />);
    press('n', { meta: true });
    const screen = container.querySelector<HTMLElement>('[data-testid="view-screen"]')!;
    expect(screen.getAttribute('role')).toBe('dialog');
    expect(screen.getAttribute('aria-modal')).toBe('true');
    expect(screen.getAttribute('aria-label')).toBe('New task');
    unmount();
  });
});
