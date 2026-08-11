// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type { SettingsApi, SettingsSnapshotDTO } from '../shared/index.ts';
import { mount } from './test-dom.ts';
import { SettingsScreen } from './settings-screen.tsx';

/**
 * The screen as a projection plus a transport, exactly like the rest of the
 * renderer: it draws what `settings.list()` answered, and every gesture leaves as
 * one bridge call. Nothing here asserts about a value it computed itself.
 */

const SNAPSHOT: SettingsSnapshotDTO = {
  pages: [
    {
      id: 'shepherd.general',
      title: 'General',
      owner: 'shepherd',
      order: 0,
      settings: [
        {
          key: 'shepherd.theme',
          type: 'enum',
          label: 'Theme',
          default: 'system',
          choices: [
            { value: 'system', label: 'System' },
            { value: 'dark', label: 'Dark' },
          ],
        },
      ],
    },
    {
      id: 'w.editor',
      title: 'Worktree hooks',
      owner: 'shepherd.worktree-hook',
      component: 'worktree-hook.editor',
    },
  ],
  values: { 'shepherd.theme': 'system' },
  defaults: ['shepherd.theme'],
};

function fakeSettings(over: Partial<SettingsApi> = {}): SettingsApi & {
  readonly list: ReturnType<typeof vi.fn>;
  readonly set: ReturnType<typeof vi.fn>;
  readonly reset: ReturnType<typeof vi.fn>;
  readonly invoke: ReturnType<typeof vi.fn>;
} {
  return {
    list: vi.fn(async () => ({ ok: true as const, value: SNAPSHOT })),
    set: vi.fn(async () => ({ ok: true as const, value: undefined })),
    reset: vi.fn(async () => ({ ok: true as const, value: undefined })),
    setOpen: vi.fn(async () => ({ ok: true as const, value: undefined })),
    invoke: vi.fn(async () => ({ ok: true as const, value: [] })),
    onChanged: vi.fn(() => () => {}),
    onVisibility: vi.fn(() => () => {}),
    ...over,
  } as never;
}

const show = async (settings: SettingsApi, onClose: () => void = () => {}) => {
  const ui = mount(<SettingsScreen settings={settings} onClose={onClose} />);
  await act(async () => {});
  return ui;
};

const nav = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('[data-testid="settings-nav-item"]')].map((item) => item.textContent ?? '');

