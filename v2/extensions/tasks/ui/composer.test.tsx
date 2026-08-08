// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskComposer } from './composer.tsx';

/**
 * The picker's keyboard, which is the half a smoke cannot see.
 *
 * Everything asserted here is a rule somebody has to be able to change without
 * finding out from a screenshot. The shape of it is: repos first, ⏎ adds one
 * and stays so several are several ⏎s, ↹ completes while there is something to
 * complete and hands over to the brief once there is not, ⏎ in the brief is
 * done. And ⎋ dismisses the completion without closing the composer — the only
 * place this component reaches past React, because Radix's dismissable layer
 * listens for Escape on the document in the capture phase.
 */

// React refuses to run `act` outside an act environment, and says so at the top
// of the first failure rather than where the problem is.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOME = '/Users/e';
const suggestion = (path: string, over: Record<string, unknown> = {}) => ({
  path,
  name: path.slice(path.lastIndexOf('/') + 1),
  isRepo: true,
  source: 'filesystem',
  ...over,
});

/** What the extension would answer, for the three queries these tests type. */
const ANSWERS: Record<string, readonly unknown[]> = {
  '': [suggestion(`${HOME}/dev/api`, { source: 'history' })],
  [`${HOME}/dev/sh`]: [
    suggestion(`${HOME}/dev/shepherd`),
    suggestion(`${HOME}/dev/shepherd-ios`),
    suggestion(`${HOME}/dev/shell-notes`, { isRepo: false }),
  ],
  [`${HOME}/dev/shell`]: [suggestion(`${HOME}/dev/shell-notes`, { isRepo: false })],
};

