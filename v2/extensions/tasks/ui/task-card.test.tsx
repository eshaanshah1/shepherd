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
const shippedRow = (over: Record<string, unknown> = {}): TreeItem =>
  item('Fix the login redirect', { mark: 'shipped', shipped: true, ...over });

describe('a task card mid-build', () => {
  it('draws the step as the row’s name, so a provisioning task is not a silent row', () => {
    draw(item('Creating the worktree', { mark: 'working' }));
    expect(title()).toBe('Creating the worktree');
  });

  it('draws the real name once the work is done, which IS the ready signal', () => {
    draw(item('Fix the login redirect', { mark: 'resting' }));
    expect(title()).toBe('Fix the login redirect');
  });

  it('draws no time stamp, on either side of the divider', () => {
    /*
     * A task row carried `4m` / `2h` / `3d`, and it is gone from live work as well as
     * from the archive. On finished work it reported the wrong subject; corrected to a
     * ship clock it was true and still a number beside every title. The trailing cell
     * holds the row's one verb, which is the thing you can actually do to it.
     *
     * Asserted for a WORKING card, because that is where a duration had the strongest
     * case — the number climbing is real there, and it still did not earn the column.
     */
    draw(item('Linking agent files', { mark: 'working', elapsed: '0m' }));
    expect(host.querySelector('.sh-task-card__elapsed')).toBeNull();
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

/**
 * A SHIPPED card — one dimmed line, and nothing that describes live work.
 *
 * This is what lets finished work sit permanently in the rail instead of behind
 * a chevron: the rows are readable when you look for them and cost no attention
 * when you do not. Everything suppressed here is suppressed because it is not
 * TRUE of shipped work rather than to save space — a diff is what a worktree
 * currently holds, a repo chip is somewhere you can go, and a shipped task's
 * checkouts are a snapshot.
 */
describe('a shipped task card', () => {
  const shipped = (over: Record<string, unknown> = {}): unknown => ({
    mark: 'shipped',
    shipped: true,
    ...over,
  });

  it('keeps its title, and carries no time at all', () => {
    draw(item('Fix the login redirect', shipped()));
    expect(title()).toBe('Fix the login redirect');
    // The day header above it answers "when" once for the whole group; a per-row
    // stamp answered a question nobody asked the archive.
    expect(host.querySelector('.sh-task-card__elapsed')).toBeNull();
    // The state still travels on the host, for the stylesheet and for a test — it
    // is only the drawn MARK below that goes.
    expect(host.querySelector('.sh-task-card')?.getAttribute('data-mark')).toBe('shipped');
  });

  it('draws no mark AND no slot, because the heading above it already says Shipped', () => {
    /*
     * Eight rows under a divider reading `Shipped` drew eight identical checks — the
     * 12px state slot spent on the one fact the divider declares, at the left edge
     * where the eye starts scanning.
     *
     * The slot goes with them, and that is the load-bearing half: Row rule 2 reserves
     * an empty box so a label's x cannot depend on whether its row has a status, and
     * that rule is about ONE LIST. Shipped is a region with no state column at all,
     * so the box would be 21px of indent every row pays for a column that is always
     * empty — 14% of the title track at the narrow rail width this was measured at.
     */
    draw(item('Fix the login redirect', shipped()));
    expect(host.querySelector('.sh-ui-mark')).toBeNull();
  });

  it('KEEPS the mark when the last run failed, because that deviates from the heading', () => {
    /*
     * The exception, and the reason the suppression is keyed on the mark rather than
     * on `shipped` alone: a task can be shipped while its last run was failing, and
     * `task-card.css` already dims from `data-shipped` instead of the mark for
     * exactly this — red must stay findable in a block you scan.
     */
    draw(item('Fix git pulling in CLI', shipped({ mark: 'failed' })));
    expect(host.querySelector('.sh-ui-mark[data-state="failed"]')).not.toBeNull();
    expect(host.querySelector('.sh-ui-mark')?.textContent).toBe('Failed');
  });

  it('draws a count when one row stands for more than one task', () => {
    /*
     * Two identically-named tasks shipped the same afternoon were two
     * indistinguishable lines, which reads as a rendering bug rather than the fact
     * it is. The row opens the most recent of them, so the count is the disclosure
     * that it is standing in for more than it opens — and it is announced, because a
     * digit in a ring is not self-explanatory to a screen reader.
     */
    draw(item('Update Shepherd with Shepherd-design', shipped({ dupe: 2 })));
    const badge = host.querySelector('.sh-task-card__dupe');
    expect(badge?.textContent).toContain('2');
    expect(badge?.getAttribute('title')).toBe('2 tasks with this name');
  });

  it('draws no count for the ordinary one-task row', () => {
    draw(item('Fix the login redirect', shipped()));
    expect(host.querySelector('.sh-task-card__dupe')).toBeNull();
  });

  it('never draws a count on live work, whatever the data says', () => {
    // Two live tasks of the same name are two things you are separately doing, and
    // collapsing them would hide one that might be waiting on you. The reader drops
    // the field rather than the card ignoring it, so this holds for every consumer.
    draw(item('Fix the login redirect', { mark: 'working', dupe: 2 }));
    expect(host.querySelector('.sh-task-card__dupe')).toBeNull();
  });

  it('says it is shipped, so a stylesheet can dim it', () => {
    draw(item('Fix the login redirect', shipped()));
    expect(host.querySelector('.sh-task-card')?.getAttribute('data-shipped')).toBe('true');
  });

  it('draws no diff, no repo chips and no tab strip', () => {
    draw(
      shippedRow({
        diff: { added: 40, removed: 3, files: 2 },
        repos: [{ name: 'railsApp', mark: 'repo1' }],
        tabs: ['resting', 'resting'],
        suite: { total: 10, passed: 10 },
      }),
    );
    expect(host.querySelector('.sh-task-card__diff')).toBeNull();
    expect(host.querySelector('.sh-task-card__repo')).toBeNull();
    expect(host.querySelector('.sh-task-card__tabs')).toBeNull();
  });

  it('stays one line even with two tabs, which would open a live card', () => {
    // `dense` normally yields to a multi-tab task — the mark strip is its second
    // line. A shipped task has no live tabs for that strip to describe.
    draw(shippedRow({ tabs: ['resting', 'working'] }));
    expect(host.querySelector('.sh-task-card')?.getAttribute('data-dense')).toBe('true');
  });

  it('stays one line even if it shipped while failing, and keeps the failed mark', () => {
    /*
     * A failed card normally earns its height for the exit code and the way back.
     * Neither applies once it is shipped — there is no run to return to — but the
     * MARK survives, because "I shipped this while it was red" is exactly the
     * thing a permanently-visible region should be able to tell you.
     */
    draw(item('Broken thing', { mark: 'failed', shipped: true, exitCode: 1 }));
    expect(host.querySelector('.sh-task-card')?.getAttribute('data-dense')).toBe('true');
    expect(host.querySelector('.sh-task-card')?.getAttribute('data-mark')).toBe('failed');
    expect(host.querySelector('.sh-task-card__exit')).toBeNull();
  });

  it('still offers its hover action, which is how you un-ship it', () => {
    draw(
      item('Fix the login redirect', shipped(), {
        primaryAction: { id: 'tasks.restore', label: 'Unship', icon: 'unship' },
      } as Partial<TreeItem>),
    );
    expect(host.querySelector('.sh-task-card__action')?.getAttribute('title')).toBe('Unship');
  });
});
