// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TreeItem } from '@shepherd/sdk';
import { TaskCard } from './task-card.tsx';

/**
 * What the card DRAWS — the half neither the unit suite nor the m3 smoke can
 * see.
 *
 * The smoke asserts through the real bus, so it proves the extension publishes a
 * stage word; it cannot prove anything renders it. That gap is exactly how the
 * previous progress work was lost: the extension set `busy` and `description` on
 * every row and went on setting them correctly for months, while the component
 * that replaced the ordinary row read neither — so the rail showed a resting ring
 * for the whole of the longest wait in the app and every test stayed green.
 *
 * So the claims here are about the DOM: the word is on screen, it takes the
 * stamp's cell rather than a line of its own, and a card with nothing happening
 * to it is unchanged.
 */

// React refuses to run `act` outside an act environment, and says so at the top
// of the first failure rather than where the problem is.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const item = (data: unknown, over: Partial<TreeItem> = {}): TreeItem =>
  ({ id: 't1', label: 'Ship it', data, ...over }) as TreeItem;

const draw = (row: TreeItem): void => {
  act(() => {
    root.render(<TaskCard item={row} selected={false} invoke={async () => ({ ok: true, value: undefined })} />);
  });
};

const stage = (): HTMLElement | null => host.querySelector('.sh-task-card__stage');
const elapsed = (): HTMLElement | null => host.querySelector('.sh-task-card__elapsed');

describe('the stage word on a task card', () => {
  it('draws the step, so a provisioning task is not a silent row', () => {
    draw(item({ mark: 'working', stage: 'worktrees', elapsed: '0m' }));
    expect(stage()?.textContent).toBe('worktrees');
  });

  it('takes the elapsed stamp’s cell rather than sitting beside it', () => {
    // Both at once would be two facts in a cell sized for one, and the trail is a
    // grid STACK — they would overlap rather than flow.
    draw(item({ mark: 'working', stage: 'naming', elapsed: '0m' }));
    expect(elapsed()).toBeNull();

    draw(item({ mark: 'working', elapsed: '4m' }));
    expect(stage()).toBeNull();
    expect(elapsed()?.textContent).toBe('4m');
  });

  it('does NOT grow the card, because only a waiting one may change height', () => {
    // §5, and `task-card.css`'s own opening rule. A stage line of its own would
    // add a row to the rail for fifteen seconds and take it away again — motion
    // that moves every control under it, which §8 refuses outright.
    draw(item({ mark: 'working', stage: 'linking' }));
    expect(host.querySelector('.sh-task-card')?.getAttribute('data-dense')).toBe('true');
    expect(host.querySelector('.sh-task-card__summary')).toBeNull();
  });

  it('leaves a card with nothing happening to it exactly as it was', () => {
    draw(item({ mark: 'resting', elapsed: '3d' }));
    expect(stage()).toBeNull();
    expect(elapsed()?.textContent).toBe('3d');
  });

  it('still draws the row when the data is unreadable', () => {
    // The name-resolves-or-degrades seam: this renders in the rail, so a throw
    // here takes the whole window.
    draw(item({ mark: 'nonsense', stage: 'worktrees' }));
    expect(host.querySelector('.sh-task-card__title')?.textContent).toBe('Ship it');
    expect(stage()).toBeNull();
  });
});
