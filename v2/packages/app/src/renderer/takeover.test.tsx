// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, type ReactElement } from 'react';
import type { TreeItem } from '@shepherd/sdk';
import type { ViewContributionDTO, ViewsApi } from '../shared/index.ts';
import { useTakeover, type TakeoverProps } from './takeover.tsx';
import { all, mount, one } from './test-dom.ts';

/**
 * The triage screen, as a projection.
 *
 * What these assert is the seam rather than the pixels: that Home is built from
 * the VIEW MECHANISM and not from a named extension, that the shell decides the
 * regions while the extension decides the facts, and that a click runs the
 * row's own verb through the one funnel — the three claims that make this a
 * takeover of the window rather than a second sidebar.
 */

interface Invocation {
  readonly command: string;
  readonly args: Readonly<Record<string, unknown>>;
}

const TREE: ViewContributionDTO = { extension: 'tasks', type: 'tasks.tree', kind: 'tree', title: 'Work' };

function bridge(rows: Readonly<Record<string, readonly TreeItem[]>>, views = [TREE]): ViewsApi {
  return {
    list: () => Promise.resolve({ ok: true, value: views }),
    children: (type) => Promise.resolve({ ok: true, value: rows[type] ?? [] }),
    activate: () => Promise.resolve({ ok: true, value: undefined }),
    invoke: () => Promise.resolve({ ok: true, value: undefined }),
    present: () => Promise.resolve({ ok: true, value: { shown: true } }),
    onChanged: () => () => {},
  };
}

/**
 * Type into a CONTROLLED input.
 *
 * Assigning `.value` and firing `input` is not enough: React tracks the last
 * value it wrote on the node and skips an event whose value it believes it
 * already has, so the keystroke lands in the DOM and never reaches `onChange`.
 * Going through the prototype's own setter clears that tracker, which is the
 * documented way to drive a controlled field without pulling in a user-event
 * library for one call.
 */
function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/**
 * A scroll, as the only thing the sentinel can see.
 *
 * jsdom has no `IntersectionObserver` at all, so the reveal sentinel would
 * simply never fire and a test asserting it does would pass for the wrong
 * reason. This stands one up and hands back the trigger, which is the gesture
 * under test: reaching the foot of a truncated region.
 */
