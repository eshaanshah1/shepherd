// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { makePane, type Pane } from '@shepherd/core/layout';
import type { PaneDiagnostics, PaneTerminals } from './pane-sessions.ts';
import { TerminalPane } from './terminal-pane.tsx';
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
    close: (paneId) => calls.push({ name: 'close', paneId }),
    focus: (paneId) => calls.push({ name: 'focus', paneId }),
    fit: (paneId) => calls.push({ name: 'fit', paneId }),
    inspect: (): PaneDiagnostics | undefined => undefined,
  };
}

const names = (spy: SpyTerminals): string[] => spy.calls.map((call) => call.name);

function render(spy: SpyTerminals, pane: Pane, focused = false) {
  return mount(<TerminalPane pane={pane} terminals={spy} focused={focused} />);
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

  it('detaches on unmount and NEVER closes', () => {
    const spy = spyTerminals();
    const pane = makePane({});
    render(spy, pane).unmount();

    expect(names(spy)).toEqual(['attach', 'detach']);
    expect(names(spy)).not.toContain('close');
  });

  it('survives five mount/unmount cycles without ever closing', () => {
    const spy = spyTerminals();
    const pane = makePane({});
    for (let i = 0; i < 5; i += 1) render(spy, pane).unmount();

    expect(names(spy).filter((n) => n === 'attach')).toHaveLength(5);
    expect(names(spy).filter((n) => n === 'detach')).toHaveLength(5);
    expect(names(spy)).not.toContain('close');
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
