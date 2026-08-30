// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Result } from '@shepherd/sdk';
import { ReviewPane } from './review.tsx';

/**
 * What the review tab DRAWS — the half no unit test of the service half can see.
 *
 * The claims worth pinning are the ones the design turns on: one PR skips the
 * list, the crumb appears only when there is a list to go back to, the state
 * word says which check failed, `Merge` is absent rather than disabled while it
 * cannot merge, and the keys are dead while the pane is not focused.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let calls: { command: string; args: unknown }[];

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  calls = [];
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const pr = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  repo: 'shepherd/v2',
  repoKey: 'v2',
  number: 301,
  title: 'Add multiple task tabs',
  state: 'open',
  baseRef: 'main',
  headRef: 'tabs',
  url: 'https://github.com/shepherd/v2/pull/301',
  added: 214,
  removed: 38,
  changedFiles: 12,
  checks: [],
  approvals: [],
  changesRequested: [],
  threads: [],
  files: [],
  openedAt: 0,
  updatedAt: 0,
  mergeState: 'clean',
  dependsOn: [],
  ...over,
});

const key = (entry: Record<string, unknown>): string => `${String(entry['repo'])}#${String(entry['number'])}`;

function answer(prs: readonly Record<string, unknown>[], over: Record<string, unknown> = {}): unknown {
  const live = prs.filter((entry) => entry['state'] === 'open' || entry['state'] === 'draft');
  const done = prs.filter((entry) => entry['state'] === 'merged' || entry['state'] === 'closed');
  return {
    prs,
    open: live.map(key),
    closed: done.map(key),
    syncedAt: 1_000,
    signedIn: true,
    ...over,
  };
}

/** One repo with something uncommitted, for the no-PR view. */
const DIRTY_REPO = {
  name: 'v2',
  path: '/task/v2',
  branch: 'feature',
  base: 'main',
  files: [{ path: 'a.ts', status: 'modified', patch: 'diff --git a/a.ts b/a.ts\n' }],
  refuse: null,
};

function draw(
  prs: readonly Record<string, unknown>[],
  options: {
    focused?: boolean;
    over?: Record<string, unknown>;
    /** What `github.changes` answers — only the no-PR view asks. */
    changes?: Record<string, unknown>;
  } = {},
): void {
  const invoke = async (command: string, args?: unknown): Promise<Result<unknown, { code: string; message: string }>> => {
    calls.push({ command, args });
    if (command === 'github.prs') return { ok: true, value: answer(prs, options.over ?? {}) };
    if (command === 'github.changes') return { ok: true, value: options.changes ?? { repos: [] } };
    if (command === 'github.commitDiff') {
      return {
        ok: true,
        value: { files: [{ path: 'src/tree.ts', added: 2, removed: 0, patch: '@@ -1,2 +1,4 @@\n keep\n+added' }] },
      };
    }
    return { ok: true, value: { ok: true } };
  };
  act(() => {
    root.render(
      <ReviewPane state={{ task: 't-1' }} focused={options.focused ?? true} invoke={invoke} />,
    );
  });
  // The mount's `github.prs` resolves on a microtask.
  act(() => {});
}

const text = (selector: string): string | undefined => host.querySelector(selector)?.textContent ?? undefined;
const all = (selector: string): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(selector)];

const one = (selector: string): HTMLElement => {
  const found = host.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`no ${selector}`);
  return found;
};

/**
 * An image that finished loading at a given width.
 *
 * jsdom fetches nothing, so `naturalWidth` is 0 forever and `load` never fires.
 * Both are defined here because the width IS the assertion: it is how the byline
 * tells a picture somebody uploaded from one GitHub drew.
 */
const loaded = (image: HTMLImageElement, naturalWidth: number): void => {
  Object.defineProperty(image, 'naturalWidth', { value: naturalWidth, configurable: true });
  act(() => {
    image.dispatchEvent(new Event('load', { bubbles: false }));
  });
};

// jsdom resolves promises between acts; one flush is enough for these.
const settle = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

