import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@shepherd/design-tokens',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
