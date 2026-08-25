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

describe('activating a task card', () => {
  /** Draw a card and record every command the click reaches. */
  const clicking = (
    row: TreeItem,
    selector: string,
  ): readonly string[] => {
    const calls: string[] = [];
    act(() => {
      root.render(
        <TaskCard
          item={row}
          selected={false}
          invoke={async (command) => {
            calls.push(command);
            return { ok: true, value: undefined };
          }}
        />,
      );
    });
    act(() => host.querySelector<HTMLElement>(selector)?.click());
    return calls;
  };

  const opener = { id: 'tasks.reveal', args: { task: 't1' } };

  it('opens from ANYWHERE on the card, not just its title line', () => {
    /*
     * The whole defect: the target was the head, so the half of the card below
     * the title — the sentence, the duration, the diff, the chips — looked
     * exactly as clickable as the half above it and did nothing. A row you have
     * to aim at the top of is a row you miss.
     */
    const row = item('Fix the login redirect', {
      mark: 'working',
      summary: 'working',
      elapsed: '14m',
      diff: { added: 12, removed: 4, files: 3 },
    });
    for (const selector of [
      '.sh-task-card',
      '.sh-task-card__head',
      '.sh-task-card__title',
      '.sh-task-card__meta',
      '.sh-task-card__summary',
      '.sh-task-card__elapsed',
    ]) {
      expect(clicking({ ...row, command: opener }, selector), selector).toEqual(['tasks.reveal']);
    }
  });

  it('answers a question WITHOUT also opening the task', () => {
    /*
     * The cost of making the whole card a target, and the thing that would have
     * broken silently: `Allow` bubbles to the card, so without a stop it answers
     * the question and then moves the window to the pane you answered from.
     */
    const row = item('Fix the login redirect', {
      mark: 'waiting',
      question: {
        text: 'Allow',
        answers: [
          { label: 'Allow', command: 'claude.allow' },
          { label: 'Deny', command: 'claude.deny' },
        ],
      },
    });
    const calls = clicking({ ...row, command: opener }, '.sh-task-card__answers button');
    expect(calls).toEqual(['claude.allow']);
  });

  it('runs the row’s verb WITHOUT also opening the task', () => {
    const row = item('Fix the login redirect', {
      mark: 'working',
      summary: 'working',
    });
    const withAction: TreeItem = {
      ...row,
      command: opener,
      primaryAction: { id: 'tasks.ship', icon: 'ship', label: 'Ship' },
    };
    expect(clicking(withAction, '.sh-task-card__action')).toEqual(['tasks.ship']);
  });

  it('is one tab stop, and it is the CARD', () => {
    // The head used to hold the role and the tab stop, so Tab landed on the
    // title line and Enter activated something smaller than the ring drew round.
    draw(item('Fix the login redirect', { mark: 'working', summary: 'working' }));
    expect(host.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    const card = host.querySelector('.sh-task-card');
    expect(card?.getAttribute('role')).toBe('button');
    expect(card?.getAttribute('tabindex')).toBe('0');
    expect(host.querySelector('.sh-task-card__head')?.getAttribute('role')).toBeNull();
  });
});

describe('a task card mid-build', () => {
  it('draws the step as the row’s name, so a provisioning task is not a silent row', () => {
    draw(item('Creating the worktree', { mark: 'working' }));
    expect(title()).toBe('Creating the worktree');
  });

  it('draws the real name once the work is done, which IS the ready signal', () => {
    draw(item('Fix the login redirect', { mark: 'resting' }));
    expect(title()).toBe('Fix the login redirect');
  });

  it('draws the stamp on the meta line, and never back beside the title', () => {
    /*
     * A stamp lived beside the title once — `4m` / `2h` / `3d` — and was removed
     * from both sides of the divider. It reported task AGE, which on finished
     * work is the wrong subject, and even corrected to a ship clock it was a
     * number charged against every title in the rail.
     *
     * What came back is a different measurement in a different place: how long
     * the task has been in the state its MARK reports, on the second line, where
     * the diff numbers used to be. The trailing cell still holds the row's one
     * verb and nothing else, which is what the removal was protecting.
     */
    draw(item('Linking agent files', { mark: 'working', elapsed: '4m' }));
    expect(host.querySelector('.sh-task-card__meta .sh-task-card__elapsed')?.textContent).toContain('4m');
    expect(host.querySelector('.sh-task-card__head .sh-task-card__elapsed')).toBeNull();
    expect(host.querySelector('.sh-task-card__trail .sh-task-card__elapsed')).toBeNull();
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

  it('keeps the task on the row while it says what it is doing', () => {
    // The step used to BE the label, because a task had no name until the model
    // answered. It has one from birth now, so the two sit side by side.
    draw(item('fix the login redirect loop', { mark: 'working', stage: 'Creating the worktree' }));
    expect(host.querySelector('.sh-task-card__title')?.textContent).toBe('fix the login redirect loop');
    expect(host.querySelector('.sh-task-card__stage')?.textContent).toBe('Creating the worktree');
  });

  it('draws the step on the meta line, not in the head beside the title', () => {
    /*
     * It WAS in the head, and the assertion was "so the row keeps one height".
     * The row still keeps one height — the meta line is permanent, so nothing
     * appears or disappears when a step starts — and the step no longer charges
     * the title for the room.
     */
    draw(item('Fix the login redirect', { mark: 'working', stage: 'Setting up' }));
    expect(host.querySelector('.sh-task-card__meta .sh-task-card__stage')).not.toBeNull();
    expect(host.querySelector('.sh-task-card__head .sh-task-card__stage')).toBeNull();
  });

  it('gives every LIVE row a second line, whatever it has to say', () => {
    /*
     * It took three goes to land here, so the losers are worth naming.
     *
     * Unconditional first, on §10's "a row must not grow to say something" — and
     * a rail of quiet tasks was a column of titles each trailed by a reserved
     * empty strip, which reads as a rendering fault. Then conditional, and a row
     * would simply lose its second line whenever it had nothing to say: a row
     * changing height for a reason nothing on screen states.
     *
     * Both treated the emptiness as a layout problem. It is a CONTENT problem —
     * the writer always has something true to put there, down to the state in
     * words. With a floor under it the line can be unconditional and never be
     * empty, which is what a card is.
     */
    draw(item('Fix the login redirect', { mark: 'resting', summary: 'idle' }));
    expect(host.querySelector('.sh-task-card__meta')?.textContent).toContain('idle');
  });

  it('draws no repo chips for ONE repo, which every row in the rail would repeat', () => {
    // §6 refuses repeating a name down the hierarchy, and one chip in a
    // single-repo workspace is the same word on every row.
    draw(item('Fix the login redirect', { mark: 'resting', repos: [{ name: 'sdk', mark: 'repo1' }] }));
    expect(host.querySelector('.sh-task-card__repos')).toBeNull();
  });

  it('draws them as soon as a task spans TWO, where they tell rows apart', () => {
    draw(item('Fix the login redirect', {
      mark: 'resting',
      repos: [
        { name: 'sdk', mark: 'repo1' },
        { name: 'app', mark: 'repo2' },
      ],
    }));
    expect(host.querySelector('.sh-task-card__repos')?.textContent).toContain('sdk');
  });

  it('never draws one on a shipped row, which is one dimmed line by design', () => {
    draw(item('Fix the login redirect', shipped({ diff: { added: 9, removed: 2, files: 2 } })));
    expect(host.querySelector('.sh-task-card__meta')).toBeNull();
  });

  it('draws the duration instead of a diff, and never a diff at all', () => {
    /*
     * The replacement this change is about. `+12 −4 · 3 files` answers "how big
     * is this" — a review-time question, asked once, by somebody who has already
     * decided to look. The rail is scanned, and the question it exists to answer
     * is "which of these is my fault". The numbers are gone from the rail
     * entirely, not demoted to a hover.
     */
    draw(item('Fix the login redirect', { mark: 'waiting', elapsed: '14m', diff: { added: 12, removed: 4, files: 3 } }));
    expect(host.querySelector('.sh-task-card__elapsed')?.textContent).toContain('14m');
    expect(host.querySelector('.sh-task-card__diff')).toBeNull();
    expect(host.querySelector('.sh-task-card__added')).toBeNull();
  });

  it('gives the slot to the step while building, and the duration keeps its own edge', () => {
    draw(item('Fix the login redirect', { mark: 'working', stage: 'Setting up', elapsed: '1m' }));
    expect(host.querySelector('.sh-task-card__meta .sh-task-card__stage')?.textContent).toBe('Setting up');
    expect(host.querySelector('.sh-task-card__elapsed')?.textContent).toContain('1m');
  });

  it('gives the slot to the summary when there is no step', () => {
    draw(item('Fix the login redirect', { mark: 'ready', summary: 'Tests pass. Ready for review.' }));
    expect(host.querySelector('.sh-task-card__meta .sh-task-card__summary')?.textContent).toBe(
      'Tests pass. Ready for review.',
    );
  });

  it('lets the STEP win the slot while the task is being built', () => {
    // One slot, never two things competing. The step is transient, and its
    // disappearance is still the signal that the work has begun.
    draw(item('Fix the login redirect', { mark: 'working', stage: 'Setting up', summary: 'Something older' }));
    expect(host.querySelector('.sh-task-card__stage')?.textContent).toBe('Setting up');
    expect(host.querySelector('.sh-task-card__summary')).toBeNull();
  });

  it('draws the summary on ONE line, not as the paragraph it used to be', () => {
    // It lived under the title as a two-line block, which was the same idea
    // drawn twice at two sizes. A summary that needs a second line is not one.
    draw(item('Fix the login redirect', { mark: 'ready', summary: 'Done.' }));
    expect(host.querySelector('.sh-task-card__meta .sh-task-card__summary')).not.toBeNull();
    expect(host.querySelector('p.sh-task-card__summary')).toBeNull();
  });

  it('says the duration in WORDS too, since a stamp alone names no subject', () => {
    // §5: a mark whose only content is a number cannot be read out or asserted
    // on. `14m` beside a title does not say fourteen minutes of what.
    draw(item('Fix the login redirect', { mark: 'waiting', elapsed: '14m' }));
    const stamp = host.querySelector('.sh-task-card__elapsed');
    expect(stamp?.getAttribute('title')).toBe('14m in this state');
    expect(stamp?.textContent).toContain('14m in this state');
  });

  it('draws no duration on first sighting, rather than claiming zero', () => {
    // A task already waiting when the app started has been waiting longer than
    // anyone can say, and `0s` would be a confident lie. The writer sends no
    // field at all the first time it sees a state.
    draw(item('Fix the login redirect', { mark: 'waiting' }));
    expect(host.querySelector('.sh-task-card__elapsed')).toBeNull();
  });

  it('draws no step once there is nothing left to do', () => {
    draw(item('Fix the login redirect', { mark: 'working' }));
    expect(host.querySelector('.sh-task-card__stage')).toBeNull();
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

describe('a fact another extension contributed', () => {
  const fact = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    icon: 'pull-request',
    tone: 'negative',
    title: '2 PRs · a check failed',
    ...over,
  });

  it('draws the glyph and names it in words, since a colour cannot be read out', () => {
    draw(item('Add multiple task tabs', { mark: 'working', facts: [fact()] }));
    const cell = host.querySelector('.sh-task-card__fact');
    expect(cell?.getAttribute('title')).toBe('2 PRs · a check failed');
    expect(cell?.getAttribute('data-tone')).toBe('negative');
    expect(cell?.textContent).toContain('2 PRs · a check failed');
    expect(cell?.querySelector('svg')).not.toBeNull();
  });

  it('survives onto a shipped row, unlike every other live field', () => {
    // A merged PR number is the record of what shipped — the most durable thing
    // a finished row can carry.
    draw(shippedRow({ facts: [fact({ icon: undefined, label: 'v2 #309', tone: 'quiet' })] }));
    expect(host.querySelector('.sh-task-card__fact')?.textContent).toContain('v2 #309');
  });

  it('is a real button when it has a command, and a span when it does not', () => {
    draw(item('x', { mark: 'working', facts: [fact()] }));
    expect(host.querySelector('button.sh-task-card__fact')).toBeNull();

    draw(item('x', { mark: 'working', facts: [fact({ command: { id: 'github.review', args: { task: 't1' } } })] }));
    expect(host.querySelector('button.sh-task-card__fact')).not.toBeNull();
  });

  it('runs its command without also activating the row it sits in', async () => {
    // This control is inside a row that is itself a button: without the stop,
    // opening the review tab would also reveal the task.
    const calls: string[] = [];
    let rowClicks = 0;
    act(() => {
      root.render(
        // The shape the dock really mounts: the card inside the element that
        // carries the row's own activation.
        <div onClick={() => (rowClicks += 1)}>
          <TaskCard
            item={item('x', { mark: 'working', facts: [fact({ command: { id: 'github.review' } })] })}
            selected={false}
            invoke={async (command) => {
              calls.push(command);
              return { ok: true, value: undefined };
            }}
          />
        </div>,
      );
    });
    act(() => host.querySelector<HTMLButtonElement>('button.sh-task-card__fact')?.click());
    expect(calls).toEqual(['github.review']);
    expect(rowClicks).toBe(0);
  });

  it('draws no glyph for a name this build does not know, rather than a placeholder', () => {
    // `namedGlyph`'s `…` fallback is right for a hover action, which is an
    // invisible button without one, and wrong for a fact that can be a label.
    draw(item('x', { mark: 'working', facts: [fact({ icon: 'not-a-glyph', label: '#7' })] }));
    const cell = host.querySelector('.sh-task-card__fact');
    expect(cell?.querySelector('svg')).toBeNull();
    expect(cell?.textContent).toContain('#7');
  });
});

/**
 * The incognito mark — a task whose agents run in a Claude profile that is
 * deleted with them.
 *
 * It is a property of the TASK and not a state of it, so it does not touch the
 * state mark: a working incognito task still reads as working. It sits in the
 * meta line's leading gutter, directly under the mark, which is the one place on
 * the card that is reserved and empty.
 */
describe('the incognito mark', () => {
  const glyph = (): Element | null => host.querySelector('.sh-task-card__incognito');

  it('draws under the state mark on an incognito task', () => {
    draw(item('Quiet work', { mark: 'working', incognito: true }));
    expect(glyph()).not.toBeNull();
  });

  it('draws nothing on an ordinary task', () => {
    draw(item('Ordinary work', { mark: 'working' }));
    expect(glyph()).toBeNull();
  });

  it('leaves the state mark alone — incognito is not a sixth state', () => {
    draw(item('Quiet work', { mark: 'waiting', incognito: true }));
    expect(host.querySelector('.sh-task-card')?.getAttribute('data-mark')).toBe('waiting');
  });

  it('says what it is, since a glyph alone cannot be read out or searched', () => {
    draw(item('Quiet work', { mark: 'working', incognito: true }));
    expect(glyph()?.textContent).toContain('Incognito');
  });

  it('is gone once the task ships, because the profile it stood for is deleted', () => {
    // A shipped row has no meta line at all, and the profile went with the ship.
    // A mark still claiming the history is hidden would be claiming something
    // that is no longer true of anything.
    draw(shippedRow({ incognito: true }));
    expect(glyph()).toBeNull();
  });
});
