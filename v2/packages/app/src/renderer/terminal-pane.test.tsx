// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { makePane, type Pane } from '@shepherd/core/layout';
import { palette } from '@shepherd/design-tokens';
import type { PaneDiagnostics, PaneTerminals } from './pane-sessions.ts';
import { TerminalPane } from './terminal-pane.tsx';
import { terminalBackground } from './theme.ts';
import { mount, one } from './test-dom.ts';

/**
 * The React half of the v1 root finding. `pane-sessions.test.ts` proves the
 * registry never kills on `detach`; this proves the component never asks for
 * anything BUT `detach` — so between them there is no path from a React
 * lifecycle event to a dead session.
 */

interface SpyTerminals extends PaneTerminals {
  readonly calls: Array<{ name: string; paneId: string }>;
  readonly hosts: HTMLElement[];
}

function spyTerminals(): SpyTerminals {
  const calls: Array<{ name: string; paneId: string }> = [];
  const hosts: HTMLElement[] = [];
  return {
    calls,
    hosts,
    attach: (pane, host) => {
      calls.push({ name: 'attach', paneId: pane.id });
      hosts.push(host);
    },
    detach: (paneId) => calls.push({ name: 'detach', paneId }),
    release: (paneId) => calls.push({ name: 'release', paneId }),
    focus: (paneId) => calls.push({ name: 'focus', paneId }),
    fit: (paneId) => calls.push({ name: 'fit', paneId }),
    inspect: (): PaneDiagnostics | undefined => undefined,
  };
}

const names = (spy: SpyTerminals): string[] => spy.calls.map((call) => call.name);

function render(spy: SpyTerminals, pane: Pane, focused = false, background?: string) {
  return mount(
    <TerminalPane
      pane={pane}
      terminals={spy}
      focused={focused}
      {...(background === undefined ? {} : { background })}
    />,
  );
}

describe('TerminalPane lifecycle', () => {
  it('attaches once on mount, into the element it rendered', () => {
    const spy = spyTerminals();
    const pane = makePane({});
    const view = render(spy, pane);

    expect(names(spy)).toEqual(['attach']);
    expect(spy.calls[0]?.paneId).toBe(pane.id);
    expect(spy.hosts[0]).toBe(one(view.container, 'terminal-host'));
    view.unmount();
  });

  it('detaches on unmount and NEVER releases the pane', () => {
    const spy = spyTerminals();
    const pane = makePane({});
    render(spy, pane).unmount();

    expect(names(spy)).toEqual(['attach', 'detach']);
    expect(names(spy)).not.toContain('release');
  });

  it('survives five mount/unmount cycles without ever closing', () => {
    const spy = spyTerminals();
    const pane = makePane({});
    for (let i = 0; i < 5; i += 1) render(spy, pane).unmount();

    expect(names(spy).filter((n) => n === 'attach')).toHaveLength(5);
    expect(names(spy).filter((n) => n === 'detach')).toHaveLength(5);
    expect(names(spy)).not.toContain('release');
    // Every call named the same pane, so a remount is the same session.
    expect(new Set(spy.calls.map((call) => call.paneId))).toEqual(new Set([pane.id]));
  });

  it('does NOT re-attach when the pane object changes but its id does not', () => {
    // v1's exact defect one layer along: a re-render that tears the view down
    // for a title. Here it would only cost a terminal, not a `claude` — but the
    // dependency list is the thing that decides which of those it is.
    const spy = spyTerminals();
    const pane = makePane({ userTitle: 'before' });
    const view = render(spy, pane);
    view.rerender(
      <TerminalPane pane={{ ...pane, title: 'zsh', userTitle: 'after' }} terminals={spy} focused />,
    );

    expect(names(spy)).toEqual(['attach', 'focus']);
    view.unmount();
  });

  it('swaps cleanly when the id really does change', () => {
    const spy = spyTerminals();
    const first = makePane({});
    const second = makePane({});
    const view = render(spy, first);
    view.rerender(<TerminalPane pane={second} terminals={spy} focused={false} />);

    expect(spy.calls).toEqual([
      { name: 'attach', paneId: first.id },
      { name: 'detach', paneId: first.id },
      { name: 'attach', paneId: second.id },
    ]);
    view.unmount();
  });

  it('focuses the terminal only while the pane is the focused one', () => {
    const spy = spyTerminals();
    const pane = makePane({});
    const view = render(spy, pane, false);
    expect(names(spy)).toEqual(['attach']);

    view.rerender(<TerminalPane pane={pane} terminals={spy} focused />);
    expect(names(spy)).toEqual(['attach', 'focus']);
    view.unmount();
  });
});

/**
 * The pane chrome half. The bar is painted on the terminal's OWN background, so
 * everything about how it reads is decided by a colour this component is handed
 * rather than by the app's theme — and the wiring below is what makes that true
 * of the real DOM and not only of `paneTitleSurface`'s unit tests.
 */
describe('TerminalPane chrome surface', () => {
  const paneRoot = (container: HTMLElement): HTMLElement => {
    const found = container.querySelector<HTMLElement>('.sh-pane');
    if (found === null) throw new Error('no .sh-pane rendered');
    return found;
  };

  it('publishes its grid colour and the surface measured from it', () => {
    const spy = spyTerminals();
    const view = render(spy, makePane({}));
    const root = paneRoot(view.container);

    expect(root.style.getPropertyValue('--sh-pane-title-bg')).toBe(terminalBackground());
    expect(root.dataset['paneTitleSurface']).toBe('dark');
    view.unmount();
  });

  it('reads a light terminal background as a light surface, with the app theme untouched', () => {
    // The case the app-mode flag cannot express: an extension themes ONE pane's
    // grid light while everything around it stays dark. Without this the head
    // would draw near-white text on near-white ground — and silently, because
    // nothing else in the app changes.
    const spy = spyTerminals();
    const view = render(spy, makePane({}), false, palette['ink-term'].light);
    const root = paneRoot(view.container);

    expect(root.style.getPropertyValue('--sh-pane-title-bg')).toBe(palette['ink-term'].light);
    expect(root.dataset['paneTitleSurface']).toBe('light');
    view.unmount();
  });

  it('re-reads the surface when the grid colour changes under it', () => {
    const spy = spyTerminals();
    const pane = makePane({});
    const view = render(spy, pane, false, '#000000');
    expect(paneRoot(view.container).dataset['paneTitleSurface']).toBe('dark');

    view.rerender(
      <TerminalPane pane={pane} terminals={spy} focused={false} background="#FFFFFF" />,
    );
    expect(paneRoot(view.container).dataset['paneTitleSurface']).toBe('light');
    // And it is a re-render, not a remount: a live theme swap must not cost the
    // scrollback. Same rule as the title-change case above.
    expect(names(spy)).toEqual(['attach']);
    view.unmount();
  });

  it('puts the head and the grid host under the same colour variable', () => {
    // One declaration, inherited by both — the bar and the padding around the
    // grid cannot end up a shade apart.
    const spy = spyTerminals();
    const view = render(spy, makePane({}), false, '#123456');
    const root = paneRoot(view.container);

    expect(root.contains(one(view.container, 'pane-head'))).toBe(true);
    expect(root.contains(one(view.container, 'terminal-host'))).toBe(true);
    expect(root.style.getPropertyValue('--sh-pane-title-bg')).toBe('#123456');
    view.unmount();
  });
});
