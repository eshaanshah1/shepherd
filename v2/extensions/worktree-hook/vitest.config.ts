import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@shepherd/ext-worktree-hook',
    // `ui/` is the other half of this package (ADR 0033) and it draws, so it is
    // tested too. node stays the default because the service half is the bulk of
    // it; the view opts into jsdom with a `// @vitest-environment jsdom`
    // docblock, which is the shape `extensions/tasks` already uses — one project,
    // two environments, no glob table to drift.
    include: ['src/**/*.test.ts', 'ui/**/*.test.tsx'],
    environment: 'node',
  },
});
