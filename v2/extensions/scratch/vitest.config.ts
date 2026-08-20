import { defineConfig } from 'vitest/config';

/**
 * Two projects, because the halves need different environments — and `src/`
 * must never need a DOM to pass, which is the property the process split buys.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: '@shepherd/ext-scratch:src',
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: '@shepherd/ext-scratch:ui',
          include: ['ui/**/*.test.ts', 'ui/**/*.test.tsx'],
          environment: 'jsdom',
        },
      },
    ],
  },
});
