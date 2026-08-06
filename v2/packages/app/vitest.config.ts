import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@shepherd/app',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
  },
});
