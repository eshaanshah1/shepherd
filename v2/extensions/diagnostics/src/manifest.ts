import type { Manifest } from '@shepherd/sdk';

/**
 * The manifest, typed, so main can register this extension without importing its
 * code (`@shepherd/ext-diagnostics/manifest`).
 *
 * It duplicates the `shepherd` key of `package.json`, which is the shape a
 * third-party extension is discovered by — and `manifest.test.ts` asserts the two
 * are identical rather than trusting anybody to keep them so. The reason for the
 * copy rather than a JSON import is small and boring: `resolveJsonModule` is off
 * across this repo, and turning it on for one built-in is a bigger change than a
 * test that cannot be forgotten.
 */
export const DIAGNOSTICS_ID = 'shepherd.diagnostics';

/**
 * Declared locally rather than imported, which is the convention `claude-code`
 * follows: values do not cross between extensions (`boundaries.js`), so a
 * dependency's id is re-stated here and only its TYPES are imported.
 */
export const AGENTS_CORE_ID = 'shepherd.agents-core';

/**
 * The offline quick model this extension registers in a dev build.
 *
 * Named here so the smoke can select it by id through `agents.quickModel`, rather
 * than a test hook existing inside production code.
 */
export const STUB_AGENT_KIND_ID = 'diagnostics.stub-agent';

/** Registered host-side; `diagnostics.ping` reads the host's facts through it. */
export const EXTENSIONS_LIST_COMMAND = 'extensions.list';

export const DIAGNOSTICS_COMMANDS = {
  ping: 'diagnostics.ping',
  probeDenied: 'diagnostics.probeDenied',
  /** Changes the contributed tree, so a row's click has something to prove. */
  bump: 'diagnostics.bump',
} as const;

export const diagnosticsManifest: Manifest = {
  id: DIAGNOSTICS_ID,
  name: 'Diagnostics',
  version: '0.1.0',
  api: '^1.0.0',
  /**
   * `onStartup`, which the plan says earns its keep rarely — this is one of the
   * cases. The whole value of this extension is answering "is the host alive?",
   * and an extension that had to be woken by the very command you are using to
   * check would answer that question about itself only.
   */
  activation: ['onStartup'],
  /**
   * `storage` plus `views` — the second added in M3, because this extension is
   * the trivial consumer P6's view mechanism was built against rather than the
   * task tree (building it against its real consumer would have shaped it around
   * one caller). `diagnostics.probeDenied` then
   * attempts a capability this list does not contain and reports the typed
   * refusal it gets — the permission model, proven by a built-in rather than
   * asserted in a comment.
   */
  permissions: ['storage', 'views'],
  /**
   * `agents-core`, for the stub quick model this registers in a dev build (see
   * `index.ts`). Declared because `extensions.get` resolves only ids a manifest
   * names — reaching another extension is declared, not discovered (§7c).
   */
  dependencies: [AGENTS_CORE_ID],
  contributes: {
    commands: [
      { id: DIAGNOSTICS_COMMANDS.ping, title: 'Diagnostics: Ping the Extension Host' },
      { id: DIAGNOSTICS_COMMANDS.probeDenied, title: 'Diagnostics: Probe an Undeclared Capability' },
      { id: DIAGNOSTICS_COMMANDS.bump, title: 'Diagnostics: Bump the Tree' },
    ],
  },
};
