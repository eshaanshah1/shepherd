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

/** Registered host-side; `diagnostics.ping` reads the host's facts through it. */
export const EXTENSIONS_LIST_COMMAND = 'extensions.list';

export const DIAGNOSTICS_COMMANDS = {
  ping: 'diagnostics.ping',
  probeDenied: 'diagnostics.probeDenied',
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
   * `storage` and nothing else, on purpose. `diagnostics.probeDenied` then
   * attempts a capability this list does not contain and reports the typed
   * refusal it gets — the permission model, proven by a built-in rather than
   * asserted in a comment.
   */
  permissions: ['storage'],
  contributes: {
    commands: [
      { id: DIAGNOSTICS_COMMANDS.ping, title: 'Diagnostics: Ping the Extension Host' },
      { id: DIAGNOSTICS_COMMANDS.probeDenied, title: 'Diagnostics: Probe an Undeclared Capability' },
    ],
  },
};
