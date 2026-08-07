import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@shepherd/ext-tasks',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
