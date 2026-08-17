import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@shepherd/ext-transcripts',
    // No `ui/**` glob, unlike every other extension: this one has no view half.
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
