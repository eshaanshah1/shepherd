// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fuzzyMatch } from '@shepherd/sdk';
import { Modal } from '@shepherd/ui';
import { TaskComposer } from './composer.tsx';
import { displayMatch } from '../src/model/match-display.ts';

/**
 * The `#repo` picker, which is the half a smoke test cannot see.
 *
 * Everything asserted here is a rule somebody has to be able to change without
 * finding out from a screenshot. The shape of it: `#` opens a picker at the
 * caret, typing filters it, ⏎ swaps the typed `#query` for one atomic pill, and
 * the task's SCOPE is read back out of the pills rather than kept beside them.
 * And ⎋ closes the picker without closing the composer — the only place this
 * component reaches past React, because Radix's dismissable layer listens for
 * Escape on the document in the capture phase.
 */

// React refuses to run `act` outside an act environment, and says so at the top
// of the first failure rather than where the problem is.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOME = '/Users/e';
/** What `pick` inserts after a pill. Named, because it is invisible in a string. */
const NBSP = ' ';

/**
 * A row built the way the EXTENSION builds one, through the same model.
 *
 * Hand-written `display`/`segments` would be a copy of the rule that can drift
 * from it silently — and the drift would be invisible, because a wrong highlight
 * still renders. So the fixture mirrors `suggest.ts` exactly: the trailing
 * segment of the query is matched against the entry's NAME, the positions are
 * shifted into the full path, and `displayMatch` does the rest.
 */
const suggestion = (path: string, query = '', over: Record<string, unknown> = {}) => {
  const cut = path.lastIndexOf('/') + 1;
  const partial = query.slice(query.lastIndexOf('/') + 1);
  const hit = fuzzyMatch(partial, path.slice(cut))?.positions ?? [];
  const shown = displayMatch(path, hit.map((at) => at + cut), HOME);
  return {
    path,
    name: path.slice(cut),
    isRepo: true,
    source: 'filesystem',
    display: shown.text,
    segments: shown.segments,
    ...over,
  };
};

/**
 * What the extension would answer, for the queries these tests type.
 *
 * The keys are what follows the `#`, which is the whole of the query now — a
 * bare word for the history and a path for the disk, both of which
 * `tasks.suggestRepos` already answers without knowing which it was given.
 */
const ANSWERS: Record<string, readonly unknown[]> = {
  '': [suggestion(`${HOME}/dev/api`, '', { source: 'history' })],
  s: [
    suggestion(`${HOME}/dev/shepherd`, 's', { source: 'history' }),
    suggestion(`${HOME}/dev/shepherd-ios`, 's', { source: 'history' }),
  ],
  she: [
    suggestion(`${HOME}/dev/shepherd`, 'she', { source: 'history' }),
    suggestion(`${HOME}/dev/shell-notes`, 'she', { source: 'history', isRepo: false }),
  ],
  zzz: [],
  // A path query, which is the capability the mention picker had to keep: a repo
  // you have never used is not in the history and can only be reached by naming
  // where it lives.
  '~/dev/sh': [suggestion(`${HOME}/dev/shepherd`, '~/dev/sh')],
};

/**
 * Typed through a factory, so the mock keeps the prop's signature.
 *
 * The answer is `unknown`, which is what a command's answer actually is — it
 * crossed a port from an extension the page has never seen. Declared rather than
 * inferred so a test may answer a DIFFERENT verb's shape (a name, a slug, a row
 * list) without the inferred union of these two branches rejecting it.
 */
const makeInvoke = () =>
  vi.fn(async (command: string, args?: unknown): Promise<{ ok: true; value: unknown }> => {
    if (command === 'tasks.suggestRepos') {
      const query = (args as { query?: string }).query ?? '';
      return { ok: true as const, value: ANSWERS[query] ?? [] };
    }
    return { ok: true as const, value: { slug: 'a-task' } };
  });
const makeDone = () => vi.fn(() => undefined);

let container: HTMLElement;
let unmount: () => void;
let invoke: ReturnType<typeof makeInvoke>;
let done: ReturnType<typeof makeDone>;

function mount(node: ReactNode): void {
  container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
}

const brief = (): HTMLElement =>
  container.querySelector<HTMLElement>('[data-testid="composer-brief"]')!;