function observing(): { reach: () => void; restore: () => void } {
  const callbacks: IntersectionObserverCallback[] = [];
  const had = (globalThis as Record<string, unknown>).IntersectionObserver;
  class Stub {
    constructor(callback: IntersectionObserverCallback) {
      callbacks.push(callback);
    }
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
    takeRecords(): [] {
      return [];
    }
  }
  (globalThis as Record<string, unknown>).IntersectionObserver = Stub;
  return {
    reach: () => {
      act(() => {
        for (const callback of [...callbacks]) {
          callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
        }
      });
    },
    restore: () => {
      (globalThis as Record<string, unknown>).IntersectionObserver = had;
    },
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * The window, in the shape `app.tsx` assembles it.
 *
 * The hook returns PARTS and the composition is the thing under test as much as
 * any of them — the band is chrome in the column, the face is content beside the
 * body, and Home is a layer. A host that rendered all three in one fragment
 * would assert the parts and miss the arrangement, which is exactly the fault
 * this shape was introduced to fix.
 *
 * `.sh-body` stands in for the rail and the stage: it is what has to keep its
 * room on the `agents` face and lose it to a document on every other one.
 */
function Host(props: TakeoverProps): ReactElement {
  const takeover = useTakeover(props);
  return (
    <div className="sh-app" data-takeover={takeover.place ?? undefined}>
      {takeover.band === null ? (
        <header className="sh-plate" data-testid="app-plate" />
      ) : (
        <div className="sh-take-band" data-testid="takeover-band" data-place={takeover.place}>
          {takeover.band}
        </div>
      )}
      <div className="sh-body" data-testid="app-body" data-idle={takeover.face === null ? undefined : 'true'} />
      {takeover.face}
      {takeover.home}
      {takeover.overlays}
    </div>
  );
}

function render(options: {
  rows?: Readonly<Record<string, readonly TreeItem[]>>;
  views?: readonly ViewContributionDTO[];
  groups?: Readonly<Record<string, string>>;
  faces?: readonly ViewContributionDTO[];
  /** What every verb refuses with, for the cases that assert a refusal is drawn. */
  refuse?: string;
}) {
  const calls: Invocation[] = [];
  const raised: string[] = [];
  const view = mount(
    <Host
      views={bridge(options.rows ?? {}, [...(options.views ?? [TREE])])}
      contributions={options.faces ?? []}
      groupOfRoot={(root) => options.groups?.[root] ?? root}
      invoke={(command, args) => {
        calls.push({ command, args });
        return Promise.resolve(options.refuse);
      }}
      onRaiseView={(type) => raised.push(type)}
    />,
  );
  return { view, calls, raised };
}

const task = (over: Partial<TreeItem> & { id: string }): TreeItem => ({
  label: over.id,
  root: `task:${over.id}`,
  command: { id: 'tasks.reveal', args: { task: over.id } },
  ...over,
});

describe('Home is built from the view mechanism', () => {
  it('draws a row for every tree’s rows, naming no extension', async () => {
    /*
     * TWO trees, and the takeover has heard of neither. `shell.tree` is the
     * loose terminals and `tasks.tree` is the work; both arrive through
     * `views.children` and both land on one screen — which is the whole reason
     * the shell reads the mechanism instead of asking `tasks` for a list.
     */
    const shellTree: ViewContributionDTO = {
      extension: 'shell',
      type: 'shell.tree',
      kind: 'tree',
      title: 'Scratchpad',
    };
    const { view } = render({
      views: [TREE, shellTree],
      groups: { 'window-1': 'window-1', 'task:relay': 'task:relay' },
      rows: {
        'tasks.tree': [task({ id: 'relay', label: 'Relay retry storm', tint: 'working' })],
        'shell.tree': [{ id: 'zsh', label: 'zsh', root: 'window-1' }],
      },
    });
    await settle();
    const groups = [...view.container.querySelectorAll('[data-group]')].map((el) =>
      el.getAttribute('data-group'),
    );
    expect(groups).toEqual(['running', 'shells']);
    view.unmount();
  });

  it('drops the dock’s own furniture — a heading and a `… +N` control', async () => {
    const { view } = render({
      rows: {
        'tasks.tree': [
          { id: 'head', label: 'Shipped', section: true },
          { id: 'more', label: '… +28', quiet: true },
          task({ id: 'relay', tint: 'working' }),
        ],
      },
    });
    await settle();
    // One row, and it is the task: the takeover supplies its own regions, so a
    // contributed heading here would be a heading inside a heading.
    expect(all(view.container, 'takeover-row')).toHaveLength(1);
    view.unmount();
  });

  it('keeps a `reveals` control as a sentinel, and scrolling to it loads the rest', async () => {
    /*
     * The bug this is written against: Home dropped every quiet row, including
     * the one holding the only verb that could lift the extension's own cap — so
     * `Shipped` drew eight rows and there was no gesture anywhere in the app
     * that reached the ninth.
     *
     * The control lands in the region of the row ABOVE it, and it is not drawn:
     * reaching the foot of a list is already the ask, so the screen answers.
     */
    const scroll = observing();
    const { view, calls } = render({
      rows: {
        'tasks.tree': [
          task({ id: 'relay', tint: 'working' }),
          task({ id: 'old', data: { mark: 'shipped' } }),
          {
            id: 'group:shipped:more',
            label: '20 more',
            quiet: true,
            reveals: true,
            command: { id: 'tasks.expandTabs', args: { task: 'group:shipped' } },
          },
        ],
      },
    });
    await settle();
    const sentinel = one(view.container, 'takeover-reveal');
    expect(sentinel.closest('[data-group]')?.getAttribute('data-group')).toBe('shipped');
    expect(calls).toHaveLength(0);

    scroll.reach();
    expect(calls).toEqual([{ command: 'tasks.expandTabs', args: { task: 'group:shipped' } }]);

    // ONCE. The verb is a toggle, so a second firing would fold the region back
    // up under the reader who had just reached it.
    scroll.reach();
    expect(calls).toHaveLength(1);
    scroll.restore();
    view.unmount();
  });

  it('windows a long region instead of letting it push the screen down', async () => {
    /*
     * `Shipped` is a record with no end. Drawn in full, 47 finished tasks push
     * every region that can still ask for you off a screen whose whole job is
     * answering "what needs me" — so the region keeps ten rows and scrolls
     * inside them.
     *
     * The window OWNS the tracks, which is why the section steps down to a
     * block: a scroll container cannot also be the grid its rows subgrid onto
     * and keep its heading still.
     */
    const scroll = observing();
    const many = Array.from({ length: 12 }, (_, i) =>
      task({ id: `s${i}`, data: { mark: 'shipped' } }),
    );
    const { view } = render({ rows: { 'tasks.tree': many } });
    await settle();
    const shipped = view.container.querySelector('[data-group="shipped"]');
    expect(shipped?.getAttribute('data-windowed')).toBe('true');
    expect(all(view.container, 'takeover-row')).toHaveLength(12);
    expect(shipped?.querySelector('.sh-take__window')?.childElementCount).toBe(12);
    scroll.restore();
    view.unmount();
  });

  it('leaves a short region and the loud one unwindowed', async () => {
    /*
     * A window costs a scroll to read what already fits, and `Needs you` may
     * never have one at any length: it is the region that costs you something to
     * ignore, and a question card is the one element allowed to change size.
     */
    const scroll = observing();
    const { view } = render({
      rows: {
        'tasks.tree': [
          ...Array.from({ length: 12 }, (_, i) => task({ id: `q${i}`, tint: 'blocked' })),
          task({ id: 'old', data: { mark: 'shipped' } }),
        ],
      },
    });
    await settle();
    expect(view.container.querySelector('[data-group="needs"]')?.getAttribute('data-windowed')).toBeNull();
    expect(view.container.querySelector('[data-group="shipped"]')?.getAttribute('data-windowed')).toBeNull();
    scroll.restore();
    view.unmount();
  });

  it('does not run a quiet control that only hides', async () => {
    /*
     * `Show fewer` is the same row pointing the other way, and it arrives
     * without `reveals`. Nothing may run it on sight — and it stays out of the
     * regions, because it is a control rather than a row.
     */
    const scroll = observing();
    const { view, calls } = render({
      rows: {
        'tasks.tree': [
          task({ id: 'old', data: { mark: 'shipped' } }),
          {
            id: 'group:shipped:more',
            label: 'Show fewer',
            quiet: true,
            command: { id: 'tasks.expandTabs', args: { task: 'group:shipped' } },
          },
        ],
      },
    });
    await settle();
    expect(all(view.container, 'takeover-reveal')).toHaveLength(0);
    scroll.reach();
    expect(calls).toHaveLength(0);
    scroll.restore();
    view.unmount();
  });

  it('files a row standing for a root in the HOME group under Shells', async () => {
    /*
     * Structural, not declared: a shell with an agent running in it arrives
     * tinted `working`, and believing the tint would put a loose terminal into
     * the queue. ADR 0047 put the shells in the home root's group, and that is a
     * fact about the layout — which is the shell's own.
     */
    const { view } = render({
      groups: { 'window-1': 'window-1' },
      rows: { 'tasks.tree': [{ id: 'zsh', label: 'zsh', root: 'window-1', tint: 'working' }] },
    });
    await settle();
    expect(view.container.querySelector('[data-group]')?.getAttribute('data-group')).toBe('shells');
    view.unmount();
  });
});

describe('the regions', () => {
  it('says the flock is quiet when nothing is asking for you', async () => {
    const { view } = render({ rows: { 'tasks.tree': [task({ id: 'relay', tint: 'working' })] } });
    await settle();
    expect(one(view.container, 'takeover-quiet').textContent).toContain('The flock is quiet.');
    // …and the work is still on the screen underneath it. Nothing NEEDING you
    // is not the same fact as nothing existing.
    expect(all(view.container, 'takeover-row')).toHaveLength(1);
    view.unmount();
  });

  it('drops the quiet sentence the moment something does need you', async () => {
    const { view } = render({ rows: { 'tasks.tree': [task({ id: 'relay', tint: 'blocked' })] } });
    await settle();
    expect(all(view.container, 'takeover-quiet')).toHaveLength(0);
    view.unmount();
  });

  it('counts as live everything that is neither shipped nor a shell', async () => {
    const { view } = render({
      groups: { 'window-1': 'window-1' },
      rows: {
        'tasks.tree': [
          task({ id: 'a', tint: 'working' }),
          task({ id: 'b', tint: 'archived' }),
          { id: 'zsh', label: 'zsh', root: 'window-1' },
        ],
      },
    });
    await settle();
    expect(view.container.textContent).toContain('1 live');
    view.unmount();
  });
});

describe('a question is a card', () => {
  const asking = task({
    id: 'ghsync',
    label: 'GitHub sync extension',
    tint: 'blocked',
    data: {
      mark: 'waiting',
      summary: 'Permission',
      elapsed: '14m',
      question: {
        text: 'Allow gh api graphql?',
        answers: [
          { label: 'Allow', command: 'tasks.answer', args: { yes: true }, key: 'Y' },
          { label: 'Deny', command: 'tasks.answer', args: { yes: false }, key: 'N' },
        ],
      },
    },
  });

  it('renders the question with its two verbs and their keys', async () => {
    const { view } = render({ rows: { 'tasks.tree': [asking] } });
    await settle();
    const card = one(view.container, 'takeover-card');
    expect(card.textContent).toContain('Allow gh api graphql?');
    expect(card.textContent).toContain('Y');
    expect(card.textContent).toContain('N');
    view.unmount();
  });

  it('answers through the row’s OWN verb, without opening the task', async () => {
    /*
     * The whole point of the card: the answer is two words and you already have
     * them. `tasks.reveal` firing here would be the interruption this screen
     * exists to remove.
     */
    const { view, calls } = render({ rows: { 'tasks.tree': [asking] } });
    await settle();
    const buttons = one(view.container, 'takeover-card').querySelectorAll('button');
    act(() => (buttons[0] as HTMLButtonElement).click());
    expect(calls).toEqual([{ command: 'tasks.answer', args: { yes: true } }]);
    view.unmount();
  });

  it('draws a plain row for a needs-you task with no question to ask', async () => {
    const { view } = render({ rows: { 'tasks.tree': [task({ id: 'save', tint: 'needs-check' })] } });
    await settle();
    expect(all(view.container, 'takeover-card')).toHaveLength(0);
    expect(all(view.container, 'takeover-row')).toHaveLength(1);
    view.unmount();
  });
});

describe('opening a row', () => {
  it('runs the row’s own command and leaves Home', async () => {
    const { view, calls } = render({ rows: { 'tasks.tree': [task({ id: 'relay', tint: 'working' })] } });
    await settle();
    act(() => (all(view.container, 'takeover-row')[0] as HTMLElement).click());
    expect(calls).toEqual([{ command: 'tasks.reveal', args: { task: 'relay' } }]);
    // Home is gone and the task's band is up: the window IS the task now.
    expect(all(view.container, 'takeover-home')).toHaveLength(0);
    expect(one(view.container, 'takeover-task').textContent).toContain('relay');
    view.unmount();
  });

  it('leaves the task when the row says its verb ends the screen', async () => {
    /*
     * Ship, from inside the thing being shipped. The verb runs and the window
     * goes back to the overview on the same press — the shelving is git and it
     * finishes behind the row's busy mark, with nobody watching a task have its
     * panes closed underneath them.
     *
     * `leaves` is the row's, not the shell's: nothing here knows what
     * `tasks.archive` does, only that the extension said this press ends the
     * screen.
     */
    const shippable = task({
      id: 'relay',
      tint: 'working',
      primaryAction: { id: 'tasks.archive', label: 'Ship', args: { task: 'relay' }, leaves: true },
    });
    const { view, calls } = render({ rows: { 'tasks.tree': [shippable] } });
    await settle();
    act(() => (all(view.container, 'takeover-row')[0] as HTMLElement).click());
    expect(all(view.container, 'takeover-task')).toHaveLength(1);

    act(() => one(view.container, 'takeover-primary').click());
    expect(calls.at(-1)).toEqual({ command: 'tasks.archive', args: { task: 'relay' } });
    expect(all(view.container, 'takeover-home')).toHaveLength(1);
    view.unmount();
  });

  it('stays put for a primary verb that does NOT end the screen', async () => {
    // The default, and it has to be: a row's one button is "the thing you do to
    // this most", which for anything but a lifecycle verb leaves you where you
    // were. Popping on every press would be the shell deciding what a verb means.
    const staying = task({
      id: 'relay',
      tint: 'working',
      primaryAction: { id: 'tasks.rerun', label: 'Rerun', args: { task: 'relay' } },
    });
    const { view, calls } = render({ rows: { 'tasks.tree': [staying] } });
    await settle();
    act(() => (all(view.container, 'takeover-row')[0] as HTMLElement).click());
    act(() => one(view.container, 'takeover-primary').click());
    expect(calls.at(-1)?.command).toBe('tasks.rerun');
    expect(all(view.container, 'takeover-task')).toHaveLength(1);
    expect(all(view.container, 'takeover-home')).toHaveLength(0);
    view.unmount();
  });

  it('raises the composer by NAME rather than importing it', async () => {
    const { view, raised } = render({ rows: {} });
    await settle();
    const button = [...view.container.querySelectorAll('button')].find((el) =>
      (el.textContent ?? '').startsWith('New'),
    );
    act(() => (button as HTMLButtonElement).click());
    expect(raised).toEqual(['tasks.composer']);
    view.unmount();
  });
});

describe('the router', () => {
  const press = (key: string, init: KeyboardEventInit = {}): void => {
    act(() =>
      void window.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
      ),
    );
  };

  const two = {
    'tasks.tree': [
      task({ id: 'relay', label: 'Relay retry storm', tint: 'blocked' }),
      task({ id: 'save', label: 'Save-conflict dialog', tint: 'needs-check' }),
      task({ id: 'ghsync', label: 'GitHub sync', tint: 'working' }),
    ],
  };

  it('walks the needs-you queue on J, skipping the one you are on', async () => {
    const { view, calls } = render({ rows: two });
    await settle();
    press('j');
    expect(calls.at(-1)).toEqual({ command: 'tasks.reveal', args: { task: 'relay' } });
    press('j');
    expect(calls.at(-1)).toEqual({ command: 'tasks.reveal', args: { task: 'save' } });
    view.unmount();
  });

  it('returns to Home on ⌘[, and clears the stack on H', async () => {
    const { view } = render({ rows: two });
    await settle();
    press('j');
    expect(all(view.container, 'takeover-task')).toHaveLength(1);
    /*
     * Escape is the terminal's, not the window's — vim leaves insert mode with
     * it and an agent interrupts its turn with it — so going back is `⌘[`, the
     * platform's own back. Asserted here because the pair is the whole rule.
     */
    press('Escape');
    expect(all(view.container, 'takeover-task')).toHaveLength(1);
    press('[', { metaKey: true });
    expect(all(view.container, 'takeover-home')).toHaveLength(1);

    press('j');
    press('h');
    expect(all(view.container, 'takeover-home')).toHaveLength(1);
    view.unmount();
  });

  it('never takes a letter out of a terminal', async () => {
    /*
     * The guard that makes a bare `j` safe at all. A focused xterm receives its
     * keystrokes through a real `<textarea>` — its helper element — so the same
     * check that keeps these keys out of a text field keeps them out of the
     * grid. Without it, `j` is a letter deleted from every terminal in the app.
     */
    const { view, calls } = render({ rows: two });
    await settle();
    const grid = document.createElement('textarea');
    document.body.append(grid);
    act(() =>
      void grid.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true }),
      ),
    );
    expect(calls).toHaveLength(0);
    expect(all(view.container, 'takeover-home')).toHaveLength(1);
    grid.remove();
    view.unmount();
  });

  it('answers the loud card from anywhere on Home, with the key the row published', async () => {
    const asking = task({
      id: 'ghsync',
      tint: 'blocked',
      data: {
        mark: 'waiting',
        question: {
          text: 'Allow?',
          answers: [
            { label: 'Allow', command: 'tasks.answer', args: { yes: true }, key: 'Y' },
            { label: 'Deny', command: 'tasks.answer', args: { yes: false }, key: 'N' },
          ],
        },
      },
    });
    const { view, calls, raised } = render({ rows: { 'tasks.tree': [asking] } });
    await settle();
    press('n');
    // `N` is the new-task key, and the question beats it: the printed `N` on a
    // Deny button that never fires is the prototype's own bug.
    expect(calls).toEqual([{ command: 'tasks.answer', args: { yes: false } }]);
    expect(raised).toEqual([]);
    view.unmount();
  });

  it('gives N back to the composer once nothing is asking', async () => {
    const { view, raised } = render({ rows: two });
    await settle();
    press('n');
    expect(raised).toEqual(['tasks.composer']);
    view.unmount();
  });
});

