import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: '@shepherd/cli', include: ['src/**/*.test.ts'], environment: 'node' },
});