/*
 * The panel is queried off the DOCUMENT, not the container: it is portalled to
 * the body so it can hang past a card that `Modal` would otherwise clip. A helper
 * scoped to `container` would have found nothing and every assertion about the
 * picker would have read as "closed".
 */
const picker = (): HTMLElement | null =>
  document.body.querySelector<HTMLElement>('[data-testid="composer-picker"]');
const rows = (): HTMLElement[] => [
  ...document.body.querySelectorAll<HTMLElement>('[data-testid="composer-picker-row"]'),
];
const paths = (): string[] => rows().map((row) => row.dataset.path ?? '');
const activeRow = (): HTMLElement | undefined =>
  rows().find((row) => row.dataset.selected === 'true');
/** The scope, as the SENTENCE holds it — pills in document order. */
const pills = (): string[] =>
  [...brief().querySelectorAll<HTMLElement>('[data-repo-path]')].map(
    (pill) => pill.dataset.repoPath ?? '',
  );
const scopeLine = (): string =>
  container.querySelector<HTMLElement>('[data-testid="composer-scope"]')!.textContent ?? '';

/** A real event, because the capture-phase listener under test is a real one. */
async function press(key: string, target: HTMLElement = brief()): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

/**
 * Type at the end of the editor, caret and all.
 *
 * The caret is the point. `caretContext` reads the selection's own text node, so
 * a test that set `textContent` and fired `input` without placing a range would
 * exercise none of the trigger logic — it would assert against a picker that can
 * never open. This appends into the trailing text node when there is one, which
 * is what typing after a pill actually does.
 */
