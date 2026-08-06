import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@shepherd/core',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
