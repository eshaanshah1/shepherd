import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@shepherd/ui',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Unlike the other packages, everything here draws. There is no node half to
    // keep the default for, so jsdom is the environment rather than a per-file
    // docblock opt-in.
    environment: 'jsdom',
  },
});