describe('the home page (7a)', () => {
  it('draws a row per PR, repo first', async () => {
    // "The sdk one", not "forty-four" — the repo is the axis you choose along.
    draw([pr(), pr({ repo: 'shepherd/sdk', repoKey: 'sdk', number: 44, headRef: 'sdk', title: 'Tab rows' })]);
    await settle();
    const repos = all('.sh-pr-row__repo').map((node) => node.textContent);
    expect(repos).toHaveLength(2);
    expect(repos).toContain('shepherd/sdk');
  });

  it('says which check failed, not how many', async () => {
    draw([
      pr(),
      pr({
        repo: 'shepherd/sdk',
        repoKey: 'sdk',
        number: 44,
        headRef: 'sdk',
        checks: [{ name: 'lint', state: 'passed' }, { name: 'typecheck', state: 'failed' }],
      }),
    ]);
    await settle();
    expect(host.textContent).toContain('typecheck failed');
  });

  it('counts the set in the head, and says how many repos when it is more than one', async () => {
    draw([pr(), pr({ repo: 'shepherd/sdk', repoKey: 'sdk', number: 44, headRef: 'sdk' })]);
    await settle();
    expect(text('.sh-review__count')).toBe('2 across 2 repos');
  });

  it('draws finished work as its own section, kept', async () => {
    draw([pr(), pr({ number: 288, state: 'merged', headRef: 'old' })]);
    await settle();
    expect(host.textContent).toContain('Merged');
    expect(all('.sh-pr-row--closed')).toHaveLength(1);
  });

  it('names the land order and what is blocking it, once there are two', async () => {
    draw([
      pr({ dependsOn: ['shepherd/sdk#44'] }),
      pr({
        repo: 'shepherd/sdk',
        repoKey: 'sdk',
        number: 44,
        headRef: 'sdk',
        checks: [{ name: 'typecheck', state: 'failed' }],
      }),
    ]);
    await settle();
    expect(text('.sh-review__order')).toContain('sdk #44 → v2 #301');
    expect(text('.sh-review__blocked')).toBe('blocked · sdk #44');
  });

  it('draws no task footer for a single PR, because the sequence IS the PR', async () => {
    draw([pr(), pr({ number: 288, state: 'merged', headRef: 'old' })]);
    await settle();
    expect(host.querySelector('.sh-review__foot')).toBeNull();
  });

  /*
   * No PR is the state BEFORE one, not an empty page — so the pane shows what
   * the task has CHANGED, and offers to open the PR from there. It used to draw
   * "They appear here as soon as one is opened", which was true, useless, and
   * unreachable: the rail drew no icon for a task with no PR at all.
   */
  it('shows the working tree, not an empty page, when there is no PR', async () => {
    draw([], { changes: { repos: [] } });
    await settle();
    expect(host.textContent).toContain('No pull request yet');
  });

  it('still says which nothing it is when GitHub is not signed in', async () => {
    // Being signed out is a different answer from having no PR, and the create
    // button must not be offered for it.
    draw([], { over: { signedIn: false }, changes: { repos: [DIRTY_REPO] } });
    await settle();
    expect(host.textContent).toContain('not signed in');
    expect([...host.querySelectorAll('button')].some((b) => b.textContent?.includes('Create'))).toBe(
      false,
    );
  });

  it('offers Create pull request for a repo that can have one', async () => {
    draw([], { changes: { repos: [DIRTY_REPO] } });
    await settle();
    expect([...host.querySelectorAll('button')].some((b) => b.textContent?.includes('Create'))).toBe(
      true,
    );
  });

  it('gives a REASON rather than a dead button when a repo cannot', async () => {
    draw([], {
      changes: { repos: [{ ...DIRTY_REPO, refuse: 'nothing committed on this branch yet' }] },
    });
    await settle();
    expect(host.textContent).toContain('nothing committed');
    expect([...host.querySelectorAll('button')].some((b) => b.textContent?.includes('Create'))).toBe(
      false,
    );
  });
});

describe('one PR (7c)', () => {
  it('IS the tab — no crumb, no position, no list to click past', async () => {
    draw([pr()]);
    await settle();
    expect(host.querySelector('.sh-review__back')).toBeNull();
    expect(host.querySelector('.sh-review__position')).toBeNull();
    expect(host.querySelector('.sh-pr-detail')).not.toBeNull();
    expect(text('.sh-pr-brief__title')).toBe('Add multiple task tabs');
  });

  it('stops being the whole tab as soon as there is a second one', async () => {
    draw([pr(), pr({ number: 305, headRef: 'more' })]);
    await settle();
    expect(host.querySelector('.sh-pr-detail')).toBeNull();
    expect(all('.sh-pr-row')).toHaveLength(2);
  });

  it('keeps the list when the second PR is FINISHED, since that history is worth seeing', async () => {
    draw([pr(), pr({ number: 288, state: 'merged', headRef: 'old' })]);
    await settle();
    expect(host.querySelector('.sh-pr-detail')).toBeNull();
  });
});