async function type(text: string): Promise<void> {
  const field = brief();
  await act(async () => {
    const last = field.lastChild;
    let node: Text;
    if (last !== null && last.nodeType === Node.TEXT_NODE) {
      node = last as Text;
      node.textContent = `${node.textContent ?? ''}${text}`;
    } else {
      node = document.createTextNode(text);
      field.append(node);
    }
    const range = document.createRange();
    range.setStart(node, (node.textContent ?? '').length);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(async () => {
  invoke = makeInvoke();
  done = makeDone();
  mount(<TaskComposer invoke={invoke} done={done} />);
  // The mount's own ask for the history.
  await act(async () => {});
});

afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

describe('the trigger', () => {
  it('asks for the history on mount, and draws no picker for it', () => {
    // The ask is what makes the first `#` instant. Drawing it would put a
    // popover over an empty card nobody has typed into.
    expect(invoke).toHaveBeenCalledWith('tasks.suggestRepos', {
      title: '',
      brief: '',
      query: '',
    });
    expect(picker()).toBeNull();
  });

  it('opens on `#` with the history under it, before a second keystroke', async () => {
    await type('#');
    expect(picker()).not.toBeNull();
    expect(paths()).toEqual([`${HOME}/dev/api`]);
  });

  it('filters as you type, and asks the extension rather than filtering here', async () => {
    await type('#she');
    expect(invoke).toHaveBeenCalledWith('tasks.suggestRepos', {
      title: '#she',
      brief: '#she',
      query: 'she',
    });
    expect(paths()).toEqual([`${HOME}/dev/shepherd`, `${HOME}/dev/shell-notes`]);
  });

  it('opens mid-sentence, which is the whole point of it', async () => {
    await type('fix the retry loop in #she');
    expect(picker()).not.toBeNull();
    expect(
      document.body.querySelector('[data-testid="composer-picker-query"]')?.textContent,
    ).toBe('#she');
  });

  it('does NOT open on a `#` inside a word', async () => {
    // `C#`, `utf#8`, `issue#42`. A picker that appears while somebody writes
    // prose is worse than one that is slightly harder to reach.
    await type('written in C#');
    expect(picker()).toBeNull();
  });

  it('closes on whitespace, which is how you get out of one you did not mean', async () => {
    await type('#she');
    expect(picker()).not.toBeNull();
    await type(' ');
    expect(picker()).toBeNull();
  });

  it('closes when the caret LEAVES the mention, not only when the text changes', async () => {
    /*
     * ←/→ and a click inside the editor pass through while the picker is open, so
     * the caret can leave the mention with no edit at all. Held open, the picker
     * would still be carrying the query it arrived with — and ⏎ deletes that many
     * characters wherever the caret now is, eating text elsewhere in the sentence.
     * `selectionchange` is dispatched by hand because jsdom has no caret to move.
     */
    await type('fix it in #s');
    expect(picker()).not.toBeNull();

    await act(async () => {
      const text = brief().firstChild!;
      const range = document.createRange();
      range.setStart(text, 3);
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });

    expect(picker()).toBeNull();
  });

  it('says so when nothing matches, rather than closing', async () => {
    // Closing would read as the picker being broken. The empty state is what
    // tells you the typo is yours.
    await type('#zzz');
    expect(picker()).not.toBeNull();
    expect(rows()).toHaveLength(0);
    expect(
      document.body.querySelector('[data-testid="composer-picker-empty"]')?.textContent,
    ).toBe('no repo matches that');
  });

  it('passes a PATH query straight through, so a repo you have never used is reachable', async () => {
    // The capability the old field had and a name-only picker would have lost.
    // `completionTarget` answers null for a bare word and completes anything with
    // a separator in it, so one trigger covers both with no mode to switch.
    await type('#~/dev/sh');
    expect(invoke).toHaveBeenCalledWith('tasks.suggestRepos', {
      title: '#~/dev/sh',
      brief: '#~/dev/sh',
      query: '~/dev/sh',
    });
    expect(paths()).toEqual([`${HOME}/dev/shepherd`]);
  });
});

describe('the rows', () => {
  it('draw the NAME, with the hit characters picked out', async () => {
    // The highlight is what makes the match checkable — without it the list
    // asserts an order and gives you no way to see why.
    await type('#she');
    const hits = [...rows()[0]!.querySelectorAll('.sh-composer-picker-hit')].map(
      (node) => node.textContent,
    );
    expect(hits).toEqual(['she']);
  });

  it('draw the parent path as meta, because that is what tells two repos apart', async () => {
    await type('#she');
    const row = rows()[0]!;
    expect(row.querySelector('.sh-ui-row__label')?.textContent).toBe('shepherd');
    expect(row.querySelector('.sh-ui-row__meta')?.textContent).toBe('~/dev/');
  });

  it('reassemble into the path exactly, so a highlight can never rename it', async () => {
    await type('#she');
    const runs = [...rows()[0]!.querySelectorAll('span')].map((node) => node.textContent ?? '');
    expect(runs.join('')).toContain('~/dev/');
  });

  it('mark a directory that is not a repo, and still offer it', async () => {
    // `~/dev` is not a repo and is exactly the row you need to reach the ones
    // inside it, so it is marked rather than dropped. The mark says the word too:
    // a fact encoded only in colour cannot be read out or asserted on.
    await type('#she');
    const marks = rows().map(
      (row) => row.querySelector<HTMLElement>('.sh-composer-picker-mark')?.dataset.repo,
    );
    expect(marks).toEqual(['true', 'false']);
    expect(rows()[1]?.querySelector('.sh-ui-sr-only')?.textContent).toBe('not a repo');
  });
});

describe('the keyboard', () => {
  it('starts on the first row and moves with the arrows, clamped', async () => {
    await type('#s');
    expect(activeRow()?.dataset.path).toBe(`${HOME}/dev/shepherd`);

    await press('ArrowDown');
    expect(activeRow()?.dataset.path).toBe(`${HOME}/dev/shepherd-ios`);

    // Clamped, no wrap: a list that jumps from the last row back to the first is
    // a list you can arrow past without noticing.
    await press('ArrowDown');
    expect(activeRow()?.dataset.path).toBe(`${HOME}/dev/shepherd-ios`);

    await press('ArrowUp');
    await press('ArrowUp');
    expect(activeRow()?.dataset.path).toBe(`${HOME}/dev/shepherd`);
  });

  it('names the active row rather than focusing it, so the query survives an arrow', async () => {
    // The defect every hand-rolled picker has: focus moves to a row and the
    // field it was filtering loses the text.
    await type('#s');
    const id = activeRow()!.id;
    expect(brief().getAttribute('aria-activedescendant')).toBe(id);
    expect(brief().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).not.toBe(activeRow());
  });

  it('inserts the active row as ONE pill on ⏎, and never submits', async () => {
    await type('fix it in #s');
    const enter = await press('Enter');

    expect(pills()).toEqual([`${HOME}/dev/shepherd`]);
    expect(enter.defaultPrevented).toBe(true);
    expect(invoke).not.toHaveBeenCalledWith('tasks.create', expect.anything());
  });

  it('swaps the typed `#query` for the pill, leaving the sentence around it', async () => {
    await type('fix it in #s');
    await press('Enter');
    // The `#s` is gone and the pill stands where it was — not appended after it.
    expect(brief().textContent).toBe(`fix it in #shepherd${NBSP}`);
    expect(picker()).toBeNull();
  });

  it('takes ↹ as well, because a completion key is a completion key', async () => {
    await type('#s');
    const tab = await press('Tab');
    expect(tab.defaultPrevented).toBe(true);
    expect(pills()).toEqual([`${HOME}/dev/shepherd`]);
  });

  it('does nothing on ⏎ with no rows, rather than submitting under the picker', async () => {
    // The picker is on screen, so ⏎ visibly belongs to it. Submitting here would
    // create a task out of a half-typed mention.
    await type('ship it #zzz');
    const enter = await press('Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(invoke).not.toHaveBeenCalledWith('tasks.create', expect.anything());
    expect(pills()).toEqual([]);
  });

  it('lets ⏎ submit once the picker is closed', async () => {
    await type('ship it');
    const enter = await press('Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(invoke).toHaveBeenCalledWith(
      'tasks.create',
      expect.objectContaining({ brief: 'ship it' }),
    );
  });

  it('newlines on ⇧⏎, and creates nothing', async () => {
    await type('ship it');
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      brief().dispatchEvent(event);
    });
    // Not swallowed: the newline is contenteditable's to insert, and taking the
    // key to reimplement it is how the undo stack gets broken.
    expect(event.defaultPrevented).toBe(false);
    expect(invoke).not.toHaveBeenCalledWith('tasks.create', expect.anything());
  });
});

describe('⎋', () => {
  it('closes the picker, leaves the typed text, and keeps the composer open', async () => {
    await type('#she');
    expect(picker()).not.toBeNull();

    await press('Escape');

    expect(picker()).toBeNull();
    // The text stays. Deleting what somebody typed because they dismissed a
    // popover is a picker taking their words away.
    expect(brief().textContent).toBe('#she');
    expect(container.querySelector('[data-testid="task-composer"]')).not.toBeNull();
    expect(done).not.toHaveBeenCalled();
  });

  it('is swallowed before the modal layer sees it', async () => {
    /*
     * Radix's dismissable layer listens on the DOCUMENT in the capture phase and
     * dismisses unless `defaultPrevented`. This test stands in for it: the
     * composer's own listener is on `window`, one step earlier in the capture
     * path, which is the only seam available.
     */
    const seen: boolean[] = [];
    const layer = (event: Event): void => void seen.push(event.defaultPrevented);
    document.addEventListener('keydown', layer, true);
    try {
      await type('#she');
      await press('Escape');
      expect(seen).toEqual([true]);
    } finally {
      document.removeEventListener('keydown', layer, true);
    }
  });

  it('is left alone with the picker closed, which is how you dismiss the composer', async () => {
    const event = await press('Escape');
    expect(event.defaultPrevented).toBe(false);
  });

  it('takes the picker AND the composer when nothing has been written', async () => {
    /*
     * The `#repo` button (and a typed `#`) opens the picker over an empty card,
     * and there the two-step dismiss protects nothing: the `#` is the picker's own
     * trigger, not a word anybody chose. So the picker closes and the event is
     * left for the modal layer — one ⎋ out of a task you never started.
     */
    await type('#');
    expect(picker()).not.toBeNull();

    const event = await press('Escape');

    expect(picker()).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('the card in its modal', () => {
  it('opens with the brief focused, because writing is what it is for', () => {
    /*
     * Through the REAL `Modal`, because the defect this pins was Radix's focus
     * trap and not the composer: a `contenteditable` reports `tabIndex === -1`, so
     * the trap's tabbable walk skipped the only field on the card and focused the
     * `#repo` button under it. Mounting the composer bare could not see that —
     * nothing would have taken focus at all.
     */
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <Modal open onOpenChange={() => undefined} title="New task" size="lg">
          <TaskComposer invoke={makeInvoke()} done={makeDone()} />
        </Modal>,
      ),
    );

    // The card's OWN brief, not merely something with that name: another composer
    // is mounted bare by `beforeEach`, and an assertion on the test id alone would
    // pass for whichever one happened to hold focus.
    const card = document.querySelector<HTMLElement>('.sh-ui-modal')!;
    const focused = document.activeElement as HTMLElement | null;
    expect(focused?.getAttribute('data-testid')).toBe('composer-brief');
    expect(focused !== null && card.contains(focused)).toBe(true);

    act(() => root.unmount());
    host.remove();
  });

  it('closes on ⎋ with nothing typed, rather than swallowing it', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const onOpenChange = vi.fn();
    act(() =>
      root.render(
        <Modal open onOpenChange={onOpenChange} title="New task" size="lg">
          <TaskComposer invoke={makeInvoke()} done={makeDone()} />
        </Modal>,
      ),
    );

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);

    act(() => root.unmount());
    host.remove();
  });
});

describe('the scope', () => {
  it('is read out of the sentence, so removing a pill un-scopes the task', async () => {
    /*
     * The pill IS the scope. jsdom implements no editing, so the Backspace itself
     * cannot be simulated — what is asserted is the consequence that matters:
     * the pill leaves the DOM and the scope follows, because nothing keeps a
     * second copy of it. A composer holding a selection array would still be
     * scoped to a repo that is no longer in the text, and no test of the array
     * could show that.
     */
    await type('#s');
    await press('Enter');
    expect(scopeLine()).toBe('scoped to shepherd');

    await act(async () => {
      brief().querySelector('[data-repo-path]')!.remove();
      brief().dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(pills()).toEqual([]);
    expect(scopeLine()).toBe('no repo scoped — lands in inbox');
  });

  it('says where an unscoped task LANDS rather than reporting a missing field', () => {
    // A task with no repo is a valid task. "no repo" alone would make a working
    // state read as an unfinished form.
    expect(scopeLine()).toBe('no repo scoped — lands in inbox');
  });

  it('counts once there are several, because names would run off the row', async () => {
    await type('#s');
    await press('Enter');
    await type('#s');
    await press('Enter');
    expect(pills()).toEqual([`${HOME}/dev/shepherd`, `${HOME}/dev/shepherd-ios`]);
    expect(scopeLine()).toBe('scoped to 2 repos');
  });

  it('stops offering a repo already in the sentence', async () => {
    // Two of one repo is one worktree and one branch, so it is one entry — and a
    // row you cannot see is a row you cannot pick, which is why this is a filter
    // rather than a second guard at insertion time.
    await type('#s');
    await press('Enter');
    await type('#s');
    expect(paths()).toEqual([`${HOME}/dev/shepherd-ios`]);
  });

  it('rides to `tasks.create` in document order, with the brief that names it', async () => {
    await type('fix the retry loop in #s');
    await press('Enter');
    await type('and #s');
    await press('Enter');
    await press('Escape');
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="composer-create"]')!
        .closest('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(invoke).toHaveBeenCalledWith('tasks.create', {
      // The pill serialises back to the repo's NAME and not to `#name`: the `#`
      // opens a picker, which is a thing this card does and not a thing the
      // sentence says, so it does not travel to an agent reading the brief.
      title: `fix the retry loop in shepherd${NBSP}and shepherd-ios`,
      brief: `fix the retry loop in shepherd${NBSP}and shepherd-ios${NBSP}`,
      repos: [
        { path: `${HOME}/dev/shepherd`, name: 'shepherd' },
        { path: `${HOME}/dev/shepherd-ios`, name: 'shepherd-ios' },
      ],
    });
  });
});

describe('the #repo button', () => {
  it('performs the gesture it teaches', async () => {
    // `#` is invisible until somebody has been told about it, and this is the
    // telling. It appends the character rather than opening a picker some other
    // way, so there is one code path whether it was typed or clicked.
    await act(async () => {
      container.querySelector<HTMLElement>('[data-testid="composer-hash"]')!.click();
    });
    expect(brief().textContent).toBe('#');
    expect(picker()).not.toBeNull();
  });
});

/**
 * The name ask, which happens behind the card and draws nothing.
 *
 * The composer turns your paragraph into a directory name, and a line reporting
 * that name re-rendered on every keystroke — the brief, echoed back a second time
 * under the brief. The ask is worth keeping and the echo is not, so the answer
 * rides `tasks.create` and never reaches the screen.
 */
describe('the name ask', () => {
  // Fake timers, because the ask is on a 2s idle pause and a real wait would put
  // two seconds into every one of these.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const brief = (): HTMLElement => container.querySelector<HTMLElement>('[data-testid="composer-brief"]')!;

  const write = async (text: string): Promise<void> => {
    await act(async () => {
      brief().textContent = text;
      brief().dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  /**
   * The idle pause, which is the only trigger there is.
   *
   * The composer has no blur hook to hang this on — the repo field it used to have
   * is gone, and picking a repo is a `#` mention inside the brief now. So the ask
   * fires when the typing stops, and a test has to let the timer run.
   */
  const idle = async (): Promise<void> => {
    await act(async () => {
      vi.advanceTimersByTime(2_100);
    });
    await act(async () => {});
  };

  it('draws nothing, whatever it has been told', async () => {
    invoke.mockImplementation(async (command: string) =>
      command === 'tasks.suggestName'
        ? { ok: true as const, value: { name: 'Add a cheap model seam' } }
        : { ok: true as const, value: [] },
    );
    await write('I wanna add a cheap model for naming tasks');
    await idle();
    await act(async () => {});
    expect(container.textContent).not.toContain('Add a cheap model seam');
    // And no line reserving the space for one, which is what used to echo the
    // brief back to somebody still writing it.
    expect(container.querySelector('[data-testid="composer-name"]')).toBeNull();
  });

  it('asks once the typing stops, carrying the brief', async () => {
    await write('I wanna add a cheap model for naming tasks');
    await idle();
    expect(invoke).toHaveBeenCalledWith('tasks.suggestName', {
      brief: 'I wanna add a cheap model for naming tasks',
    });
  });

  it('does not ask about a brief too short to name', async () => {
    await write('fix it');
    await idle();
    expect(invoke).not.toHaveBeenCalledWith('tasks.suggestName', expect.anything());
  });

  it('sends the name it has to create', async () => {
    invoke.mockImplementation(async (command: string) =>
      command === 'tasks.suggestName'
        ? { ok: true as const, value: { name: 'Add a cheap model seam' } }
        : { ok: true as const, value: { slug: 'add-a-cheap-model-seam' } },
    );
    await write('I wanna add a cheap model for naming tasks');
    await idle();
    await act(async () => {});
    await press('Enter', brief());
    expect(invoke).toHaveBeenCalledWith(
      'tasks.create',
      expect.objectContaining({ name: 'Add a cheap model seam' }),
    );
  });

  it('creates without a name when none has landed, rather than waiting for one', async () => {
    // THE case the whole design exists for: Create pressed before a ~6s answer.
    // The extension then names it from the brief, and nothing has been delayed.
    invoke.mockImplementation(async (command: string) =>
      command === 'tasks.suggestName'
        ? new Promise(() => {
            /* never answers */
          })
        : { ok: true as const, value: { slug: 'a-task' } },
    );
    await write('I wanna add a cheap model for naming tasks');
    await idle();
    await press('Enter', brief());
    const create = invoke.mock.calls.find((call) => call[0] === 'tasks.create');
    expect(create).toBeDefined();
    expect((create?.[1] as { name?: unknown }).name).toBeUndefined();
  });

  it('ignores an answer whose shape nobody expected', async () => {
    invoke.mockImplementation(async (command: string) =>
      command === 'tasks.suggestName'
        ? { ok: true as const, value: { name: 42 } }
        : { ok: true as const, value: { slug: 'a-task' } },
    );
    await write('I wanna add a cheap model for naming tasks');
    await idle();
    await act(async () => {});
    await press('Enter', brief());
    // Creates unnamed rather than carrying `42` into a directory name.
    const create = invoke.mock.calls.find((call) => call[0] === 'tasks.create');
    expect((create?.[1] as { name?: unknown }).name).toBeUndefined();
  });
});
