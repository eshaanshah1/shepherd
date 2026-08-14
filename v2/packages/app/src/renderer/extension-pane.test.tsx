// @vitest-environment jsdom
import { useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ExtensionPaneProps } from '@shepherd/sdk';
import { makePane } from '@shepherd/core/layout';
import type { ViewContributionDTO, ViewsApi } from '../shared/index.ts';
import { all, mount, one } from './test-dom.ts';

/**
 * A pane that is a contributed view (ADR 0044).
 *
 * The claims worth a test are the three the shell makes and one it refuses:
 * the component is resolved by NAME against a static table, its props are stable
 * across the parent's re-renders, `done()` closes the pane — and an
 * unresolvable name says which of the two absences it is rather than drawing an
 * empty rectangle.
 *
 * The table is mocked rather than seeded, because the real one is the
 * production registry and a test entry in it would ship.
 */

/** Counts its own mounts, so a props change that remounts it is visible. */
let mounts = 0;
/** Every props object the component has been handed, newest last. */
const seen: ExtensionPaneProps[] = [];

function Review(props: ExtensionPaneProps): React.JSX.Element {
  seen.push(props);
  const [asked, setAsked] = useState<unknown>(null);
  const { invoke } = props;
  // Depends on `invoke` and on nothing else, which is the whole test: the props
  // are memoized, so a stable `invoke` runs this once however often the parent
  // re-renders — and an unstable one re-runs it, which is the defect.
  useEffect(() => {
    mounts += 1;
    void invoke('github.prs').then((result) => setAsked(result.ok ? result.value : 'failed'));
  }, [invoke]);
  return (
    <div data-testid="review">
      <span data-testid="review-state">{JSON.stringify(props.state)}</span>
      <span data-testid="review-focused">{String(props.focused)}</span>
      <span data-testid="review-asked">{JSON.stringify(asked)}</span>
      <button type="button" data-testid="review-done" onClick={() => props.done()}>
        close
      </button>
    </div>
  );
}

vi.mock('./extension-ui.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('./extension-ui.ts')>();
  return {
    ...original,
    resolveExtensionPaneUi: (component: string | undefined) =>
      component === 'github.review' ? Review : undefined,
  };
});

const { ExtensionPane } = await import('./extension-pane.tsx');

const CONTRIBUTION: ViewContributionDTO = {
  extension: 'shepherd.github',
  type: 'github.review',
  kind: 'component',
  component: 'github.review',
  surface: 'pane',
};

function bridge(calls: string[]): ViewsApi {
  return {
    list: () => Promise.resolve({ ok: true, value: [CONTRIBUTION] }),
    children: () => Promise.resolve({ ok: true, value: [] }),
    activate: () => Promise.resolve({ ok: true, value: undefined }),
    invoke: (_type, command) => {
      calls.push(command);
      return Promise.resolve({ ok: true, value: { prs: 3 } });
    },
    present: () => Promise.resolve({ ok: true, value: { shown: true } }),
    onChanged: () => () => {},
  };
}

const pane = makePane({ view: { type: 'github.review', state: { task: 't-1' } } });

function render(overrides: { focused?: boolean; onDone?: () => void; calls?: string[] } = {}) {
  const view = pane.view ?? { type: 'github.review' };
  return (
    <ExtensionPane
      pane={pane}
      view={view}
      views={[CONTRIBUTION]}
      bridge={bridge(overrides.calls ?? [])}
      focused={overrides.focused ?? true}
      onDone={overrides.onDone ?? (() => {})}
    />
  );
}

describe('ExtensionPane', () => {
  it('resolves the contributed component by name and hands it the pane subject', () => {
    const { container, unmount } = mount(render());
    expect(one(container, 'review-state').textContent).toBe('{"task":"t-1"}');
    expect(one(container, 'review-focused').textContent).toBe('true');
    unmount();
  });

  it('binds invoke to THIS view type, so the component cannot name a caller', () => {
    const calls: string[] = [];
    const { unmount } = mount(render({ calls }));
    expect(calls).toEqual(['github.prs']);
    unmount();
  });

  it('draws no pane head — the view owns the rectangle', () => {
    // A terminal gets a head because a grid cannot say what it is. A view can,
    // and a shell-drawn title over a view that titles itself is the
    // repeated-name rule broken by the shell rather than by an extension.
    const { container, unmount } = mount(render());
    expect(all(container, 'pane-head')).toHaveLength(0);
    unmount();
  });

  it('keeps the component mounted across a parent re-render with the same inputs', () => {
    // The defect this is about: fresh props on every parent render cancel the
    // asks the pane made on mount, and the stage re-renders on every layout and
    // agent snapshot.
    mounts = 0;
    const onDone = (): void => {};
    const calls: string[] = [];
    const node = render({ onDone, calls });
    const { rerender, unmount } = mount(node);
    expect(mounts).toBe(1);
    rerender(node);
    rerender(node);
    expect(mounts).toBe(1);
    expect(calls).toEqual(['github.prs']);
    unmount();
  });

  it('reports done() to the shell, which is what closes the pane', () => {
    let closed = 0;
    const { container, unmount } = mount(render({ onDone: () => (closed += 1) }));
    one(container, 'review-done').click();
    expect(closed).toBe(1);
    unmount();
  });

  it('says it is WAITING when nothing has contributed the type yet', () => {
    // Ordinary, and happens on every launch for a moment: a persisted pane is
    // restored before its extension activates. It resolves itself.
    const { container, unmount } = mount(
      <ExtensionPane
        pane={pane}
        view={{ type: 'github.review' }}
        views={[]}
        bridge={bridge([])}
        focused
        onDone={() => {}}
      />,
    );
    expect(one(container, 'pane-view-missing').textContent).toContain('Waiting for');
    unmount();
  });

  it('says the BUILD has no UI when the contribution names a component it does not have', () => {
    // Version skew, which does not resolve itself — so it must not be reported
    // as something you can wait for.
    const { container, unmount } = mount(
      <ExtensionPane
        pane={pane}
        view={{ type: 'github.review' }}
        views={[{ ...CONTRIBUTION, component: 'github.somethingelse' }]}
        bridge={bridge([])}
        focused
        onDone={() => {}}
      />,
    );
    expect(one(container, 'pane-view-missing').textContent).toContain('no UI for');
    unmount();
  });
});
