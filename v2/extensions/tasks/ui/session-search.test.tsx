// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionSearchView } from './session-search.tsx';

/**
 * What the overlay DRAWS, given what the extension answers.
 *
 * The rail's own tests can prove the search ran; only this can prove a hit
 * becomes a row you can read — which is the entire justification for the overlay
 * existing rather than the rail growing.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

const hit = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  dir: '/w/one',
  sessionId: 'a3f81c2b3c4d',
  title: 'Test session',
  task: 'Recall in task search',
  mark: 'working',
  when: Date.parse('2026-08-13T14:02:00.000Z'),
  total: 5,
  matches: [{ source: 'user', text: 'i wanna add recall to shepherd', at: [12, 18] }],
  ...over,
});

/** A `Modal` portals to the body, so queries go there rather than to `host`. */
const draw = async (value: unknown): Promise<ReturnType<typeof vi.fn>> => {
  const invoke = vi.fn().mockResolvedValue({ ok: true, value });
  await act(async () => {
    root.render(<SessionSearchView invoke={invoke} done={() => {}} />);
  });
  return invoke;
};

const field = (): HTMLInputElement | null =>
  document.querySelector<HTMLInputElement>('[data-testid="palette-input"]');
const rows = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[data-testid="palette-item"]'),
];
const text = (): string => document.body.textContent ?? '';

describe('the session-search overlay', () => {
  it('opens with the rail query already in the field, so nothing is retyped', async () => {
    await draw({ query: 'recall', total: 5, hits: [hit()] });
    expect(field()?.value).toBe('recall');
  });

  it('names the row after the TASK, not the session', async () => {
    // Three matches in one session would otherwise repeat the session's own
    // title three times and never say which piece of work it was.
    await draw({ query: 'recall', total: 5, hits: [hit()] });
    expect(text()).toContain('Recall in task search');
    expect(text()).not.toContain('Test session');
  });

  it('draws the matched line', async () => {
    await draw({ query: 'recall', total: 5, hits: [hit()] });
    expect(text()).toContain('i wanna add recall to shepherd');
  });

  it("draws the task's state mark, so the leading slot earns its indent", async () => {
    await draw({ query: 'recall', total: 5, hits: [hit()] });
    const mark = document.querySelector('.sh-ui-mark');
    expect(mark).toBeTruthy();
    expect(mark?.getAttribute('title') ?? mark?.getAttribute('aria-label')).toContain('Working');
  });

  it('names the session and when beside it', async () => {
    await draw({ query: 'recall', total: 5, hits: [hit()] });
    // Six characters of the session id — never a pane, which does not survive a
    // restart and does not exist for an archived task.
    expect(text()).toContain('a3f81c');
  });

  it('falls back to the session title when no task claims the hit', async () => {
    await draw({ query: 'recall', total: 1, hits: [hit({ task: undefined, total: 1 })] });
    expect(text()).toContain('Test session');
  });

  it('draws no mark when the state is not one the app knows', async () => {
    await draw({ query: 'recall', total: 1, hits: [hit({ mark: 'nonsense', total: 1 })] });
    expect(document.querySelector('.sh-ui-mark')).toBeNull();
  });

  it('paints the run the searcher marked', async () => {
    await draw({ query: 'recall', total: 5, hits: [hit()] });
    const painted = [...document.querySelectorAll('.sh-ui-palette__hit')].map((n) => n.textContent);
    expect(painted).toEqual(['recall']);
  });

  it('says how many more matches that session holds', async () => {
    await draw({ query: 'recall', total: 5, hits: [hit()] });
    expect(text()).toContain('4 more');
  });

  it('omits the more-count when every match is shown', async () => {
    await draw({ query: 'recall', total: 1, hits: [hit({ total: 1 })] });
    expect(text()).not.toContain('more');
  });

  it('falls back to the short id when neither task nor session is named', async () => {
    await draw({
      query: 'recall',
      total: 1,
      hits: [hit({ task: undefined, title: undefined, total: 1 })],
    });
    expect(text()).toContain('a3f81c');
  });

  it('draws one row per match, not one per session', async () => {
    const two = hit({
      total: 2,
      matches: [
        { source: 'user', text: 'first recall mention', at: [6, 12] },
        { source: 'assistant', text: 'second recall mention', at: [7, 13] },
      ],
    });
    await draw({ query: 'recall', total: 2, hits: [two] });
    expect(rows()).toHaveLength(2);
  });

  it('says so when nothing matched', async () => {
    await draw({ query: 'zzz', total: 0, hits: [] });
    expect(text()).toContain('No matching transcript');
  });

  it('survives a refused command instead of throwing', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: false, error: { code: 'nope', message: 'no' } });
    await act(async () => {
      root.render(<SessionSearchView invoke={invoke} done={() => {}} />);
    });
    expect(field()).toBeTruthy();
  });

  it('survives an answer of the wrong shape', async () => {
    await draw({ nonsense: true });
    expect(field()).toBeTruthy();
  });

  it('moves the rail when you type here, so one query serves both', async () => {
    const invoke = await draw({ query: 'recall', total: 5, hits: [hit()] });
    invoke.mockClear();

    await act(async () => {
      const input = field();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'narrower');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(invoke).toHaveBeenCalledWith('tasks.filter', { query: 'narrower' });
  });
});
