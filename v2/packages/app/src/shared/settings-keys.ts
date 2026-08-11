// The app's OWN setting keys — `shepherd.*`, the namespace no extension may write.
//
// In shared because both processes need them and neither owns them: main
// contributes the page they belong to (`settings-general.ts`), and the renderer
// reads the theme to paint with.
//
// **No runtime import, deliberately — not even `@shepherd/sdk`.** `preload/api.ts`
// imports this barrel, and the preload bundle is sandboxed: a *value* imported
// here (this file first spelled the prefix as `CORE_NAMESPACE`) makes the preload
// script fail to load with `module not found`, which takes the whole window with
// it and says nothing about settings. `menu-commands.ts` records the same trap
// from the other direction. `settings-keys.test.ts` pins the literal against
// `CORE_NAMESPACE`, so the string cannot drift from the constant it mirrors.

/** Dark, light, or follow the OS. Resolved by `resolveThemeMode` in the renderer. */
export const THEME_KEY = 'shepherd.theme';

export type ThemeSetting = 'system' | 'dark' | 'light';
