import type { Manifest } from '@shepherd/sdk';

/**
 * The manifest, typed, so main can register this extension without importing its
 * code. `manifest.test.ts` asserts it matches `package.json`'s `shepherd` key —
 * a built-in is held to the same validation as anybody else and must not be able
 * to drift from its own package.
 */
export const AGENTS_CORE_ID = 'shepherd.agents-core';

export const AGENTS_COMMANDS = {
  list: 'agents.list',
  /**
   * What `--resume` would reattach to for a session, asked of whichever kind
   * adopted it. The one verb a consumer needs in order to put an agent back,
   * and the reason it is here rather than on `claudeCode.*`: a task that asked a
   * vendor by name would be a task that knows which vendor it hired.
   */
  resumeTarget: 'agents.resumeTarget',
  /**
   * A stored resume target -> the command line that reattaches to it.
   *
   * Separate from `resumeTarget` because the two are asked at different times:
   * the target is captured while the session is LIVE (it comes out of the kind's
   * slot), and the command is needed later, when that session is long gone —
   * restoring an archived task, or a pane whose pty did not survive. So this one
   * takes the token back rather than a session id.
   *
   * It is what keeps `claude --resume` inside `claude-code` (ADR 0036 §3). A
   * consumer stores an opaque string and asks for a command; it never learns the
   * binary or the flag.
   */
  resumeCommand: 'agents.resumeCommand',
} as const;

/** Kernel commands this extension invokes. Public vocabulary, like a CLI verb. */
export const SESSIONS_LIST_COMMAND = 'sessions.list';

/** Kernel topics it subscribes to. */
export const VIEWING_TOPIC = 'session.viewing';
export const SESSION_EXIT_TOPIC = 'session.exit';

/** What it publishes, for the chrome and for other extensions. */
export const AGENT_STATE_TOPIC = 'agents.stateChanged';

export const agentsCoreManifest: Manifest = {
  id: AGENTS_CORE_ID,
  name: 'Agents',
  version: '0.1.0',
  api: '^1.0.0',
  /**
   * `onStartup`, which earns it rarely — this is one of the cases. It must be
   * subscribed before the first hook arrives, and a hook arrives because
   * somebody typed `claude`, which is not an event this extension could be woken
   * by. Waking on demand would mean the first turn of every session is the one
   * that goes untracked.
   */
  activation: ['onStartup'],
  /**
   * `attention` is here and **nowhere else in this repo**. Agent state reaches
   * the badge and the user's notification centre only through this extension, so
   * `claude-code` deliberately does not declare it: the one authorizer in the
   * dispatcher then enforces "agents-core is the only writer" rather than a code
   * review having to.
   *
   * `sessions` is for `sessions.list` — the inventory the sweep reads and the
   * seed the viewing mirror starts from.
   */
  permissions: ['sessions', 'storage', 'attention'],
  contributes: {
    commands: [
      { id: AGENTS_COMMANDS.list, title: 'Agents: List Tracked Sessions' },
      { id: AGENTS_COMMANDS.resumeTarget, title: 'Agents: Resume Target' },
      { id: AGENTS_COMMANDS.resumeCommand, title: 'Agents: Resume Command' },
    ],
  },
};