describe('⌘K jumps anywhere', () => {
  const press = (key: string, init: KeyboardEventInit = {}): void => {
    act(() =>
      void window.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
      ),
    );
  };

  it('opens on the three places before any task', async () => {
    const { view } = render({ rows: { 'tasks.tree': [task({ id: 'relay', tint: 'working' })] } });
    await settle();
    press('k', { metaKey: true });
    const rows = all(view.container, 'switcher-row').map((el) => el.textContent);
    expect(rows[0]).toContain('Overview');
    expect(rows[1]).toContain('New task');
    expect(rows[2]).toContain('Shells');
    expect(rows[3]).toContain('relay');
    // …and a task says the region it is in, so the switcher and Home agree.
    expect(rows[3]).toContain('running');
    view.unmount();
  });

  it('filters as you type and opens the hit on enter', async () => {
    const { view, calls } = render({
      rows: {
        'tasks.tree': [task({ id: 'relay', label: 'Relay retry storm', tint: 'working' })],
      },
    });
    await settle();
    press('k', { metaKey: true });
    const input = view.container.querySelector('input') as HTMLInputElement;
    type(input, 'relay');
    expect(all(view.container, 'switcher-row')).toHaveLength(1);
    act(() =>
      void input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      ),
    );
    expect(calls.at(-1)).toEqual({ command: 'tasks.reveal', args: { task: 'relay' } });
    view.unmount();
  });

  it('closes on ⌘K again and on esc, without leaving the place you were', async () => {
    const { view } = render({ rows: {} });
    await settle();
    press('k', { metaKey: true });
    expect(all(view.container, 'takeover-switcher')).toHaveLength(1);
    press('k', { metaKey: true });
    expect(all(view.container, 'takeover-switcher')).toHaveLength(0);

    press('k', { metaKey: true });
    press('Escape');
    expect(all(view.container, 'takeover-switcher')).toHaveLength(0);
    expect(all(view.container, 'takeover-home')).toHaveLength(1);
    view.unmount();
  });

  it('a jump is not a descent: ⌘[ after switching tasks lands on the overview', async () => {
    /*
     * The switcher is how you LEAVE a task, so the one you were in is not
     * behind the one you picked. Stacked, `⌘[` shuttled between the two with no
     * way out of either.
     */
    const { view } = render({
      rows: {
        'tasks.tree': [
          task({ id: 'relay', label: 'Relay retry storm', tint: 'working' }),
          task({ id: 'palette', label: 'Palette pass', tint: 'working' }),
        ],
      },
    });
    await settle();
    act(() => (all(view.container, 'takeover-row')[0] as HTMLElement).click());
    expect(one(view.container, 'takeover-task').textContent).toContain('Relay');

    press('k', { metaKey: true });
    const input = view.container.querySelector('input') as HTMLInputElement;
    type(input, 'palette');
    act(() =>
      void input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      ),
    );
    expect(one(view.container, 'takeover-task').textContent).toContain('Palette');

    press('[', { metaKey: true });
    expect(all(view.container, 'takeover-home')).toHaveLength(1);
    view.unmount();
  });

  it('says so rather than drawing an empty list', async () => {
    const { view } = render({ rows: {} });
    await settle();
    press('k', { metaKey: true });
    type(view.container.querySelector('input') as HTMLInputElement, 'zzzzz');
    expect(view.container.textContent).toContain('Nothing matches');
    view.unmount();
  });
});

