// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fuzzyMatch } from '@shepherd/sdk';
import { Modal, readValue } from '@shepherd/ui';
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
 * `agents.listModels`, in the shape the real command answers — `SelectOption`
 * rows, which is why the composer reshapes nothing.
 *
 * The ids are the fixture's, not this page's: whatever the agent layer advertises
 * has to reach the select unchanged.
 */
const MODEL_ROWS = [
  { value: 'fable', label: 'Fable', description: 'deepest reasoning' },
  { value: 'opus', label: 'Opus', description: 'complex agentic work' },
  { value: 'sonnet', label: 'Sonnet', description: 'balanced' },
  { value: 'haiku', label: 'Haiku', description: 'fastest' },
];

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
    if (command === 'agents.listModels') return { ok: true as const, value: MODEL_ROWS };
    if (command === 'agents.defaultModel') return { ok: true as const, value: { model: 'opus' } };
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
      // Whose checkouts to offer. A repo path means something only on the machine
      // that holds it, so the ask names the machine the task is for — `here`
      // until somebody picks another.
      member: 'here',
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
      member: 'here',
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
      member: 'here',
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

  it('draws a FILLED folder for a repo and an outline one for a plain directory', async () => {
    /*
     * Full versus empty, which is the distinction the filled dot and hollow ring
     * this replaced were making — and it is carried by two different glyphs
     * rather than by colour alone, because one step of ink is not a difference
     * anybody notices at 13px.
     *
     * Asserted on the rendered glyph rather than in the stylesheet because it is
     * markup, and asserted as filled-vs-outline rather than by icon name so it
     * still holds if the pair is swapped for a better one: Tabler's filled
     * variants paint `fill` and carry no stroke, and its outline variants do the
     * opposite.
     */
    await type('#she');
    const marks = rows().map((row) => row.querySelector('.sh-composer-picker-mark svg'));
    const [repo, plain] = marks;
    expect(repo?.getAttribute('fill')).toBe('currentColor');
    expect(repo?.getAttribute('stroke')).toBe('none');
    expect(plain?.getAttribute('stroke')).toBe('currentColor');
    expect(plain?.getAttribute('fill')).toBe('none');
  });

  it('draws that mark through the design system, at its one stroke weight', async () => {
    /*
     * The mark was a hand-rolled `<svg>` with its own 1.8 stroke and its own
     * 14px, which is the drift `Icon` exists to prevent — "do not hand-roll a
     * control", and an extension cannot import Tabler for exactly this reason.
     * Pinning the primitive's own class, so a future hand-rolled path fails here
     * rather than shipping a fourth size and a second weight.
     */
    await type('#she');
    for (const row of rows()) {
      const glyph = row.querySelector('.sh-composer-picker-mark svg');
      expect(glyph?.getAttribute('class')).toContain('sh-icon');
      expect(glyph?.getAttribute('width')).toBe('13');
    }
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
    // The pill's own label carries no `#`: that character is the picker's syntax
    // and belongs to neither the sentence nor the token it submits as.
    expect(brief().textContent).toBe(`fix it in shepherd${NBSP}`);
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
      //
      // No `title`: the composer sends what was written and nothing it derived.
      brief: `fix the retry loop in shepherd${NBSP}and shepherd-ios${NBSP}`,
      repos: [
        { path: `${HOME}/dev/shepherd`, name: 'shepherd' },
        { path: `${HOME}/dev/shepherd-ios`, name: 'shepherd-ios' },
      ],
      // WHERE the task is made. `here` unless a machine was picked — a task is one
      // machine's (its repos are its disk's, its worktrees its directories, its
      // agents its daemon's), so this rides the create rather than being applied
      // to the record afterwards.
      member: 'here',
      // WHICH model its agents open on — pre-filled, and sent as shown.
      model: 'opus',
    });
  });
});


/**
 * The name ask is not the composer's any more.
 *
 * It ran here so that a name would exist by the time Create was pressed — the
 * folder and the branch were derived from it, and provisioning waited. Nothing
 * waits now, so the ask belongs where the answer is used: behind `tasks.create`,
 * after the task already exists.
 */
