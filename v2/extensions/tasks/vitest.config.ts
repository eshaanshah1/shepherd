import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@shepherd/ext-tasks',
    // `ui/` is the other half of this package (ADR 0033) and it draws, so it is
    // tested too. node stays the default because the service half is the bulk of
    // it; the view opts into jsdom with a `// @vitest-environment jsdom`
    // docblock, which is the shape `packages/app` already uses — one project,
    // two environments, no glob table to drift.
    //
    // `ui/` matches BOTH extensions, because not everything in the view half
    // draws: `mention.ts` is the `#` rule as pure string work, and a `.tsx` it
    // never needed would have been the file extension lying to make a glob happy.
    // Collected silently by nothing is how a whole test file passes by not running.
    include: ['src/**/*.test.ts', 'ui/**/*.test.ts', 'ui/**/*.test.tsx'],
    environment: 'node',
  },
});
