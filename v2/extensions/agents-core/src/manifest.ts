import type { Manifest, SettingsPage } from '@shepherd/sdk';

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
  /** What this agent last said, for a surface that wants to show it. */
  lastSaid: 'agents.lastSaid',
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
  /**
   * Ask the quick tier something — §7c's `complete`, and the whole of the
   * headless seam this build ships.
   *
   * A COMMAND rather than a method on the API this extension exports, and that
   * is about enforcement: `CommandSpec.permission` is checked by `authorize()`
   * in the dispatcher before any handler runs, while an object handed over by
   * `extensions.get` has nothing in between. As a method, the `agents`
   * permission — declared in the vocabulary since M1 for exactly this — would be
   * decorative, and this extension would have to re-implement the authorizer to
   * find out who was calling.
   */
  complete: 'agents.complete',
  /** Read, set or clear which kind and model serve the quick tier. */
  quickModel: 'agents.quickModel',
  /**
   * What the settings screen may offer for the two quick-tier rows.
   *
   * A command rather than a static list, because the answer is whatever registered
   * into the point and what each kind advertises — both of which change without a
   * release of this extension. `SettingSpec.choicesFrom` names it, and the screen
   * asks it when that page is opened, which is what keeps activation lazy.
   */
  quickChoices: 'agents.quickModelChoices',
  /**
   * **Every model every agent kind will run** — the primitive.
   *
   * Distinct from `quickChoices`, which is this narrowed to the cheap tier. A
   * consumer that wants "what can I pick for a task" asks this; one that wants
   * "what may answer a background question" asks that. They were the same list
   * once and it made the composer offer a menu of models chosen for being cheap.
   */
  listModels: 'agents.listModels',
  /**
   * Which model a NEW interactive agent opens on — resolved, never null.
   *
   * `listModels` says what exists; this says which you get without choosing. A
   * surface reading the raw setting would have to render "unset" as an option,
   * and "unset" is not a model — it is this extension's question to answer.
   */
  defaultModel: 'agents.defaultModel',
} as const;

/**
 * The user's quick-tier choice as it was stored BEFORE settings existed — kept
 * only so it can be migrated.
 *
 * The comment here used to promise that "when a settings system lands this becomes
 * a row in it and no consumer changes". It landed (spec 2026-08-11), and this key
 * is now read exactly once per install, by `migrateQuickOverride`.
 */
export const QUICK_MODEL_KEY = 'quick-model';

/** Which agent kind serves the quick tier. Null = the first capable one. */
export const QUICK_KIND_SETTING = 'agents-core.quickKind';
/** Which of that kind's models. Null = the kind's own advertised default. */
export const QUICK_MODEL_SETTING = 'agents-core.quickModel';

/**
 * Which model a new interactive agent opens on. Null = the kind's own default.
 *
 * Stored nullable and read resolved (`agents.defaultModel`): a concrete id here
 * would name a vendor's model and freeze today's answer into every install.
 */
export const DEFAULT_MODEL_SETTING = 'agents-core.defaultModel';

/**
 * The quick tier, as settings.
 *
 * Both enums resolve their options through a COMMAND rather than a static list,
 * and that is the rule rather than convenience: the kinds that can serve the quick
 * tier are whatever registered into the point, and their model ids belong to the
 * vendor. So the choices arrive as DATA from the vendor's own extension, and no
 * vendor is named here — the same reason this extension asks `agents.resumeTarget`
 * rather than `claudeCode.resumeTarget` (D11).
 *
 * Both are nullable, because "unset" is a meaning rather than a missing value:
 * whichever capable kind is first, and whatever that kind advertises. Only this
 * extension can compute either.
 */
export const AGENTS_MODELS_PAGE: SettingsPage = {
  id: 'agents.models',
  title: 'Models',
  description: 'Which model new agents open on, and which one answers the short questions the app asks on your behalf.',
  order: 100,
  settings: [
    {
      // First and in its own group: the two rows under it are about a tier
      // nobody interacts with.
      key: DEFAULT_MODEL_SETTING,
      type: 'enum',
      label: 'Default model',
      group: 'New agents',
      /*
       * "Default" survives on this row and nowhere else: a settings page is static
       * data (ADR 0040), so it cannot compute one, and a concrete id here would
       * name a vendor's model. Hence the description spelling out what it means.
       */
      description: 'What a new agent opens on. Default lets the agent choose, which is Opus for Claude Code. The composer starts here and can be changed per task.',
      default: null,
      nullable: true,
      choicesFrom: AGENTS_COMMANDS.listModels,
    },
    {
      key: QUICK_KIND_SETTING,
      type: 'enum',
      label: 'Quick-tier agent',
      group: 'Quick tier',
      description: 'Which agent answers short, non-interactive questions.',
      default: null,
      nullable: true,
      choicesFrom: AGENTS_COMMANDS.quickChoices,
    },
    {
      key: QUICK_MODEL_SETTING,
      type: 'enum',
      label: 'Quick-tier model',
      group: 'Quick tier',
      description: 'Left as Default, the chosen agent picks its own.',
      default: null,
      nullable: true,
      choicesFrom: AGENTS_COMMANDS.quickChoices,
    },
  ],
};

/** Kernel commands this extension invokes. Public vocabulary, like a CLI verb. */
export const SESSIONS_LIST_COMMAND = 'sessions.list';

/** Kernel topics it subscribes to. */
export const VIEWING_TOPIC = 'session.viewing';
export const SESSION_EXIT_TOPIC = 'session.exit';

/** A session's pane, announced once when it binds. Main publishes it. */
export const SESSION_BOUND_TOPIC = 'session.bound';

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
   *
   * `process.exec` is the headless seam's, and it is the heaviest grant in the
   * vocabulary (ADR 0038). The alternative — every kind spawning for itself — is
   * the failure §7c invoked to justify having a seam: they would each do the
   * deadline, the output cap and the child environment badly and differently.
   * Confined by three rules: the spawn lives in `complete.ts` alone, its argv
   * comes only from a registered kind, and a caller's influence stops at the
   * prompt text.
   */
  /**
   * `settings` is the quick tier's: `shepherd agent quick-model` writes the user's
   * choice, and a write is a command the one authorizer checks. Reading needs no
   * grant — the values arrive in the activation seed.
   */
  permissions: ['sessions', 'storage', 'attention', 'process.exec', 'settings'],
  contributes: {
    commands: [
      { id: AGENTS_COMMANDS.list, title: 'Agents: List Tracked Sessions' },
      { id: AGENTS_COMMANDS.resumeTarget, title: 'Agents: Resume Target' },
      { id: AGENTS_COMMANDS.lastSaid, title: 'Agents: Last Said' },
      { id: AGENTS_COMMANDS.resumeCommand, title: 'Agents: Resume Command' },
      { id: AGENTS_COMMANDS.complete, title: 'Agents: Ask the Quick Model' },
      { id: AGENTS_COMMANDS.quickModel, title: 'Agents: Quick Model' },
      // No title: they are verbs to be ASKED — by the settings screen and by the
      // composer — and a palette entry for one would run a command whose entire
      // effect is a return value.
      { id: AGENTS_COMMANDS.quickChoices },
      { id: AGENTS_COMMANDS.listModels },
      { id: AGENTS_COMMANDS.defaultModel },
    ],
    settings: [AGENTS_MODELS_PAGE],
  },
};
