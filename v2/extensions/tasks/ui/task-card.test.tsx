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
 * row; it cannot prove anything renders it. That gap is exactly how the previous
 * progress work was lost: the extension set `busy` and `description` on every row
 * and went on setting them correctly for months, while the component that
 * replaced the ordinary row read neither — so the rail showed a resting ring for
 * the whole of the longest wait in the app and every test stayed green.
 *
 * The step reaches the card as its LABEL, so what has to be true here is that the
 * card draws `item.label` and nothing else competes with it.
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

const item = (label: string, data: unknown, over: Partial<TreeItem> = {}): TreeItem =>
  ({ id: 't1', label, data, ...over }) as TreeItem;

const draw = (row: TreeItem): void => {
  act(() => {
    root.render(<TaskCard item={row} selected={false} invoke={async () => ({ ok: true, value: undefined })} />);
  });
};

const title = (): string | undefined => host.querySelector('.sh-task-card__title')?.textContent ?? undefined;
const elapsed = (): HTMLElement | null => host.querySelector('.sh-task-card__elapsed');

describe('a task card mid-build', () => {
  it('draws the step as the row’s name, so a provisioning task is not a silent row', () => {
    draw(item('Creating the worktree', { mark: 'working', elapsed: '0m' }));
    expect(title()).toBe('Creating the worktree');
  });

  it('draws the real name once the work is done, which IS the ready signal', () => {
    draw(item('Fix the login redirect', { mark: 'resting', elapsed: '4m' }));
    expect(title()).toBe('Fix the login redirect');
  });

  it('keeps the elapsed stamp, because the step no longer wants that cell', () => {
    // An earlier build put the step in the trail and the stamp lost its slot for
    // the duration. The step is the label now, so the trailing cell goes back to
    // being one thing.
    draw(item('Linking agent files', { mark: 'working', elapsed: '0m' }));
    expect(elapsed()?.textContent).toBe('0m');
  });

  it('does NOT grow the card, because only a waiting one may change height', () => {
    // §5, and `task-card.css`'s own opening rule. Putting the step in the label
    // is what buys this: a line of its own would add a row to the rail for
    // fifteen seconds and take it away again — motion that moves every control
    // under it, which §8 refuses outright.
    draw(item('Creating the worktree', { mark: 'working' }));
    expect(host.querySelector('.sh-task-card')?.getAttribute('data-dense')).toBe('true');
    expect(host.querySelector('.sh-task-card__summary')).toBeNull();
  });

  it('still names the row when the data is unreadable', () => {
    // The name-resolves-or-degrades seam: this renders in the rail, so a throw
    // here takes the whole window — and the label is the one thing that must
    // survive it, because it is what the row stands for.
    draw(item('Naming the task', { mark: 'nonsense' }));
    expect(title()).toBe('Naming the task');
  });
});
