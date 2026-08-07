import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@shepherd/ext-claude-code',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