describe('opening one (7b)', () => {
  it('grows the crumb and says where you are in the set', async () => {
    draw([pr(), pr({ number: 305, headRef: 'more' })]);
    await settle();
    act(() => all('.sh-pr-row')[0]?.click());
    expect(text('.sh-review__back')).toContain('PRs');
    expect(text('.sh-review__position')).toBe('Esc · 1 of 2');
  });

  it('comes back on the crumb', async () => {
    draw([pr(), pr({ number: 305, headRef: 'more' })]);
    await settle();
    act(() => all('.sh-pr-row')[0]?.click());
    act(() => host.querySelector<HTMLButtonElement>('.sh-review__back')?.click());
    expect(all('.sh-pr-row')).toHaveLength(2);
  });
});

describe('the footer’s primary', () => {
  it('is Merge when it can merge', async () => {
    draw([pr({ checks: [{ name: 'lint', state: 'passed' }], approvals: ['jane'] })]);
    await settle();
    expect(host.textContent).toContain('Merge v2 #301');
  });

  it('is ABSENT rather than disabled when it cannot, and the reason is in words', async () => {
    // A disabled primary teaches you nothing.
    draw([pr({ checks: [{ name: 'typecheck', state: 'failed' }], mergeState: 'blocked' })]);
    await settle();
    expect(host.textContent).not.toContain('Merge v2');
    expect(text('.sh-pr-brief__because')).toContain('typecheck failed');
  });

  it('says GitHub is still deciding rather than offering a button that would fail', async () => {
    draw([pr({ mergeState: 'unknown' })]);
    await settle();
    expect(text('.sh-pr-brief__because')).toContain('still working out');
  });
});

describe('the verbs', () => {
  it('hands a failing check to an agent, naming the check', async () => {
    draw([pr({ checks: [{ name: 'typecheck', state: 'failed', summary: 'two errors' }] })]);
    await settle();
    const hand = all('button').find((node) => node.textContent?.includes('Hand to agent'));
    act(() => hand?.click());
    expect(calls.find((call) => call.command === 'github.handToAgent')?.args).toMatchObject({
      task: 't-1',
      pr: 'shepherd/v2#301',
      check: 'typecheck',
    });
  });

  it('makes the sync line the sync button', async () => {
    // `synced 12s ago` invites "and if I don't want to wait", so the thing that
    // answers it is the thing that says it.
    draw([pr()]);
    await settle();
    act(() => host.querySelector<HTMLButtonElement>('.sh-review__synced')?.click());
    expect(calls.some((call) => call.command === 'github.sync')).toBe(true);
  });

  it('reports a refusal rather than looking like nothing happened', async () => {
    const invoke = async (command: string): Promise<Result<unknown, { code: string; message: string }>> => {
      if (command === 'github.prs') return { ok: true, value: answer([pr({ approvals: ['jane'] })]) };
      return { ok: true, value: { ok: false, reason: 'somebody merged it first' } };
    };
    act(() => {
      root.render(<ReviewPane state={{ task: 't-1' }} focused invoke={invoke} />);
    });
    await settle();
    const merge = all('button').find((node) => node.textContent?.includes('Merge'));
    await act(async () => {
      merge?.click();
      await Promise.resolve();
    });
    expect(text('.sh-review__problem')).toBe('somebody merged it first');
  });
});

