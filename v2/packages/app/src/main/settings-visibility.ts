import { s, type Disposable } from '@shepherd/sdk';
import type { CommandRegistry } from '@shepherd/core';
import { SETTINGS_VISIBILITY_COMMAND } from '../shared/commands.ts';

/**
 * `window.settings` — the ONE writer of "is the settings screen up".
 *
 * Main owns it rather than the renderer, and that is what makes four gestures one
 * fact: the `Settings…` menu item (⌘,), the ⌘K palette entry, `shepherd raw
 * window.settings`, and Esc inside the screen. The page draws what it is told,
 * exactly as it draws the layout — a second copy of "what is on screen" is ADR
 * 0035's mistake, and this codebase has made it twice already.
 *
 * It also feeds `presence.overlay`, which is the reason it could not live in the
 * page at all: `ViewingResolver` composes app-active, focused root, zoom
 * starvation and full-takeover into ADR 0020's single predicate, and a takeover
 * only the renderer knew about would be a second visibility check.
 *
 * **Permission: `layout`.** `window.reload` took the same grant on the same
 * argument — it already means "this caller may arrange what is on your screen",
 * and covering the grid with a screen belongs to that rather than to a new
 * permission with one member.
 */
export { SETTINGS_VISIBILITY_COMMAND };

export interface SettingsVisibilityOptions {
  readonly registry: CommandRegistry;
  /** Called only on a real change, with the state that now holds. */
  readonly onChange: (open: boolean) => void;
}

export function registerSettingsVisibility(options: SettingsVisibilityOptions): Disposable {
  const { registry, onChange } = options;
  let open = false;

  return registry.register(SETTINGS_VISIBILITY_COMMAND, {
    title: 'Open Settings',
    permission: 'layout',
    // Absent `open` TOGGLES, because that is what a menu item and a keystroke
    // mean; a caller that wants a particular state says which.
    schema: s.object({ open: s.optional(s.boolean()) }),
    handler: (args) => {
      const next = args.open ?? !open;
      if (next !== open) {
        open = next;
        onChange(open);
      }
      // The state, so a caller does not have to keep its own copy — which is the
      // whole point of this command existing.
      return { open };
    },
  });
}
