import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@shepherd/app',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // node is the default because most of this package is main-process code;
    // the renderer's files opt into jsdom with a `// @vitest-environment jsdom`
    // docblock. One vitest project, two environments, no glob table to drift.
    environment: 'node',
    /*
     * Process CSS and inject it into jsdom, the way `@shepherd/ui` already does.
     *
     * Bought by a shipped defect: the composer's picker drew `border: … var(--sh
     * -line)` while sitting inside `.sh-ui-composer`, which re-declares
     * `--sh-line: transparent` for its whole subtree — so the popover had no edge
     * at all and could not be seen on the card. Nothing in TypeScript could have
     * caught it, and asserting the class name would have stayed true while the
     * rule behind it said nothing.
     */
    css: true,
  },
});
