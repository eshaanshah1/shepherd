import { defineConfig } from 'vitest/config';

/**
 * One project, because there is one half. `scratch` needs two because its `ui/`
 * wants a DOM; nothing here does.
 */
export default defineConfig({
  test: {
    name: '@shepherd/ext-shell',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
