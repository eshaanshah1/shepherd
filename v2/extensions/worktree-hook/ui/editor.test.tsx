// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorktreeHookEditor } from './editor.tsx';
import { WORKTREE_HOOK_COMMANDS } from '../src/manifest.ts';

/**
 * The chip field, which is the half a smoke cannot see.
 *
 * A set hook's identity is its repos, so the two claims worth pinning are that
 * the field ACCUMULATES (⏎ adds one and stays, so several are several ⏎s) and
 * that saving sends the whole set rather than whatever is in the input.
 */

// React refuses to run `act` outside an act environment, and says so at the top
// of the first failure rather than where the problem is.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const answers = new Map<string, unknown>();
const invoke = vi.fn(async (command: string) => ({ ok: true as const, value: answers.get(command) }));

beforeEach(() => {
  answers.clear();
  answers.set(WORKTREE_HOOK_COMMANDS.get, { scope: 'global', script: '', repos: [], sets: [] });
  answers.set(WORKTREE_HOOK_COMMANDS.set, { scope: 'global', cleared: false });
  answers.set('tasks.suggestRepos', []);
  invoke.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/**
 * `done` is required by `ExtensionViewProps` and this editor never calls it —
 * saving a hook is not finishing with the form, which is exactly the distinction
 * the prop exists for. Supplied so the shape is real rather than cast away, and
 * recorded so a future save-and-close is a deliberate change.
 */
const done = vi.fn();

const render = async (): Promise<void> => {
  await act(async () => {
    root.render(<WorktreeHookEditor invoke={invoke as never} done={done} />);
  });
};

const byTestId = (id: string): HTMLElement => {
  const found = host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (found === null) throw new Error(`no [data-testid="${id}"]`);
  return found;
};

const type = async (input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> => {
  await act(async () => {
    // React tracks the DOM value it last wrote, so setting `.value` directly is
    // ignored as a no-change. The native setter is how a test writes one.
    const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const enter = async (input: HTMLInputElement): Promise<void> => {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
};

const pickedPaths = (): (string | undefined)[] =>
  [...byTestId('worktree-hook-set-picked').querySelectorAll('li')].map((li) => li.dataset.path);

describe('the set section', () => {
  it('turns each ⏎ into a chip and keeps the field open for the next one', async () => {
    await render();
    const field = byTestId('worktree-hook-set-path') as HTMLInputElement;

    await type(field, '~/dev/alpha');
    await enter(field);
    await type(field, '~/dev/beta');
    await enter(field);

    expect(pickedPaths()).toEqual(['~/dev/alpha', '~/dev/beta']);
    expect(field.value).toBe('');
  });

  it('does not add the same repo twice', async () => {
    await render();
    const field = byTestId('worktree-hook-set-path') as HTMLInputElement;
    await type(field, '~/dev/alpha');
    await enter(field);
    await type(field, '~/dev/alpha');
    await enter(field);

    expect(byTestId('worktree-hook-set-picked').querySelectorAll('li')).toHaveLength(1);
  });

  it('removes a chip', async () => {
    await render();
    const field = byTestId('worktree-hook-set-path') as HTMLInputElement;
    await type(field, '~/dev/alpha');
    await enter(field);

    await act(async () => {
      byTestId('worktree-hook-set-picked').querySelector('button')?.click();
    });
    expect(byTestId('worktree-hook-set-picked').querySelectorAll('li')).toHaveLength(0);
  });

  it('sends the whole set and the script, not the input', async () => {
    await render();
    const field = byTestId('worktree-hook-set-path') as HTMLInputElement;
    await type(field, '~/dev/alpha');
    await enter(field);
    await type(field, '~/dev/beta');
    await enter(field);
    await type(byTestId('worktree-hook-set-script') as HTMLTextAreaElement, 'ln -sf a b');

    await act(async () => {
      byTestId('worktree-hook-save-set').click();
    });

    expect(invoke).toHaveBeenCalledWith(WORKTREE_HOOK_COMMANDS.set, {
      repos: ['~/dev/alpha', '~/dev/beta'],
      script: 'ln -sf a b',
    });
  });

  it('cannot be saved with no repos', async () => {
    await render();
    expect((byTestId('worktree-hook-save-set') as HTMLButtonElement).disabled).toBe(true);
  });

  it('lists a stored set by its repo names and loads it back on click', async () => {
    answers.set(WORKTREE_HOOK_COMMANDS.get, {
      scope: 'global',
      script: '',
      repos: [],
      sets: [{ paths: ['/src/alpha', '/src/beta'], script: 'ln -sf a b' }],
    });
    await render();

    const row = byTestId('worktree-hook-set-row');
    expect(row.textContent).toContain('alpha + beta');

    await act(async () => {
      row.click();
    });
    expect(pickedPaths()).toEqual(['/src/alpha', '/src/beta']);
    expect((byTestId('worktree-hook-set-script') as HTMLTextAreaElement).value).toBe('ln -sf a b');
  });

  it('drops a malformed set rather than taking the overlay down', async () => {
    // A command's answer is `unknown`, and a cast is not a check.
    answers.set(WORKTREE_HOOK_COMMANDS.get, {
      scope: 'global',
      script: '',
      repos: [],
      sets: [{ paths: 'not an array', script: 'x' }, null, { paths: ['/src/alpha'], script: 'ok' }],
    });
    await render();

    expect(host.querySelectorAll('[data-testid="worktree-hook-set-row"]')).toHaveLength(1);
  });
});
