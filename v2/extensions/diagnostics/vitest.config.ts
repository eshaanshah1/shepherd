import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@shepherd/ext-diagnostics',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