describe('the keys', () => {
  const press = (key: string, init: KeyboardEventInit = {}): void => {
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
    });
  };

  it('are dead while the pane is not focused', async () => {
    // A background review tab that still answered H would fight the pane you
    // are looking at, and nothing would say which one acted.
    draw([pr({ checks: [{ name: 'typecheck', state: 'failed' }] })], { focused: false });
    await settle();
    press('h');
    expect(calls.some((call) => call.command === 'github.handToAgent')).toBe(false);
  });

  it('hand over on H when focused, naming the failing check', async () => {
    draw([pr({ checks: [{ name: 'typecheck', state: 'failed' }] })]);
    await settle();
    press('h');
    expect(calls.find((call) => call.command === 'github.handToAgent')?.args).toMatchObject({
      task: 't-1',
      pr: 'shepherd/v2#301',
      check: 'typecheck',
    });
  });

  it('presses the BRIEF’s button, so the menu can hang off something mounted', async () => {
    /*
     * H used to call `onHandCheck`, which anchors the destination menu to the
     * check row's button — and that button exists only while the row is
     * expanded. Collapse it, press H, and `choosing` was set with no anchor
     * rendered anywhere: the menu drew nothing and the hand-off was silent.
     *
     * The brief's button is always on screen while the merge is blocked, which
     * is the whole reason the key belongs to it.
     */
    draw([pr({ mergeState: 'blocked', checks: [{ name: 'typecheck', state: 'failed', log: 'boom' }] })]);
    await settle();
    // Collapse the failing check, which opens by default.
    act(() => all('.sh-pr-line').find((node) => node.textContent?.includes('typecheck'))?.click());
    expect(all('.sh-pr-check__verbs')).toHaveLength(0);

    press('h');
    // The brief still carries a `Hand to agent`, so the menu has an anchor.
    expect(text('.sh-pr-brief__verbs')).toContain('Hand to agent');
    expect(calls.some((call) => call.command === 'github.handToAgent')).toBe(true);
  });

  it('draws the H legend on exactly one control', async () => {
    // Three buttons used to claim it and only one could ever be right. A legend
    // on a control the key does not press is a promise the keyboard breaks.
    draw([
      pr({
        mergeState: 'blocked',
        checks: [{ name: 'typecheck', state: 'failed', log: 'boom' }],
        threads: [{ id: 'T1', author: 'sam', path: 'src/tree.ts', line: 61, resolved: false, body: 'use the token' }],
      }),
    ]);
    await settle();
    const caps = all('.sh-ui-keycap').filter((node) => node.textContent === 'H');
    expect(caps).toHaveLength(1);
    expect(caps[0]?.closest('.sh-pr-brief__verbs')).not.toBeNull();
  });

  it('Esc goes back to the list, and does nothing when there is no list', async () => {
    draw([pr(), pr({ number: 305, headRef: 'more' })]);
    await settle();
    act(() => all('.sh-pr-row')[0]?.click());
    press('Escape');
    expect(all('.sh-pr-row')).toHaveLength(2);

    // A one-PR tab must not swallow Escape — there is nowhere to go.
    draw([pr()]);
    await settle();
    press('Escape');
    expect(host.querySelector('.sh-pr-detail')).not.toBeNull();
  });

  it('⌘⇧] walks the set without going back up', async () => {
    draw([pr(), pr({ number: 305, headRef: 'more' })]);
    await settle();
    act(() => all('.sh-pr-row')[0]?.click());
    expect(text('.sh-review__position')).toBe('Esc · 1 of 2');
    press(']', { metaKey: true, shiftKey: true });
    expect(text('.sh-review__position')).toBe('Esc · 2 of 2');
  });
});

describe('a pane whose state cannot be read', () => {
  it('says so instead of drawing an empty rectangle', async () => {
    act(() => {
      root.render(
        <ReviewPane
          state={{ nothing: true }}
          focused
          invoke={async () => ({ ok: true, value: undefined })}
        />,
      );
    });
    await settle();
    expect(text('.sh-review__nothing')).toContain('lost track of which task');
  });
});

describe('landing the task', () => {
  it('offers the sequence, and asks for it by name', async () => {
    draw([
      pr({ approvals: ['jane'], dependsOn: ['shepherd/sdk#44'] }),
      pr({ repo: 'shepherd/sdk', repoKey: 'sdk', number: 44, headRef: 'sdk', approvals: ['jane'] }),
    ]);
    await settle();
    const land = all('button').find((node) => node.textContent?.includes('Land task'));
    expect(land?.hasAttribute('disabled')).toBe(false);
    act(() => land?.click());
    expect(calls.find((call) => call.command === 'github.land')?.args).toEqual({ task: 't-1' });
  });

  it('is disabled while anything is blocking, so one press is never a half-landing', async () => {
    draw([
      pr({ dependsOn: ['shepherd/sdk#44'] }),
      pr({
        repo: 'shepherd/sdk',
        repoKey: 'sdk',
        number: 44,
        headRef: 'sdk',
        checks: [{ name: 'typecheck', state: 'failed' }],
      }),
    ]);
    await settle();
    const land = all('button').find((node) => node.textContent?.includes('Land task'));
    expect(land?.hasAttribute('disabled')).toBe(true);
  });
});

