import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@shepherd/ext-worktree-hook',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
