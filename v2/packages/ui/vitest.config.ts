import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@shepherd/ui',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Unlike the other packages, everything here draws. There is no node half to
    // keep the default for, so jsdom is the environment rather than a per-file
    // docblock opt-in.
    environment: 'jsdom',
    /*
     * Process CSS and inject it into jsdom, rather than stubbing it out.
     *
     * This is what makes the STYLESHEET testable and not only the markup, and
     * two of this package's load-bearing invariants live in CSS rather than in
     * TypeScript: `Row`'s height, which no state may change (rule 9), and
     * `Composer`'s scoped role re-declaration, which is the whole mechanism
     * spec §2 describes. Asserting those against a class name would be asserting
     * that a string is present — which stays true while the rule behind it is
     * deleted.
     *
     * Measured before relying on it: jsdom runs the cascade for rules in a
     * `<style>` element (so `getComputedStyle(el).height` reflects which rule
     * won) and preserves custom-property declarations unresolved (so
     * `getPropertyValue('--sh-surface')` inside a composer returns
     * `var(--sh-well)` rather than ''), and vite inlines the `@import` chain so
     * one import of `styles.css` brings every component's rules with it. It does NOT lay
     * anything out — every element is 0×0 — so a test may assert what a rule
     * SAYS and never what it renders.
     */
    css: true,
  },
});