describe('the faces of a task', () => {
  const press = (key: string, init: KeyboardEventInit = {}): void => {
    act(() =>
      void window.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
      ),
    );
  };

  const faceView = (type: string, slot: 'diff' | 'intent' | 'files', title: string): ViewContributionDTO => ({
    extension: type.split('.')[0] ?? 'x',
    type,
    kind: 'component',
    component: type,
    surface: 'face',
    face: { slot, subject: 'task' },
    title,
  });

  const ALL = [
    faceView('github.taskDiff', 'diff', 'Diff'),
    faceView('tasks.intent', 'intent', 'Intent'),
    faceView('editor.taskFiles', 'files', 'Files'),
  ];

  const working = { 'tasks.tree': [task({ id: 'relay', label: 'Relay', tint: 'working' })] };

  it('draws Agents plus one tab per claimed slot, in the spec’s order', async () => {
    const { view } = render({ rows: working, faces: ALL });
    await settle();
    act(() => (all(view.container, 'takeover-row')[0] as HTMLElement).click());
    expect(all(view.container, 'face-tab').map((el) => el.getAttribute('data-face'))).toEqual([
      'agents',
      'diff',
      'intent',
      'files',
    ]);
    view.unmount();
  });

  it('has no Diff tab in a build where nothing claims it', async () => {
    /*
     * The honest failure, and the whole argument for a claimed slot: the shell
     * never resolves `diff` to a view type whose name it knows, so a missing
     * extension is a missing tab rather than a tab that draws nothing.
     */
    const { view } = render({ rows: working, faces: [ALL[1] as ViewContributionDTO] });
    await settle();
    act(() => (all(view.container, 'takeover-row')[0] as HTMLElement).click());
    expect(all(view.container, 'face-tab').map((el) => el.getAttribute('data-face'))).toEqual([
      'agents',
      'intent',
    ]);
    view.unmount();
  });

  it('leaves the stage alone on Agents and covers it on every other face', async () => {
    /*
     * The Agents face IS the stage — the real panes, still mounted and still
     * attached to their ptys. So the layer draws only its band there and a body
     * everywhere else; a second `SplitView` over the same panes would steal each
     * terminal's element or spawn a second pty.
     */
    const { view } = render({ rows: working, faces: ALL });
    await settle();
    act(() => (all(view.container, 'takeover-row')[0] as HTMLElement).click());
    expect(all(view.container, 'takeover-face')).toHaveLength(0);

    press('3', { metaKey: true });
    const body = one(view.container, 'takeover-face');
    expect(body.getAttribute('data-face')).toBe('intent');
    view.unmount();
  });

  it('binds a POSITION, so ⌘2 is Intent when there is no Diff', async () => {
    const { view } = render({ rows: working, faces: [ALL[1] as ViewContributionDTO] });
    await settle();
    act(() => (all(view.container, 'takeover-row')[0] as HTMLElement).click());
    press('2', { metaKey: true });
    expect(one(view.container, 'takeover-face').getAttribute('data-face')).toBe('intent');
    view.unmount();
  });

  it('a row opens a face directly, without landing on Agents first', async () => {
    const { view } = render({ rows: working, faces: ALL });
    await settle();
    /*
     * The point of the shortcut: "show me the changes" is a thing you want from
     * Home, and making you enter the task and then press 2 is the step it
     * removes. A place has none of these — a loose shell has no diff to read.
     */
    const row = all(view.container, 'takeover-row')[0] as HTMLElement;
    const changes = row.querySelector('button[aria-label^="Diff"]') as HTMLElement | null;
    expect(changes).not.toBeNull();
    act(() => (changes as HTMLElement).click());
    expect(all(view.container, 'takeover-face')).toHaveLength(1);
    view.unmount();
  });

  it('takes a MODIFIER, because a bare digit on the Agents face is the pty’s', async () => {
    /*
     * Found by driving the real app: on `Agents` an xterm has the keyboard
     * almost always, and the takeover's own guard hands every bare key to the
     * focused text field — so a tab printing `1` advertised a key that did
     * nothing on the one face you are usually looking at.
     *
     * The tabs print `⌘1`–`⌘4` now, which is the rule this app already enforces
     * on every contributed accelerator (`hasModifier`) applied to its own
     * chrome. A bare digit must NOT switch face, or the fix is only cosmetic.
     */
    const { view } = render({ rows: working, faces: ALL });
    await settle();
    act(() => (all(view.container, 'takeover-row')[0] as HTMLElement).click());
    expect(all(view.container, 'face-tab').map((el) => el.textContent)).toEqual([
      'Agents⌘1',
      'Diff⌘2',
      'Intent⌘3',
      'Files⌘4',
    ]);
    press('3');
    expect(all(view.container, 'takeover-face')).toHaveLength(0);
    press('3', { metaKey: true });
    expect(one(view.container, 'takeover-face').getAttribute('data-face')).toBe('intent');
    view.unmount();
  });

  it('a face is not a place: ⌘[ leaves the task rather than going back to Agents', async () => {
    const { view } = render({ rows: working, faces: ALL });
    await settle();
    act(() => (all(view.container, 'takeover-row')[0] as HTMLElement).click());
    press('2', { metaKey: true });
    expect(all(view.container, 'takeover-face')).toHaveLength(1);
    press('[', { metaKey: true });
    expect(all(view.container, 'takeover-home')).toHaveLength(1);
    view.unmount();
  });

  it('opens a finished task on its Diff, and on Agents when nothing claims one', async () => {
    /*
     * `openingFace` finally doing its job. A task with no agent running and a
     * diff behind it is a ship decision, and the thing you have to look at to
     * make it is the diff — not a terminal with nothing in it.
     */
    const done = {
      'tasks.tree': [
        task({
          id: 'light',
          label: 'Light-mode palette pass',
          tint: 'idle',
          data: { mark: 'resting', diff: { added: 210, removed: 64, files: 9 } },
        }),
      ],
    };
    const withDiff = render({ rows: done, faces: ALL });
    await settle();
    act(() => (all(withDiff.view.container, 'takeover-row')[0] as HTMLElement).click());
    expect(one(withDiff.view.container, 'takeover-face').getAttribute('data-face')).toBe('diff');
    withDiff.view.unmount();

    // …and with no diff surface it lands on the agents rather than a blank tab.
    const without = render({ rows: done, faces: [] });
    await settle();
    act(() => (all(without.view.container, 'takeover-row')[0] as HTMLElement).click());
    expect(all(without.view.container, 'takeover-face')).toHaveLength(0);
    without.view.unmount();
  });

  it('says so rather than drawing an empty rectangle for a name it cannot resolve', async () => {
    const unknown = faceView('nobody.diff', 'diff', 'Diff');
    const { view } = render({ rows: working, faces: [unknown] });
    await settle();
    act(() => (all(view.container, 'takeover-row')[0] as HTMLElement).click());
    press('2', { metaKey: true });
    expect(one(view.container, 'face-missing').textContent).toContain('nobody.diff');
    view.unmount();
  });
});