describe('choosing which agent gets it', () => {
  /**
   * A MENU, anchored under the button that asked — not a modal.
   *
   * The verb acts on one row, so the surface points at that row; the thread you
   * are handing over stays legible behind it, which a scrim would destroy; and
   * two to four destinations do not need a search field.
   *
   * Radix owns the keyboard model (↑↓, Enter, Esc, typeahead, one highlight
   * whether the pointer or the keyboard put it there), so what is asserted here
   * is what this code decides: that it asks at all, what each row SAYS, and that
   * the answer replays the original hand-off.
   */
  const CHOICES = [
    { session: 's-a', title: 'claude · sdk worktree', cwd: '/tasks/tabs/sdk', repo: 'sdk', role: 'workstream', mark: 'resting', means: 'sends now' },
    { session: 's-b', title: 'claude · task terminal', cwd: '/tasks/tabs', role: 'orchestrator', mark: 'working', means: 'queues' },
  ];

  /** Answers the first hand-off with a question and the second with success. */
  function drawAsking(choices: readonly unknown[] = CHOICES): void {
    let asked = false;
    const invoke = async (command: string, args?: unknown): Promise<Result<unknown, { code: string; message: string }>> => {
      calls.push({ command, args });
      if (command === 'github.prs') {
        return { ok: true, value: answer([pr({ checks: [{ name: 'typecheck', state: 'failed' }] })]) };
      }
      if (command === 'github.handToAgent' && !asked) {
        asked = true;
        return { ok: true, value: { ok: true, choose: choices } };
      }
      return { ok: true, value: { ok: true } };
    };
    act(() => {
      root.render(<ReviewPane state={{ task: 't-1' }} focused invoke={invoke} />);
    });
    act(() => {});
  }

  const hand = async (): Promise<void> => {
    const button = all('button').find((node) => node.textContent?.includes('Hand to agent'));
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
  };

  /** Radix portals the menu, so it is not under `host`. */
  const items = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.sh-ui-menu__item')];
  const labelsOf = (): (string | undefined)[] =>
    items().map((node) => node.querySelector('.sh-ui-menu__label')?.textContent ?? undefined);

  it('asks with a menu rather than picking, and names the agent kind', async () => {
    drawAsking();
    await settle();
    await hand();
    expect(labelsOf()).toContain('claude · sdk worktree');
  });

  it('says what handing to each one MEANS, which is the point of showing state', async () => {
    // An idle agent takes the prompt now and a mid-turn one takes it when the
    // turn ends. Finding that out by watching a pane not respond is what this
    // avoids — and both are fine, so neither is a warning.
    drawAsking();
    await settle();
    await hand();
    const metas = items().map((node) => node.querySelector('.sh-ui-menu__meta')?.textContent ?? '');
    expect(metas).toContain('sends now');
    expect(metas).toContain('queues');
  });

  it('offers the two destinations that are not an agent', async () => {
    drawAsking();
    await settle();
    await hand();
    expect(labelsOf()).toContain('New agent on this branch');
    expect(labelsOf()).toContain('Copy as prompt');
  });

  it('is NOT reported as a failure — nothing went wrong', async () => {
    drawAsking();
    await settle();
    await hand();
    expect(host.querySelector('.sh-review__problem')).toBeNull();
  });

  it('sends the SAME hand-off back, plus the answer', async () => {
    // The args are replayed verbatim: between asking and answering a sync can
    // land and change which check is first, and re-deriving them would hand over
    // a different thing from the one the question was about.
    drawAsking();
    await settle();
    await hand();
    const asked = calls.filter((call) => call.command === 'github.handToAgent').at(-1)?.args;

    const row = items().find((node) => node.textContent?.includes('sdk worktree'));
    await act(async () => {
      row?.click();
      await Promise.resolve();
    });

    const answered = calls.filter((call) => call.command === 'github.handToAgent').at(-1)?.args;
    expect(answered).toEqual({ ...(asked as object), session: 's-a' });
  });

  it('asks for a spawn by naming no live session, which is what the command already does', async () => {
    drawAsking();
    await settle();
    await hand();
    const row = items().find((node) => node.textContent?.includes('New agent'));
    await act(async () => {
      row?.click();
      await Promise.resolve();
    });
    expect(calls.filter((call) => call.command === 'github.handToAgent').at(-1)?.args).toMatchObject({ session: '' });
  });

  it('escalates past four destinations rather than growing a menu you scroll', async () => {
    const many = Array.from({ length: 6 }, (_, index) => ({ ...CHOICES[0], session: `s-${index}`, title: `claude · ${index}` }));
    drawAsking(many);
    await settle();
    await hand();
    expect(labelsOf().some((label) => label?.startsWith('More…'))).toBe(true);
    // Four agents plus More…, and never all six.
    expect(labelsOf().filter((label) => label?.startsWith('claude ·'))).toHaveLength(4);
  });
});

