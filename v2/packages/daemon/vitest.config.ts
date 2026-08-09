import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@shepherd/daemon',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
