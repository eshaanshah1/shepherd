import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@shepherd/sdk',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
