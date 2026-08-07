import type { Manifest } from '@shepherd/sdk';

/**
 * The manifest, typed, so main can register this extension without importing its
 * code. `manifest.test.ts` asserts it matches `package.json`'s `shepherd` key.
 */
export const CLAUDE_CODE_ID = 'shepherd.claude-code';

/** The extension this one plugs into. Declared, not discovered (§7c). */
export const AGENTS_CORE_ID = 'shepherd.agents-core';

export const CLAUDE_COMMANDS = {
  resumeTarget: 'claudeCode.resumeTarget',
} as const;

export const claudeCodeManifest: Manifest = {
  id: CLAUDE_CODE_ID,
  name: 'Claude Code',
  version: '0.1.0',
  api: '^1.0.0',
  /**
   * `onStartup`, and it must be: the kind has to be registered before the first
   * hook arrives, and a hook arrives because somebody typed `claude` — which is
   * not an activation event. Waking on demand would leave the first turn of
   * every session untracked, which is the turn people watch.
   */
  activation: ['onStartup'],
  /**
   * **No `attention`, deliberately.** Agent state reaches the badge and the
   * notification centre only through `agents-core`, so the one authorizer in the
   * dispatcher refuses it here — the "only one writer" invariant is enforced
   * rather than remembered. A second writer would corrupt the ordering guard,
   * which depends on nothing else touching that state.
   *
   * `storage` is for the plugin-install record; `sessions` for reading the
   * inventory this kind's sessions live in.
   */
  permissions: ['sessions', 'storage'],
  dependencies: [AGENTS_CORE_ID],
  contributes: {
    commands: [{ id: CLAUDE_COMMANDS.resumeTarget, title: 'Claude Code: Show Resume Target' }],
  },
};