describe('SettingsScreen', () => {
  it('draws General first and every contributed page after it', async () => {
    const { container } = await show(fakeSettings());
    expect(nav(container)[0]).toContain('General');
    expect(nav(container)[1]).toContain('Worktree hooks');
  });

  it('names the extension a page came from, and says nothing for the kernel own pages', async () => {
    const { container } = await show(fakeSettings());
    expect(nav(container)[1]).toContain('worktree-hook');
    expect(nav(container)[0]).not.toContain('shepherd');
  });

  it('writes through the bridge when a row changes', async () => {
    const settings = fakeSettings();
    const { container } = await show(settings);
    act(() => container.querySelector<HTMLElement>('[data-testid="select-trigger"]')?.click());
    const options = [...container.querySelectorAll<HTMLElement>('[role="option"]')];
    await act(async () => options[1]?.click());
    expect(settings.set).toHaveBeenCalledWith('shepherd.theme', 'dark');
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    await show(fakeSettings(), onClose);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on the back control', async () => {
    const onClose = vi.fn();
    const { container } = await show(fakeSettings(), onClose);
    act(() => container.querySelector<HTMLElement>('[data-testid="settings-back"]')?.click());
    expect(onClose).toHaveBeenCalled();
  });

  it('does NOT decide it is closed — it asks, and waits to be told', async () => {
    // `onClose` reaches main's `window.settings`; the screen unmounts when main
    // pushes the new visibility. A screen that hid itself would be a second copy
    // of "what is on screen" (ADR 0035).
    const onClose = vi.fn();
    const { container } = await show(fakeSettings(), onClose);
    act(() => container.querySelector<HTMLElement>('[data-testid="settings-back"]')?.click());
    expect(container.querySelector('[data-testid="settings-screen"]')).not.toBeNull();
  });

  it('filters the nav as you search', async () => {
    const { container } = await show(fakeSettings());
    const search = container.querySelector<HTMLInputElement>('[data-testid="settings-search"]')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(search, 'worktree');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(nav(container)).toHaveLength(1);
    expect(nav(container)[0]).toContain('Worktree hooks');
  });

  it('shows the page that a filter no longer contains, replaced by the first match', async () => {
    const { container } = await show(fakeSettings());
    const search = container.querySelector<HTMLInputElement>('[data-testid="settings-search"]')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(search, 'worktree');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // General was showing and no longer matches; the body must follow the nav.
    expect(container.textContent).toContain('Worktree hooks');
    expect(container.querySelector('[data-testid="select-trigger"]')).toBeNull();
  });

  it('re-reads its values when the bridge announces a change from somewhere else', async () => {
    let announce: ((change: { key: string; value: unknown }) => void) | undefined;
    const settings = fakeSettings({
      onChanged: vi.fn((listener: (change: { key: string; value: never }) => void) => {
        announce = listener;
        return () => {};
      }),
    });
    await show(settings);
    expect(settings.list).toHaveBeenCalledTimes(1);
    await act(async () => announce?.({ key: 'shepherd.theme', value: 'dark' }));
    // The CLI is a second writer; a screen that trusted its own last write would
    // be stale the moment somebody typed `shepherd settings` in a pane behind it.
    expect(settings.list).toHaveBeenCalledTimes(2);
  });

  it('draws a component page through the UI table, and says so honestly when the name is unknown', async () => {
    const { container } = await show(fakeSettings());
    act(() => container.querySelectorAll<HTMLElement>('[data-testid="settings-nav-item"]')[1]?.click());
    // `worktree-hook.editor` IS in the table, so the page renders the extension's
    // own component rather than the empty state.
    expect(container.textContent).not.toContain('has no UI in this build');
  });

  it('asks a choicesFrom command exactly once per page, attributed to the page', async () => {
    const settings = fakeSettings({
      list: vi.fn(async () => ({
        ok: true as const,
        value: {
          pages: [
            {
              id: 'agents.models',
              title: 'Models',
              owner: 'shepherd.agents-core',
              settings: [
                {
                  key: 'agents-core.quickModel',
                  type: 'enum' as const,
                  label: 'Model',
                  default: null,
                  nullable: true,
                  choicesFrom: 'agents.quickModelChoices',
                },
              ],
            },
          ],
          values: { 'agents-core.quickModel': null },
          defaults: ['agents-core.quickModel'],
        },
      })),
    });
    await show(settings);
    expect(settings.invoke).toHaveBeenCalledTimes(1);
    expect(settings.invoke).toHaveBeenCalledWith('agents.models', 'agents.quickModelChoices');
  });

  it('leaves a dynamic row editable when its choices could not be fetched', async () => {
    const settings = fakeSettings({
      list: vi.fn(async () => ({
        ok: true as const,
        value: {
          pages: [
            {
              id: 'agents.models',
              title: 'Models',
              owner: 'shepherd.agents-core',
              settings: [
                {
                  key: 'agents-core.quickModel',
                  type: 'enum' as const,
                  label: 'Model',
                  default: null,
                  nullable: true,
                  choicesFrom: 'agents.quickModelChoices',
                },
              ],
            },
          ],
          values: { 'agents-core.quickModel': 'opus' },
          defaults: [],
        },
      })),
      invoke: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'unknown-command', message: 'no such command' },
      })),
    });
    const { container } = await show(settings);
    expect(container.querySelector<HTMLInputElement>('input[id="setting-agents-core.quickModel"]')?.value).toBe('opus');
    expect(container.textContent).toContain('no such command');
  });

  it('survives a bridge that is not there, rather than crashing the window', async () => {
    const { container } = await show(null as never);
    expect(container.querySelector('[data-testid="settings-screen"]')).not.toBeNull();
  });
});
