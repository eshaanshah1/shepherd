import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@shepherd/ext-links',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
