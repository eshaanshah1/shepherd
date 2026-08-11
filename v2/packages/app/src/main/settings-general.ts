import type { SettingsPage } from '@shepherd/sdk';
import { THEME_KEY, type ThemeSetting } from '../shared/settings-keys.ts';

/**
 * The key lives in `shared` — the renderer reads it to paint with, and a renderer
 * importing a main-process module for a string is one electron import away from a
 * broken bundle.
 */
export { THEME_KEY, type ThemeSetting };

/**
 * The app's own settings page, contributed by the kernel exactly the way an
 * extension contributes one — same registry, same validation, same wire shape.
 *
 * That sameness is the point rather than tidiness: the shell reads the theme
 * through the interface an extension reads its own keys through, so a bug on that
 * path is a bug in the app's own General page and cannot hide in a corner only
 * third parties visit. It is §7's built-ins-are-the-proving-ground rule applied
 * to the kernel itself.
 *
 * `system` is the default because the honest answer to "which theme" is the one
 * the user already gave their OS.
 */
export const GENERAL_PAGE: SettingsPage = {
  id: 'shepherd.general',
  title: 'General',
  description: 'How the app looks and behaves, everywhere.',
  // 0, so it is first in the nav. Every page that declared no `order` sorts at
  // Infinity behind it (`SettingsRegistry.pages`).
  order: 0,
  settings: [
    {
      key: THEME_KEY,
      type: 'enum',
      label: 'Theme',
      // The card's header band is `spec.group`. Named rather than left to the
      // page's own title, so the band says what the rows have in common — the
      // page already says which page it is, one line above.
      group: 'Appearance',
      description: 'Follow the system, or pin the app to one palette.',
      default: 'system',
      choices: [
        { value: 'system', label: 'System' },
        { value: 'dark', label: 'Dark' },
        { value: 'light', label: 'Light' },
      ],
    },
  ],
};
