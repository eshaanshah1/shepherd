import { CORE_NAMESPACE, type SettingsPage } from '@shepherd/sdk';

/** The app's own theme choice. `shepherd.*` is readable by every extension. */
export const THEME_KEY = `${CORE_NAMESPACE}.theme`;

export type ThemeSetting = 'system' | 'dark' | 'light';

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
  // 0, so it is first in the nav. Every page that declared no `order` sorts at
  // Infinity behind it (`SettingsRegistry.pages`).
  order: 0,
  settings: [
    {
      key: THEME_KEY,
      type: 'enum',
      label: 'Theme',
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