describe('the PR as one document (11)', () => {
  /**
   * The four tabs are gone.
   *
   * They were the right answer while the panes competed for one rectangle, and
   * the wrong one for a pull request: what it says, what was said about it, what
   * ran and what changed are read TOGETHER. Three quarters of it one click away
   * is three quarters nobody looks at — which is what the counts on the tabs
   * were papering over. The two things that still take the pane are the two
   * diffs, because a patch is a place you go rather than a section you scroll.
   */
  const rich = (over: Record<string, unknown> = {}): Record<string, unknown> =>
    pr({
      body: 'Adds TabMark and the row shape the strip needs.',
      checks: [
        { name: 'lint', state: 'passed', durationMs: 12_000 },
        { name: 'typecheck', state: 'failed', durationMs: 38_000, log: 'error TS2322: not assignable' },
      ],
      commits: [
        { sha: 'e91c2a4aaa', subject: 'Widen TabMark', author: 'claude', at: 0 },
        { sha: '77b0d13bbb', subject: 'Tab rows in the sdk', author: 'claude', at: 0 },
      ],
      reviewers: [{ login: 'jane', verdict: 'approved', comments: 0 }],
      threads: [{ id: 'T1', author: 'sam', path: 'src/tree.ts', line: 61, resolved: false, body: 'use the token' }],
      files: [{ path: 'src/tree.ts', added: 22, removed: 1, patch: '@@ -58,4 +58,11 @@\n context\n+added\n-gone' }],
      ...over,
    });

  const headings = (): string[] => all('.sh-ui-section-label__text').map((node) => node.textContent ?? '');
  const openFiles = (): void => {
    act(() => all('.sh-pr-line').find((node) => node.textContent?.includes('src/tree.ts'))?.click());
  };
  const openCommit = (): void => {
    act(() => all('.sh-pr-line').find((node) => node.textContent?.includes('Widen TabMark'))?.click());
  };

  it('puts every section in ONE scroll, with no tab row at all', async () => {
    draw([rich()]);
    await settle();
    expect(all('.sh-pr-head__tab')).toHaveLength(0);
    /*
     * The order is the READER's. The verdict at the top says whether this can
     * land; when it cannot, the detail of the blocker is what is wanted next —
     * so the checks and the conversation lead, and the description, which is
     * the agent's account of its own work, closes.
     */
    expect(headings()).toEqual(['Description', 'Checks', 'Conversation', 'Files', 'Commits']);
    // The description is a section like the rest. Without a heading its first
    // paragraph began directly under the brief's buttons and read as a caption
    // on them. It is still CLAMPED, which is what stops a hundred-line body
    // deciding where the files sit.
    expect(host.querySelector('.sh-pr-clamp .sh-pr-body')).not.toBeNull();
  });

  it('shows the description and the checks together, which two tabs could not', async () => {
    // The point of the change, asserted as one claim: the body and the failing
    // check are on screen at the same time without anybody clicking anything.
    draw([rich()]);
    await settle();
    expect(host.textContent).toContain('Adds TabMark and the row shape the strip needs.');
    expect(host.textContent).toContain('typecheck');
  });

  it('gives each author their own colour, and the same one every time', async () => {
    /*
     * The marks were one flat grey square, so three people saying three things
     * looked like one person saying them three times.
     *
     * Derived from the login rather than random: an identity mark whose colour
     * changes per render is not an identity mark.
     */
    draw([rich({ comments: [
      { id: 'c1', author: 'coderabbitai', body: 'skipped', at: 1 },
      { id: 'c2', author: 'bsautomation', body: 'audit', at: 2 },
    ] })]);
    await settle();
    // Three marks, not two: the fixture's unresolved thread is somebody saying
    // something too, and it is tinted for the same reason.
    const tints = all('.sh-pr-said__mark').map((node) => node.style.background).filter((c) => c !== '');
    expect(tints).toHaveLength(3);
    expect(new Set(tints).size).toBe(3);
    expect(tints[0]).toMatch(/^oklch/);
  });

  it('draws the account\u2019s own picture over the square once it has loaded', async () => {
    /*
     * The ask this answers: coderabbitai has a logo, and a byline drawing a
     * coloured square beside its name is drawing the one thing about the comment
     * that GitHub already has a picture for.
     *
     * `data-face` is what the stylesheet shows on, and it is absent until the
     * load reports a width — so the square is what is on screen while the
     * request is out, and there is no frame where a half-loaded image is.
     */
    draw([rich({ comments: [
      { id: 'c1', author: 'coderabbitai', body: 'skipped', at: 1, avatar: 'https://avatars.githubusercontent.com/u/132028505?s=64&v=4' },
    ] })]);
    await settle();
    const face = one('.sh-pr-said__face') as HTMLImageElement;
    expect(face.getAttribute('src')).toBe('https://avatars.githubusercontent.com/u/132028505?s=64&v=4');
    expect(face.dataset['face']).toBeUndefined();

    loaded(face, 64);
    expect(face.dataset['face']).toBe('true');
  });

  it('keeps the square when GitHub answers with the identicon it drew', async () => {
    /*
     * An account with no picture gets one from GitHub, 420px wide whatever width
     * was asked for, and it is pale blocks on near-white. Drawing it would put
     * that tile in every byline on a dark pane and say nothing about who wrote
     * the comment, so the width is read back and the square stays.
     */
    draw([rich({ comments: [
      { id: 'c1', author: 'eshaanshah-bs', body: 'ship it', at: 1, avatar: 'https://avatars.githubusercontent.com/u/196956451?s=64&v=4' },
    ] })]);
    await settle();
    const face = one('.sh-pr-said__face') as HTMLImageElement;

    loaded(face, 420);
    expect(face.dataset['face']).toBeUndefined();
    expect(one('.sh-pr-said__mark').style.background).toMatch(/^oklch/);
  });

  it('keeps the square when the picture never arrives', async () => {
    // Offline, or a host that answered 404. Either way the byline is the one it
    // was before the avatar existed rather than a hole where a face would be.
    draw([rich({ comments: [
      { id: 'c1', author: 'coderabbitai', body: 'skipped', at: 1, avatar: 'https://avatars.githubusercontent.com/u/132028505?s=64&v=4' },
    ] })]);
    await settle();
    const face = one('.sh-pr-said__face') as HTMLImageElement;

    act(() => {
      face.dispatchEvent(new Event('error', { bubbles: false }));
    });
    expect(face.dataset['face']).toBeUndefined();
  });

  it('draws no picture at all for an author GitHub cannot name', async () => {
    // A deleted account carries no avatar key, so there is no `src` to request
    // and nothing to fail — the square is the whole byline.
    draw([rich({ comments: [{ id: 'c1', author: 'someone', body: 'orphaned', at: 1 }] })]);
    await settle();
    expect(all('.sh-pr-said__face')).toHaveLength(0);
  });

  it('counts a section on its own heading, past the rule', async () => {
    // SectionLabel puts the count at the far end so a column of headings has its
    // numbers in one place — and it is sentence case with no tracking, which is
    // the treatment §6 refuses the alternative to.
    draw([rich()]);
    await settle();
    const counts = all('.sh-ui-section-label__count').map((node) => node.textContent);
    expect(counts).toEqual(['1/2', '1', '12', '2']);
  });

  it('gives a queued check a mark, which is the state that used to draw nothing', async () => {
    /*
     * No rule in the checks list matched `queued` or `blocked`, so a required
     * status holding the merge got an empty 12px slot — the row was there and
     * said nothing, while the tab beside it counted every check as passed.
     *
     * The dashed ring is the picture of the state: the check is reserved and
     * nothing has reported into it. `passed` keeps its tick and every other
     * state stays a CSS shape on the slot.
     */
    draw([rich({ checks: [{ name: 'AI Harness / Audit Stack', state: 'queued' }] })]);
    await settle();
    const row = all('.sh-pr-check').find((node) => node.dataset['state'] === 'queued');
    expect(row?.querySelector('.sh-pr-line__mark svg')).not.toBeNull();
    // And the state is still readable without the colour, for a screen reader
    // and for anyone the hue does not reach.
    expect(row?.textContent).toContain('queued');
    // The right-hand words say what happened rather than leaving the cell empty,
    // which is what a duration did for a check that never started.
    expect(row?.textContent).toContain('has not reported');
  });

  it('says the direction of the change as an arrow, and the word for it too', async () => {
    // `tabs → main`, head to base. The sentence it replaced spent eleven words
    // on what the arrow says, and wrapped to two lines to do it — but the arrow
    // is a glyph, so the word travels beside it for anything not reading one.
    draw([rich()]);
    await settle();
    expect(all('.sh-pr-brief__ref').map((node) => node.textContent)).toEqual(['tabs', 'main']);
    expect(text('.sh-pr-brief__says')).toContain('into');
    expect(text('.sh-pr-brief__says')).toContain('2 commits');
  });

  it('opens the failing check by default, and nothing else', async () => {
    // A log is worth the room when it is the reason you came; three open logs
    // are the wall of text the two-column viewer existed to avoid.
    draw([rich()]);
    await settle();
    expect(all('.sh-pr-check__said')).toHaveLength(1);
    expect(text('.sh-pr-log')).toContain('error TS2322');
  });

  it('shows the failing check’s log, not a link to it', async () => {
    // The tab where an ADE beats the website: the fix is one keystroke from the
    // error rather than a copy-paste out of a browser.
    draw([rich()]);
    await settle();
    expect(text('.sh-pr-log')).toContain('error TS2322');
  });

  it('gives the description a heading of its own, so it cannot read as a caption', async () => {
    // Without one the body opened directly under the brief's buttons, and the
    // first paragraph read as a line belonging to them.
    draw([rich()]);
    await settle();
    const label = all('.sh-ui-section-label__text').find((node) => node.textContent === 'Description');
    expect(label).toBeDefined();
  });

  it('offers no hand-off on a check that has nothing to hand over', async () => {
    // A queued check has not failed, so there is nothing to send. It drew a
    // greyed button, which says only that you cannot press it.
    draw([rich({ checks: [{ name: 'audit', state: 'queued', log: 'waiting on the stack' }] })]);
    await settle();
    act(() => all('.sh-pr-line').find((node) => node.textContent?.includes('audit'))?.click());
    expect(text('.sh-pr-check__said')).toContain('waiting on the stack');
    expect(text('.sh-pr-check__verbs')).not.toContain('Hand to agent');
  });

  it('puts a commit’s subject in the crumb rather than beside its diff', async () => {
    // It was a bare paragraph inside the panel's ROW layout, so the subject
    // became a column of its own and wrapped down a gutter beside the files.
    draw([rich()]);
    await settle();
    openCommit();
    await settle();
    expect(text('.sh-pr-away__what')).toBe('Widen TabMark');
    expect(host.querySelector('.sh-pr-commit-head')).toBeNull();
  });

  it('keeps a commit’s diff on screen while the pane re-reads under it', async () => {
    /*
     * The pane re-reads every few seconds and hands down fresh callbacks. The
     * commit view's fetch effect depended on one, so every poll re-ran it — and
     * the effect clears `files` on the way in, so the whole diff dropped back to
     * `Fetching this commit's files…` twice a second. That is the flicker.
     */
    vi.useFakeTimers();
    try {
      draw([rich()]);
      await settle();
      openCommit();
      await settle();
      expect(calls.filter((call) => call.command === 'github.commitDiff')).toHaveLength(1);

      await act(async () => {
        vi.advanceTimersByTime(3_100);
        await Promise.resolve();
      });
      expect(calls.filter((call) => call.command === 'github.commitDiff')).toHaveLength(1);
      expect(host.textContent).not.toContain('Fetching this commit');
    } finally {
      vi.useRealTimers();
    }
  });

  it('lists commits newest first, with a short sha', async () => {
    draw([rich()]);
    await settle();
    expect(all('.sh-pr-line__sha').map((node) => node.textContent)).toEqual(['e91c2a4', '77b0d13']);
  });

  it('asks for the patches when the diff is opened, and not before', async () => {
    /*
     * The whole reason patches are a second request: a diff is the largest thing
     * about a PR and most people never open it. Fetching one per PR per poll
     * would make the sync loop the most expensive thing in the app — and it is
     * why the document lists PATHS and opens the patches on demand.
     */
    draw([rich()]);
    await settle();
    expect(calls.some((call) => call.command === 'github.diff')).toBe(false);

    openFiles();
    await settle();
    expect(calls.find((call) => call.command === 'github.diff')?.args).toMatchObject({
      task: 't-1',
      pr: 'shepherd/v2#301',
    });
    // ONCE. The effect holds its callback in a ref precisely so an inline arrow
    // from the parent cannot make it re-run every render — and the fetch it
    // fires causes a render, so that loop does not terminate.
    expect(calls.filter((call) => call.command === 'github.diff')).toHaveLength(1);
  });

  it('hands the diff to a real renderer rather than drawing lines itself', async () => {
    /*
     * `@pierre/diffs` owns the diff now: shiki highlighting, hunk expansion,
     * virtualisation, and line annotations. What is asserted here is the SEAM —
     * that the tab mounts it and gives it a file — because the rendering is the
     * library's to be right about and jsdom has no layout to check it with.
     */
    draw([rich()]);
    await settle();
    openFiles();
    await settle();
    expect(host.querySelector('.sh-pr-diff__view')).not.toBeNull();
  });

  it('draws the ONE block GitHub could not — which agent owns this branch', async () => {
    draw([rich()], { over: { agent: { title: 'claude · sdk', state: 'idle' }, taskTitle: 'Add multiple task tabs' } });
    await settle();
    // One dim line in the brief now, rather than a labelled block in a column of
    // its own — but it is still the block GitHub could not draw.
    expect(text('.sh-pr-brief__facts')).toContain('claude · sdk');
  });
});
