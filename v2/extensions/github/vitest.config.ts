import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@shepherd/ext-github',
    // Both halves (ADR 0033). node stays the default because the service half is
    // the bulk of it; the views opt into jsdom with a `// @vitest-environment
    // jsdom` docblock — one project, two environments, no glob table to drift.
    include: ['src/**/*.test.ts', 'ui/**/*.test.ts', 'ui/**/*.test.tsx'],
    environment: 'node',
    // The browser APIs jsdom lacks and the view half needs to mount. Harmless
    // under `node`, where it finds them already absent and defines nothing a
    // service test can reach.
    setupFiles: ['./ui/jsdom-gaps.ts'],
  },
});
