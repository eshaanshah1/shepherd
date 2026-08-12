// @vitest-environment jsdom
import { useState } from 'react';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import type { ViewContributionDTO, ViewsApi } from '../shared/index.ts';
import { matchesAccelerator, ViewOverlay } from './view-overlay.tsx';
import { all, mount } from './test-dom.ts';

/**
 * The modal layer, and the one thing about it that is not modal behaviour: the
 * props it hands a contributed component have to be STABLE.
 *
 * `ComponentView` memoizes them, and the memo is only as stable as what goes into
 * it. This layer sits under the app root, which re-renders on every layout and
 * agent snapshot — so anything unstable here cancels the asks a card makes on
 * mount, faster than the port can answer them.
 */

/**
 * Radix's Dialog reaches for `ResizeObserver`, which jsdom does not implement,
 * and throws on open rather than rendering.
 */
class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= StubResizeObserver;

const COMPOSER: ViewContributionDTO = {
  extension: 'shepherd.tasks',
  type: 'tasks.composer',
  kind: 'component',
  component: 'tasks.composer',
  surface: 'overlay',
  key: 'CmdOrCtrl+T',
  title: 'New task',
};

function bridge(calls: string[]): ViewsApi {
  return {
    list: () => Promise.resolve({ ok: true, value: [COMPOSER] }),
    children: () => Promise.resolve({ ok: true, value: [] }),
    activate: () => Promise.resolve({ ok: true, value: undefined }),
    invoke: (_type, command) => {
      calls.push(command);
      if (command === 'agents.listModels') {
        return Promise.resolve({
          ok: true,
          value: [{ value: 'fable', label: 'Fable' }, { value: 'haiku', label: 'Haiku' }],
        });
      }
      return Promise.resolve({ ok: true, value: [] });
    },
    present: () => Promise.resolve({ ok: true, value: { shown: true } }),
    onChanged: () => () => {},
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/** ⌘T, the way the accelerator really arrives — capture-phase, on the window. */
async function raise(): Promise<void> {
  await act(async () => {
    globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 't', metaKey: true, bubbles: true }));
  });
  await settle();
}

/**
 * The app root, reduced to the one property that matters: it re-renders on its
 * own, without any prop of the overlay's changing.
 *
 * `views` and `bridge` are built ONCE, outside the component. The real root
 * holds both in state and a ref, so a re-render there does not rebuild them —
 * if this fixture rebuilt them per render it would be testing its own churn
 * rather than the overlay's, and would go on passing with the fix reverted.
 */
const VIEWS: readonly ViewContributionDTO[] = [COMPOSER];

function Root({ api, bump }: { api: ViewsApi; bump: (fn: () => void) => void }): React.JSX.Element {
  const [ticks, setTicks] = useState(0);
  bump(() => setTicks((was) => was + 1));
  return (
    <div data-ticks={ticks}>
      <ViewOverlay views={VIEWS} bridge={api} />
    </div>
  );
}

describe('ViewOverlay', () => {
  it('keeps a raised card’s props stable across a root re-render', async () => {
    const calls: string[] = [];
    let tick = (): void => {};
    const view = mount(<Root api={bridge(calls)} bump={(fn) => (tick = fn)} />);
    await raise();

    expect(all(document.body, 'task-composer')).toHaveLength(1);
    const asks = calls.filter((command) => command === 'agents.listModels').length;
    expect(asks).toBe(1);

    // Six root renders — under a second of a working agent. Each re-ask cancels
    // the one before it, so a fast enough root means no answer ever lands.
    for (let at = 0; at < 6; at += 1) {
      await act(async () => tick());
      await settle();
    }

    expect(calls.filter((command) => command === 'agents.listModels').length).toBe(asks);
    expect(all(document.body, 'task-composer')).toHaveLength(1);
    view.unmount();
  });

  it('closes on the same accelerator, and the card is gone', async () => {
    const calls: string[] = [];
    const view = mount(<Root api={bridge(calls)} bump={() => undefined} />);
    await raise();
    expect(all(document.body, 'task-composer')).toHaveLength(1);

    await raise();
    expect(all(document.body, 'task-composer')).toHaveLength(0);
    view.unmount();
  });
});

describe('matchesAccelerator', () => {
  it('satisfies CmdOrCtrl with either, so a key works the way the menu resolved it', () => {
    const cmd = new KeyboardEvent('keydown', { key: 't', metaKey: true });
    const ctrl = new KeyboardEvent('keydown', { key: 't', ctrlKey: true });
    expect(matchesAccelerator('CmdOrCtrl+T', cmd)).toBe(true);
    expect(matchesAccelerator('CmdOrCtrl+T', ctrl)).toBe(true);
  });

  it('refuses a bare key and a wrong modifier set', () => {
    expect(matchesAccelerator('CmdOrCtrl+T', new KeyboardEvent('keydown', { key: 't' }))).toBe(false);
    expect(
      matchesAccelerator('CmdOrCtrl+T', new KeyboardEvent('keydown', { key: 't', metaKey: true, shiftKey: true })),
    ).toBe(false);
  });
});