describe('later', () => {
  const press = (key: string, init: KeyboardEventInit = {}): void => {
    act(() =>
      void window.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
      ),
    );
  };

  const LATER = {
    label: 'Later',
    options: [
      { label: 'Later today', command: 'tasks.snooze', args: { task: 'relay', until: 'today' }, key: '1' },
      { label: 'When agents finish', command: 'tasks.snooze', args: { task: 'relay', until: 'quiet' }, key: '2' },
      { label: 'Tomorrow', command: 'tasks.snooze', args: { task: 'relay', until: 'tomorrow' }, key: '3' },
      {
        label: 'Pick a time…',
        command: 'tasks.snooze',
        args: { task: 'relay' },
        key: '4',
        prompt: { field: 'until', placeholder: '4pm · friday · 2h' },
      },
    ],
  };

  const asking = task({
    id: 'relay',
    label: 'Relay retry storm',
    tint: 'blocked',
    data: {
      mark: 'waiting',
      question: {
        text: 'Approve?',
        answers: [
          { label: 'Approve', command: 'tasks.answer', args: { yes: true }, key: 'Y' },
          { label: 'Revise', command: 'tasks.answer', args: { yes: false }, key: 'N' },
        ],
      },
      later: LATER,
    },
  });

  it('offers three SHAPES of later, in the extension’s own words', async () => {
    const { view } = render({ rows: { 'tasks.tree': [asking] } });
    await settle();
    press('s');
    expect(all(view.container, 'later-option').map((el) => el.textContent)).toEqual([
      '1Later today',
      '2When agents finish',
      '3Tomorrow',
      '4Pick a time…',
    ]);
    view.unmount();
  });

  it('says out loud that nothing is lost', async () => {
    // The sentence the whole verb rests on. Without it, "not now" is
    // indistinguishable from "gone" and people stop pressing it.
    const { view } = render({ rows: { 'tasks.tree': [asking] } });
    await settle();
    press('s');
    expect(one(view.container, 'takeover-later-menu').textContent).toContain('never lost');
    view.unmount();
  });

  it('runs the verb the row published, and never one of its own', async () => {
    /*
     * The shell has no idea `tasks.snooze` exists. It draws the labels it was
     * handed and runs the command attached to the one you pressed — the same
     * contract a question's answers have.
     */
    const { view, calls } = render({ rows: { 'tasks.tree': [asking] } });
    await settle();
    press('s');
    act(() => (all(view.container, 'later-option')[1] as HTMLElement).dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    ));
    expect(calls.at(-1)).toEqual({ command: 'tasks.snooze', args: { task: 'relay', until: 'quiet' } });
    // The menu closes on the ANSWER, not on the press: a refusal has to be able
    // to keep it open, so the close waits for the verb to come back.
    await settle();
    expect(all(view.container, 'takeover-later-menu')).toHaveLength(0);
    view.unmount();
  });

  it('asks for a time instead of running, when the option carries a field', async () => {
    /*
     * The one option that is not a button. The three presets are the whens worth
     * a keypress; every other when has to be said, and rounding it to the
     * nearest preset puts the row back on Home at a moment nobody chose.
     */
    const { view, calls } = render({ rows: { 'tasks.tree': [asking] } });
    await settle();
    press('s');
    act(() => (all(view.container, 'later-option')[3] as HTMLElement).dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    ));
    // Nothing ran, and the options are gone: the card is the field now.
    expect(calls.filter((call) => call.command === 'tasks.snooze')).toHaveLength(0);
    expect(all(view.container, 'later-option')).toHaveLength(0);
    const field = one(view.container, 'later-field') as HTMLInputElement;
    expect(field.getAttribute('placeholder')).toBe('4pm · friday · 2h');
    view.unmount();
  });

  it('sends what was typed as the argument the option named, and nothing else', async () => {
    /*
     * The shell picks no key and reads no value. `prompt.field` is the extension
     * saying where its own verb wants the text — which is what keeps a text input
     * on this surface from being the shell learning what a snooze is.
     */
    const { view, calls } = render({ rows: { 'tasks.tree': [asking] } });
    await settle();
    press('s');
    act(() => (all(view.container, 'later-option')[3] as HTMLElement).dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    ));
    const field = one(view.container, 'later-field') as HTMLInputElement;
    act(() => type(field, 'friday 2pm'));
    act(() =>
      void field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
    );
    expect(calls.at(-1)).toEqual({
      command: 'tasks.snooze',
      args: { task: 'relay', until: 'friday 2pm' },
    });
    await settle();
    expect(all(view.container, 'takeover-later-menu')).toHaveLength(0);
    view.unmount();
  });

  it('keeps the field open on a refusal, wearing the reason it was refused', async () => {
    /*
     * A time nobody can read must not close the menu. Both outcomes take the row
     * off the screen, and only one of them says it did the wrong thing — so the
     * refusal is drawn beside the text that caused it, still editable.
     */
    const { view } = render({
      rows: { 'tasks.tree': [asking] },
      refuse: 'cannot read "next tuesdya" as a time',
    });
    await settle();
    press('s');
    act(() => (all(view.container, 'later-option')[3] as HTMLElement).dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    ));
    const field = one(view.container, 'later-field') as HTMLInputElement;
    act(() => type(field, 'next tuesdya'));
    act(() =>
      void field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
    );
    await settle();
    expect(all(view.container, 'takeover-later-menu')).toHaveLength(1);
    expect(one(view.container, 'later-error').textContent).toContain('next tuesdya');
    expect((one(view.container, 'later-field') as HTMLInputElement).value).toBe('next tuesdya');
    view.unmount();
  });

  it('has no Later at all for a row that publishes none', async () => {
    // Absent rather than present and inert: a button whose verb the extension
    // never published is a button that can only fail.
    const shipped = task({ id: 'ship1', label: 'Shipped thing', tint: 'archived' });
    const { view } = render({ rows: { 'tasks.tree': [shipped] } });
    await settle();
    press('s');
    expect(all(view.container, 'takeover-later-menu')).toHaveLength(0);
    view.unmount();
  });

  it('leaves the task you deferred, because staying is looking at what you deferred', async () => {
    const { view, calls } = render({ rows: { 'tasks.tree': [asking] } });
    await settle();
    act(() => one(view.container, 'takeover-card').click());
    expect(all(view.container, 'takeover-task')).toHaveLength(1);
    press('s');
    act(() => (all(view.container, 'later-option')[0] as HTMLElement).dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    ));
    expect(calls.at(-1)?.command).toBe('tasks.snooze');
    await settle();
    expect(all(view.container, 'takeover-home')).toHaveLength(1);
    view.unmount();
  });

  it('esc closes the menu without deferring anything', async () => {
    const { view, calls } = render({ rows: { 'tasks.tree': [asking] } });
    await settle();
    press('s');
    press('Escape');
    expect(all(view.container, 'takeover-later-menu')).toHaveLength(0);
    expect(calls.filter((call) => call.command === 'tasks.snooze')).toHaveLength(0);
    // …and it did not fall through to the nav stack either.
    expect(all(view.container, 'takeover-home')).toHaveLength(1);
    view.unmount();
  });

  it('files a snoozed row under Later, wearing its reason', async () => {
    const asleep = task({
      id: 'flake',
      label: 'Daemon replay flake',
      tint: 'blocked',
      data: { mark: 'waiting', snooze: { label: 'later today' } },
    });
    const { view } = render({ rows: { 'tasks.tree': [asleep] } });
    await settle();
    const group = view.container.querySelector('[data-group]');
    expect(group?.getAttribute('data-group')).toBe('later');
    expect(group?.textContent).toContain('until later today');
    view.unmount();
  });
});
