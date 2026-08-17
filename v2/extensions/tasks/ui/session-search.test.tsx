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
  title: 'Recall in task search',
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

  it('draws the session title and the matched line', async () => {
    await draw({ query: 'recall', total: 5, hits: [hit()] });
    expect(text()).toContain('Recall in task search');
    expect(text()).toContain('i wanna add recall to shepherd');
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

  it('falls back to the short session id when there is no title', async () => {
    await draw({ query: 'recall', total: 1, hits: [hit({ title: undefined, total: 1 })] });
    // Six characters of the id, and never a pane — a pane does not survive a
    // restart and does not exist for an archived task.
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
