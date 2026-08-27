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

function render(
  overrides: {
    focused?: boolean;
    onClose?: (paneId: string) => void;
    calls?: string[];
    /*
     * The bridge, when the caller needs the SAME one across renders.
     *
     * It is a memoized dependency like every other prop here, and the stage
     * holds one `viewsApi` for the app's life. A test that built a fresh one per
     * render would be varying two things and learning about the wrong one, which
     * is how the first draft of the stage test below failed for a reason that
     * had nothing to do with what it was asserting.
     */
    bridge?: ViewsApi;
  } = {},
) {
  const view = pane.view ?? { type: 'github.review' };
  return (
    <ExtensionPane
      pane={pane}
      view={view}
      views={[CONTRIBUTION]}
      bridge={overrides.bridge ?? bridge(overrides.calls ?? [])}
      focused={overrides.focused ?? true}
      onClose={overrides.onClose ?? (() => {})}
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
    const onClose = (): void => {};
    const calls: string[] = [];
    const node = render({ onClose, calls });
    const { rerender, unmount } = mount(node);
    expect(mounts).toBe(1);
    rerender(node);
    rerender(node);
    expect(mounts).toBe(1);
    expect(calls).toEqual(['github.prs']);
    unmount();
  });

  /*
   * The one above supplies BOTH sides of the correlation — the same element,
   * re-rendered — so it cannot discover the two disagreeing, which is the trap
   * `CLAUDE.md` names and which this pane fell into for months. The stage does
   * not re-render the same element: it rebuilds one, and every callback written
   * inline in that rebuild is a new identity.
   *
   * Measured cost before this test existed, off `app.log`: a 3s poll running 162
   * times a minute, each fanning out to three more commands, plus ten `git`
   * spawns and an uncached GitHub request from the changes pane, plus an editor
   * pane re-walking its repo 194 times in two minutes. Unrelated commands timed
   * out at ten seconds behind the queue.
   */
  it('does not re-ask when the stage rebuilds the element with a fresh callback', () => {
    mounts = 0;
    const calls: string[] = [];
    // A NEW arrow each time, which is what a `map` over panes produces and what
    // a hook cannot memoize away at the call site.
    const stable = bridge(calls);
    const stageRender = () =>
      render({ bridge: stable, onClose: (paneId: string) => void paneId, calls });
    const { rerender, unmount } = mount(stageRender());
    expect(mounts).toBe(1);
    rerender(stageRender());
    rerender(stageRender());
    expect(calls).toEqual(['github.prs']);
    expect(mounts).toBe(1);
    unmount();
  });

  it('reports done() to the shell with the pane it belongs to, which closes it', () => {
    const closed: string[] = [];
    const { container, unmount } = mount(render({ onClose: (paneId) => closed.push(paneId) }));
    one(container, 'review-done').click();
    // The ID, not a bare call: one callback serves every pane, so it has to say
    // which one finished.
    expect(closed).toEqual([String(pane.id)]);
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
        onClose={() => {}}
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
        onClose={() => {}}
      />,
    );
    expect(one(container, 'pane-view-missing').textContent).toContain('no UI for');
    unmount();
  });
});