/** Typed through a factory, so the mock keeps the prop's signature. */
const makeInvoke = () =>
  vi.fn(async (command: string, args?: unknown) => {
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

const input = (): HTMLInputElement =>
  container.querySelector<HTMLInputElement>('[data-testid="composer-repo-path"]')!;
const rows = (): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[data-testid="composer-suggestion"]'),
];
const picked = (): string[] =>
  [...container.querySelectorAll<HTMLElement>('[data-testid="composer-picked-repo"]')].map(
    (row) => row.dataset.path ?? '',
  );

/** A real event, because the capture-phase listener under test is a real one. */
async function press(key: string, target: HTMLElement = input()): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

async function type(text: string): Promise<void> {
  const field = input();
  await act(async () => {
    // The native setter, or React's value tracker swallows the change.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, text);
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

describe('the repo picker', () => {
  it('comes BEFORE the brief in the document, because that is the order', () => {
    // What you are working on, then what to do to it. Under the brief it read
    // backwards, and a field below the thing it scopes is a field you find
    // after the brief is already written. Asserted as document order rather
    // than as CSS, which is what the tab order and a screen reader follow.
    const composer = container.querySelector('[data-testid="task-composer"]')!;
    const order = composer.compareDocumentPosition(
      container.querySelector('[data-testid="composer-brief"]')!,
    );
    const repo = container.querySelector('.sh-composer-repo')!;
    expect(order & Node.DOCUMENT_POSITION_CONTAINED_BY).toBeTruthy();
    expect(
      repo.compareDocumentPosition(container.querySelector('[data-testid="composer-brief"]')!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('offers the picked history before anything is typed', () => {
    expect(rows().map((row) => row.dataset.path)).toEqual([`${HOME}/dev/api`]);
  });

  it('shows ONE completion, as ghost text, never a list', async () => {
    // A dropdown of rows in a card whose purpose is the brief is a second thing
    // competing with it. One answer, inline, behind the caret.
    await type(`${HOME}/dev/sh`);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.dataset.path).toBe(`${HOME}/dev/shepherd`);
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it('draws only the part you have NOT typed, so it reads as a completion', async () => {
    await type(`${HOME}/dev/sh`);
    // The typed half is transparent rather than absent: it is what pushes the
    // rest to the caret, and dropping it would left-align the suggestion.
    expect(container.querySelector('.sh-composer-repo-typed')?.textContent).toBe(`${HOME}/dev/sh`);
    expect(rows()[0]?.textContent).toBe('epherd');
  });

  it('marks a directory that is not a repo, and still offers it', async () => {
    await type(`${HOME}/dev/shell`);
    expect(container.querySelector('.sh-composer-repo-note')?.textContent).toBe('not a repo');
  });
});

describe('the picker keyboard', () => {
  it('takes the completion with → at the end of the line', async () => {
    // The gesture people try before they try Tab. Anywhere but the end of the
    // line it stays an ordinary cursor move.
    await type(`${HOME}/dev/sh`);
    input().setSelectionRange(input().value.length, input().value.length);
    await press('ArrowRight');
    expect(input().value).toBe(`${HOME}/dev/shepherd`);
  });

  it('picks the completion with ⏎, and never submits the form', async () => {
    await type(`${HOME}/dev/sh`);
    const enter = await press('Enter');

    expect(picked()).toEqual([`${HOME}/dev/shepherd`]);
    expect(input().value).toBe('');
    // A task with the repo field half-typed is a task with the wrong repos.
    expect(enter.defaultPrevented).toBe(true);
    expect(invoke).not.toHaveBeenCalledWith('tasks.create', expect.anything());
  });

  it('adds what you typed when the list has been dismissed', async () => {
    await type(`${HOME}/dev/sh`);
    await press('Escape');
    await press('Enter');
    expect(picked()).toEqual([`${HOME}/dev/sh`]);
  });

  it('completes with ↹ to what the ghost is showing, without submitting', async () => {
    await type(`${HOME}/dev/sh`);
    const tab = await press('Tab');

    // Whatever is on screen — with one suggestion visible there is nothing else
    // it could honestly mean. It used to complete to the common prefix of every
    // match (`she`), which was right while a list was on screen and became a
    // promise the ghost text did not keep once the list went away.
    expect(input().value).toBe(`${HOME}/dev/shepherd`);
    expect(tab.defaultPrevented).toBe(true);
    expect(picked()).toEqual([]);
    // And it immediately asks again with the completed text, which is what makes
    // it navigable rather than a single-shot guess.
    expect(invoke).toHaveBeenCalledWith('tasks.suggestRepos', {
      title: '',
      brief: '',
      query: `${HOME}/dev/shepherd`,
    });
  });

  it('hands ↹ to the brief once there is nothing left to complete', async () => {
    // Which is exactly the state ⏎ leaves you in after it takes your last repo:
    // an empty field, the history alone (never a Tab target — those rows can
    // match from anywhere on disk, so their common prefix is not a real path).
    // Focus moves explicitly because the next tab stop is a chip's × button.
    const tab = await press('Tab');
    expect(tab.defaultPrevented).toBe(true);
    expect(input().value).toBe('');
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="composer-brief"]'),
    );
  });
});

describe('the brief', () => {
  const brief = (): HTMLElement =>
    container.querySelector<HTMLElement>('[data-testid="composer-brief"]')!;

  const write = async (text: string): Promise<void> => {
    await act(async () => {
      brief().textContent = text;
      brief().dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  it('submits on ⏎ — the chat convention the repo field hands you', async () => {
    await write('ship it');
    const enter = await press('Enter', brief());
    expect(enter.defaultPrevented).toBe(true);
    expect(invoke).toHaveBeenCalledWith('tasks.create', expect.objectContaining({ brief: 'ship it' }));
  });

  it('newlines on ⇧⏎, and creates nothing', async () => {
    await write('ship it');
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      brief().dispatchEvent(event);
    });
    // Not swallowed: the newline is contenteditable's to insert, and taking
    // the key to reimplement it is how the undo stack gets broken.
    expect(event.defaultPrevented).toBe(false);
    expect(invoke).not.toHaveBeenCalledWith('tasks.create', expect.anything());
  });
});

describe('⎋', () => {
  it('closes the list and leaves the composer open', async () => {
    await type(`${HOME}/dev/sh`);
    expect(rows()).not.toHaveLength(0);

    await press('Escape');

    expect(rows()).toHaveLength(0);
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
      await type(`${HOME}/dev/sh`);
      await press('Escape');
      expect(seen).toEqual([true]);
    } finally {
      document.removeEventListener('keydown', layer, true);
    }
  });

  it('does not swallow ⎋ from the brief, which is how you dismiss the composer', async () => {
    const brief = container.querySelector<HTMLTextAreaElement>('[data-testid="composer-brief"]')!;
    const event = await press('Escape', brief);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('a picked repo', () => {
  it('stops being offered — it is a chip now, and two of it reads as two repos', async () => {
    await press('Enter');
    expect(picked()).toEqual([`${HOME}/dev/api`]);
    expect(rows().map((row) => row.dataset.path)).not.toContain(`${HOME}/dev/api`);
  });
});
