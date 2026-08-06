import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@shepherd/app',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // node is the default because most of this package is main-process code;
    // the renderer's files opt into jsdom with a `// @vitest-environment jsdom`
    // docblock. One vitest project, two environments, no glob table to drift.
    environment: 'node',
  },
});
