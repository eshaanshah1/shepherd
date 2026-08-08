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
 * finding out from a screenshot: ↓/↑ move, ⏎ picks, ↹ completes WITHOUT
 * submitting, and ⎋ closes the list and not the composer — the last one being
 * the only place this component reaches past React, because Radix's dismissable
 * layer listens for Escape on the document in the capture phase.
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
  matched: [],
  ...over,
});

/** What the extension would answer, for the three queries these tests type. */
const ANSWERS: Record<string, readonly unknown[]> = {
  '': [suggestion(`${HOME}/dev/api`, { source: 'history', matched: [0, 1] })],
  [`${HOME}/dev/sh`]: [
    suggestion(`${HOME}/dev/shepherd`, { matched: [13, 14] }),
    suggestion(`${HOME}/dev/shepherd-ios`, { matched: [13, 14] }),
    suggestion(`${HOME}/dev/shell-notes`, { isRepo: false }),
  ],
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
  it('is a labelled input, not an inline afterthought', () => {
    // The whole reason it was rebuilt: it has to read as the place repos go.
    const label = container.querySelector<HTMLLabelElement>('.sh-composer-repo-label');
    expect(label?.htmlFor).toBe(input().id);
    expect(label?.textContent).toBe('repo');
  });

  it('offers the picked history before anything is typed', () => {
    expect(rows().map((row) => row.dataset.path)).toEqual([`${HOME}/dev/api`]);
  });

  it('draws the whole path with the matched characters emphasised', async () => {
    await type(`${HOME}/dev/sh`);
    const [first] = rows();
    expect(first?.textContent).toContain(`${HOME}/dev/shepherd`);
    // What is bold is what the RANKER matched — the positions crossed the port
    // with the row rather than being re-derived here.
    expect(first?.querySelector('.sh-composer-repo-hit')?.textContent).toBe('sh');
  });

  it('marks a directory that is not a repo, and still offers it', async () => {
    await type(`${HOME}/dev/sh`);
    const notRepo = rows().find((row) => row.dataset.path === `${HOME}/dev/shell-notes`);
    expect(notRepo?.textContent).toContain('not a repo');
  });
});

describe('the picker keyboard', () => {
  it('moves the highlight with ↓ and ↑, and wraps', async () => {
    await type(`${HOME}/dev/sh`);
    expect(rows()[0]?.getAttribute('aria-selected')).toBe('true');

    await press('ArrowDown');
    expect(rows()[1]?.getAttribute('aria-selected')).toBe('true');

    await press('ArrowUp');
    expect(rows()[0]?.getAttribute('aria-selected')).toBe('true');

    // A list you can arrow off the end of makes the last row harder to reach
    // than the first, for no reason.
    await press('ArrowUp');
    expect(rows()[2]?.getAttribute('aria-selected')).toBe('true');
  });

  it('picks the highlighted row with ⏎, and never submits the form', async () => {
    await type(`${HOME}/dev/sh`);
    await press('ArrowDown');
    const enter = await press('Enter');

    expect(picked()).toEqual([`${HOME}/dev/shepherd-ios`]);
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

  it('completes with ↹ as far as every filesystem match agrees, without submitting', async () => {
    await type(`${HOME}/dev/sh`);
    const tab = await press('Tab');

    // `shepherd` and `shepherd-ios` agree that far; `shell-notes` does not, and
    // is why the answer is not the highlighted row's whole path.
    expect(input().value).toBe(`${HOME}/dev/she`);
    expect(tab.defaultPrevented).toBe(true);
    expect(picked()).toEqual([]);
    // And it immediately asks again with the completed text, which is what makes
    // it navigable rather than a single-shot guess.
    expect(invoke).toHaveBeenCalledWith('tasks.suggestRepos', {
      title: '',
      brief: '',
      query: `${HOME}/dev/she`,
    });
  });

  it('lets ↹ move focus when there is nothing to complete', async () => {
    // The history is not a Tab target: those rows can match the same query from
    // anywhere on disk, so their common prefix is not a real path.
    const tab = await press('Tab');
    expect(tab.defaultPrevented).toBe(false);
    expect(input().value).toBe('');
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

describe('clicking a suggestion', () => {
  it('adds it, and stops it being offered twice', async () => {
    await act(async () => {
      rows()[0]?.click();
    });
    expect(picked()).toEqual([`${HOME}/dev/api`]);
    expect(rows().map((row) => row.dataset.path)).not.toContain(`${HOME}/dev/api`);
  });
});