describe('the name ask', () => {
  // Fake timers, because the ask used to sit on a 2s idle pause: this asserts
  // that letting that pause elapse produces no ask at all.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const brief = (): HTMLElement => container.querySelector<HTMLElement>('[data-testid="composer-brief"]')!;

  const write = async (text: string): Promise<void> => {
    await act(async () => {
      brief().textContent = text;
      brief().dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  const idle = async (): Promise<void> => {
    await act(async () => {
      vi.advanceTimersByTime(2_100);
    });
    await act(async () => {});
  };

  it('never asks while you type', async () => {
    await write('I wanna add a cheap model for naming tasks');
    await idle();
    expect(invoke).not.toHaveBeenCalledWith('tasks.suggestName', expect.anything());
  });

  it('sends the brief and no name, so the extension decides what it is called', async () => {
    await write('I wanna add a cheap model for naming tasks');
    await idle();
    await press('Enter', brief());
    const create = invoke.mock.calls.find((call) => call[0] === 'tasks.create');
    expect(create).toBeDefined();
    expect((create?.[1] as { name?: unknown }).name).toBeUndefined();
    // And no title either: a title that IS present is one a person typed, and
    // the brief's first line is not that.
    expect((create?.[1] as { title?: unknown }).title).toBeUndefined();
    expect((create?.[1] as { brief?: unknown }).brief).toBe('I wanna add a cheap model for naming tasks');
  });

  it('draws no name of its own', async () => {
    await write('I wanna add a cheap model for naming tasks');
    await idle();
    expect(container.querySelector('[data-testid="composer-name"]')).toBeNull();
  });
});

/**
 * WHICH model the task's agents open on.
 *
 * Asserted on the OPTIONS rather than on the ask: an empty select is
 * indistinguishable from a machine that advertises no models.
 */
describe('the model picker', () => {
  const model = (): HTMLElement | null =>
    container.querySelector<HTMLElement>('.sh-composer-select--model');
  const options = (): string[] => {
    const list = model();
    return [...(list?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])].map(
      (option) => option.textContent ?? '',
    );
  };
  const open = async (): Promise<void> => {
    await act(async () => {
      model()?.querySelector<HTMLElement>('.sh-ui-select__trigger')?.click();
    });
  };

  it('asks the agent layer for the list AND for which one it opens on', () => {
    // `agents.listModels` — the primitive. `quickModelChoices` is this list
    // narrowed to the CHEAP tier, and offering that to somebody starting real
    // work is a menu chosen for being cheap.
    expect(invoke).toHaveBeenCalledWith('agents.listModels', {});
    // A second, different question: what exists, then which of them you get.
    expect(invoke).toHaveBeenCalledWith('agents.defaultModel', {});
  });

  it('draws every model the answer carried, and NOTHING else', async () => {
    await open();
    // No *Default* row: there is no "default" model to pick, there is a model you
    // get by default and it is the one showing on the trigger. Labels only — the
    // kind's own gloss on each model is not a thing the list draws.
    expect(options()).toEqual(MODEL_ROWS.map((row) => row.label));
  });

  it('opens PRE-FILLED with the resolved default, and sends it', async () => {
    expect(model()?.querySelector('.sh-ui-select__value')?.textContent).toBe('Opus');

    await type('add a model picker to the composer');
    await act(async () => {
      container.querySelector<HTMLElement>('[data-testid="composer-create"]')!.click();
    });

    // Sent even though nobody touched the control: what the card SHOWED is what
    // the task gets, rather than the extension resolving it again.
    const [, args] = invoke.mock.calls.find(([command]) => command === 'tasks.create')!;
    expect(args).toMatchObject({ model: 'opus' });
  });

  it('leaves the model out when the agent layer could not say', async () => {
    // With no answer there is nothing true to send, so the key is absent and the
    // extension's own default decides.
    const spy = vi.fn(async (command: string, args?: unknown): Promise<{ ok: true; value: unknown }> => {
      if (command === 'agents.listModels') return { ok: true as const, value: MODEL_ROWS };
      if (command === 'agents.defaultModel') return { ok: true as const, value: null };
      if (command === 'tasks.suggestRepos') {
        const query = (args as { query?: string }).query ?? '';
        return { ok: true as const, value: ANSWERS[query] ?? [] };
      }
      return { ok: true as const, value: { slug: 'a-task' } };
    });
    unmount();
    mount(<TaskComposer invoke={spy as ReturnType<typeof makeInvoke>} done={makeDone()} />);
    await act(async () => undefined);

    await type('add a model picker to the composer');
    await act(async () => {
      container.querySelector<HTMLElement>('[data-testid="composer-create"]')!.click();
    });

    const [, args] = spy.mock.calls.find(([command]) => command === 'tasks.create')!;
    expect(args).not.toHaveProperty('model');
  });

  it('sends a picked model instead of the default', async () => {
    await open();
    const item = [...(model()?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])].find(
      (element) => element.textContent?.startsWith('Fable'),
    );
    if (item === undefined) throw new Error('the model select did not open');
    await act(async () => {
      item.click();
    });

    expect(model()?.querySelector('.sh-ui-select__value')?.textContent).toBe('Fable');

    await type('add a model picker to the composer');
    await act(async () => {
      container.querySelector<HTMLElement>('[data-testid="composer-create"]')!.click();
    });

    const [, args] = invoke.mock.calls.find(([command]) => command === 'tasks.create')!;
    expect(args).toMatchObject({ model: 'fable' });
  });

});

/**
 * WHICH machine a task starts on.
 *
 * A task is one machine's — its repos are checkouts on a disk, its worktrees are
 * directories there, and its agents are ptys in that machine's daemon — so this is
 * not a preference applied to a record afterwards. It decides where the whole
 * thing is made, which is why the repo picker has to ask the same machine.
 */
describe('the machine picker', () => {
  const machine = (): HTMLElement | null =>
    container.querySelector<HTMLElement>('.sh-composer-select--machine');

  function withMachines(machines: unknown): ReturnType<typeof makeInvoke> {
    const spy = vi.fn(async (command: string, args?: unknown): Promise<{ ok: true; value: unknown }> => {
      if (command === 'tasks.machines') return { ok: true as const, value: machines };
      if (command === 'tasks.suggestRepos') {
        const query = (args as { query?: string }).query ?? '';
        return { ok: true as const, value: ANSWERS[query] ?? [] };
      }
      return { ok: true as const, value: { slug: 'a-task' } };
    });
    return spy as ReturnType<typeof makeInvoke>;
  }

  it('is absent when there is only one machine to choose', async () => {
    // One machine is not a decision, and a control that always says "This Mac"
    // teaches nothing while taking space in the one row that must stay readable.
    const spy = withMachines({ machines: [{ id: 'here', name: 'This Mac', here: true }] });
    mount(<TaskComposer invoke={spy} done={makeDone()} />);
    await act(async () => undefined);

    expect(spy).toHaveBeenCalledWith('tasks.machines', {});
    expect(machine()).toBeNull();
  });

  it('appears with the net’s members, and starts on this Mac', async () => {
    const spy = withMachines({
      machines: [
        { id: 'here', name: 'This Mac', here: true },
        { id: 'mac-b', name: 'Work Mac', here: false },
      ],
    });
    mount(<TaskComposer invoke={spy} done={makeDone()} />);
    await act(async () => undefined);

    // The default is never "wherever it was last": a composer that quietly opens
    // on another machine creates work in a place nobody looked at.
    //
    // Read off the TRIGGER's text now rather than a `data-machine` attribute:
    // the picker is a `Select` like the model and placement controls beside it,
    // because three dropdowns on one row that are three different components is
    // three things to keep in step.
    expect(machine()?.querySelector('.sh-ui-select__value')?.textContent).toContain('This Mac');
  });

  it('asks the CHOSEN machine for its repos, and creates the task there', async () => {
    const spy = withMachines({
      machines: [
        { id: 'here', name: 'This Mac', here: true },
        { id: 'mac-b', name: 'Work Mac', here: false },
      ],
    });
    mount(<TaskComposer invoke={spy} done={makeDone()} />);
    await act(async () => undefined);

    await act(async () => {
      // The TRIGGER, not the Select's root: the root is a positioning box and a
      // click on it opens nothing.
      machine()?.querySelector<HTMLElement>('.sh-ui-select__trigger')?.click();
    });
    const item = [...(machine()?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])].find(
      (element) => element.textContent?.includes('Work Mac'),
    );
    if (item === undefined) throw new Error('the machine select did not open');
    /*
     * `element.click()`, not a dispatched `MouseEvent('click')`: Radix's item
     * reads properties the synthetic one leaves at zero and ignores it entirely,
     * so the menu was demonstrably open and the choice never landed. `menu.test`
     * in @shepherd/ui does the same thing for the same reason.
     */
    await act(async () => {
      item.click();
    });

    expect(machine()?.querySelector('.sh-ui-select__value')?.textContent).toContain('Work Mac');

    // The repos are re-asked OF THAT MACHINE. Not merely cleared: the zero-query
    // answer is the history of repos actually used over there, which is exactly
    // what somebody wants to see next — and a path from this Mac's disk would
    // fail `git worktree add` over there after Create had been pressed.
    const asks = spy.mock.calls.filter((call) => call[0] === 'tasks.suggestRepos');
    expect((asks[asks.length - 1]?.[1] as { member?: string }).member).toBe('mac-b');

    await act(async () => {
      brief().textContent = 'do a thing';
      brief().dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    const created = spy.mock.calls.find((call) => call[0] === 'tasks.create');
    expect((created?.[1] as { member?: string }).member).toBe('mac-b');
  });
});

/**
 * A pasted link, and the two halves of what makes it safe: the pill lands with
 * the token already correct, and the answer that arrives later changes only what
 * a person reads.
 */
describe('a pasted link', () => {
  const JIRA = 'https://x.atlassian.net/browse/SHEP-412';
  const PATTERNS = [
    { hostSuffix: '.atlassian.net', pathPrefix: '/browse/', vendor: 'jira' },
    { hostSuffix: '.slack.com', pathPrefix: '/archives/', vendor: 'slack' },
  ];

  /** A composer wired to answer the two link verbs however a case needs. */
  const linkComposer = async (
    resolved: unknown,
    opts: { patterns?: unknown } = {},
  ): Promise<void> => {
    const base = makeInvoke();
    const spy = vi.fn(async (command: string, args?: unknown) => {
      if (command === 'tasks.linkPatterns') {
        return { ok: true as const, value: { patterns: opts.patterns ?? PATTERNS } };
      }
      if (command === 'tasks.resolveLink') return { ok: true as const, value: resolved };
      return base(command, args);
    });
    mount(<TaskComposer invoke={spy as ReturnType<typeof makeInvoke>} done={makeDone()} />);
    // The patterns are a round trip; without settling, every paste falls through.
    await act(async () => {
      await Promise.resolve();
    });
  };

  const pasteText = async (text: string): Promise<void> => {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { files: [], getData: () => text },
    });
    await act(async () => {
      brief().dispatchEvent(event);
      await Promise.resolve();
    });
  };

  /**
   * jsdom has no `execCommand`, and the fall-through cases below reach it — a
   * paste this composer does NOT claim is handed to the browser's own insert,
   * which is what keeps its undo entry. Stubbing it records what would have
   * landed, so those cases assert the text arrived rather than only that no pill
   * did.
   */
  let inserted: string[];
  beforeEach(() => {
    inserted = [];
    (document as unknown as { execCommand: unknown }).execCommand = (
      _name: string,
      _ui: boolean,
      value: string,
    ) => {
      inserted.push(value);
      return true;
    };
  });
  afterEach(() => {
    delete (document as unknown as { execCommand?: unknown }).execCommand;
  });

  const linkPills = (): HTMLElement[] => [
    ...brief().querySelectorAll<HTMLElement>('.sh-composer-link-pill'),
  ];

  it('becomes one atomic pill whose token is the url', async () => {
    await linkComposer({ vendor: 'jira', label: 'SHEP-412 Retry loop', resolved: true });
    await pasteText(JIRA);
    const [pill] = linkPills();
    expect(pill?.dataset['token']).toBe(JIRA);
    expect(pill?.contentEditable).toBe('false');
    expect(readValue(brief())).toContain(JIRA);
  });

  it('swaps the label in when the answer lands, and leaves the token alone', async () => {
    await linkComposer({ vendor: 'jira', label: 'SHEP-412 Retry loop', resolved: true });
    await pasteText(JIRA);
    const [pill] = linkPills();
    expect(pill?.textContent).toBe('SHEP-412 Retry loop');
    expect(pill?.dataset['link']).toBe('jira');
    // The brief an agent reads did not change when the label did.
    expect(readValue(brief())).toContain(JIRA);
    expect(readValue(brief())).not.toContain('Retry loop');
  });

  /**
   * The vendor comes from the PATTERN, so a pill nothing ever answers for is
   * still Jira-blue and wearing Jira's mark, saying only that it is busy. That
   * is also what the first frame of every paste looks like: the tint and the
   * mark no longer arrive a subprocess later.
   */
  it('is the vendor’s already, and says it is loading, when nothing answers', async () => {
    await linkComposer(null);
    await pasteText(JIRA);
    const [pill] = linkPills();
    expect(pill?.dataset['link']).toBe('jira');
    expect(pill?.querySelector('svg')).not.toBeNull();
    expect(pill?.textContent).toBe('Loading…');
    expect(readValue(brief())).toContain(JIRA);
  });

  it('keeps what the pattern said for an answer naming a vendor it cannot tint', async () => {
    await linkComposer({ vendor: 'linear', label: 'ENG-1', resolved: true });
    await pasteText(JIRA);
    const [pill] = linkPills();
    // The malformed answer changes nothing rather than blanking a pill that was
    // already drawn — `CardFact`'s rule, and now with something to fall back to.
    expect(pill?.textContent).toBe('Loading…');
    expect(pill?.dataset['link']).toBe('jira');
  });

  /**
   * A pattern the renderer could not draw is one it must not match, because
   * there is no untinted link pill to fall back to any more.
   */
  it('pastes as text when the only pattern names an undrawable vendor', async () => {
    await linkComposer(null, {
      patterns: [{ hostSuffix: '.atlassian.net', pathPrefix: '/browse/', vendor: 'linear' }],
    });
    await pasteText(JIRA);
    expect(linkPills()).toHaveLength(0);
    expect(inserted).toEqual([JIRA]);
  });

  it('pastes a url no pattern claims as ordinary text', async () => {
    await linkComposer(null);
    await pasteText('https://example.com/x');
    expect(linkPills()).toHaveLength(0);
    expect(inserted).toEqual(['https://example.com/x']);
  });

  it('pastes a sentence containing a url as ordinary text', async () => {
    await linkComposer(null);
    await pasteText(`see ${JIRA} please`);
    expect(linkPills()).toHaveLength(0);
    expect(inserted).toEqual([`see ${JIRA} please`]);
  });

  it('claims nothing while the patterns are still in flight', async () => {
    // A composer that swallowed pastes before it knew what to swallow would eat
    // a URL it could not draw.
    await linkComposer(null, { patterns: [] });
    await pasteText(JIRA);
    expect(linkPills()).toHaveLength(0);
    expect(inserted).toEqual([JIRA]);
  });

  it('gives each pill its own id, so two answers cannot cross', async () => {
    await linkComposer({ vendor: 'jira', label: 'SHEP-412', resolved: true });
    await pasteText(JIRA);
    await pasteText('https://x.slack.com/archives/C1/p1724500000123456');
    const ids = linkPills().map((pill) => pill.dataset['linkId']);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});
