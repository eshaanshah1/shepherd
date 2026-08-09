import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@shepherd/remote',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
