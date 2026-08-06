import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@shepherd/platform-darwin',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
