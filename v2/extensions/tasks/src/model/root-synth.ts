/**
 * `TaskRootSynth` — what the task root should contain, as a value.
 *
 * The orchestrator runs at the task root with one worktree per repo beneath it,
 * and probe 1 measured what Claude Code does and does not find there
 * (`docs/superpowers/probes/2026-08-07-m3/`). Three results shape this file:
 *
 *   - **A nested repo's `.claude/agents` and `.claude/settings.json` are NEVER
 *     loaded.** Skills half-work — they load lazily, once the agent happens to
 *     touch that subtree — and agents and settings simply do not exist. That is
 *     what makes aggregation load-bearing rather than a nicety.
 *   - **A nested repo's `CLAUDE.md` is not loaded at startup either**, so the
 *     generated root file is the only place an orchestrator can learn what repos
 *     it has before it goes looking. The repo map is not decoration.
 *   - **A name collision resolves in the FILESYSTEM, silently, last-link-wins.**
 *     Two repos contributing `deploy` do not conflict in Claude Code; one symlink
 *     simply overwrites the other, and the agent then runs some other repo's
 *     deploy. Which is why conflicts are resolved deterministically here *and*
 *     reported.
 *
 * It emits a **plan and touches no disk** (D7), so every case above is
 * table-testable without a filesystem — and the paths it emits are relative to
 * the task root, so it never needs to know where that root is (D1b: an extension
 * cannot resolve a path anyway).
 */

export interface RepoContribution {
  /** The repo's name — also the namespace used to break a collision. */
  readonly name: string;
  /** Absolute path to this repo's worktree inside the task. */
  readonly path: string;
  /** Entry names under the repo's `.claude/skills/`. */
  readonly skills: readonly string[];
  /** File names under the repo's `.claude/agents/`, extension included. */
  readonly agents: readonly string[];
  /** Whether the repo has a `.claude/settings.json` of its own. */
  readonly hasSettings: boolean;
}

export interface SynthInput {
  /**
   * The prompt that opened the task, verbatim.
   *
   * There is no `title` beside it, and its absence is deliberate: the title at
   * provisioning time is the brief's own first line — the model's name for the
   * task lands seconds later and nothing rewrites this file — so an H1 built
   * from it was the brief's opening words printed twice.
   */
  readonly brief: string;
  /** The branch every worktree here is on. */
  readonly branch: string;
  readonly repos: readonly RepoContribution[];
}

export type LinkKind = 'skill' | 'agent';

export interface LinkPlan {
  readonly kind: LinkKind;
  /** Which repo this entry came from. */
  readonly repo: string;
  /** Where the link goes, **relative to the task root**. */
  readonly linkPath: string;
  /** What it points at — absolute, inside the repo's worktree. */
  readonly target: string;
}

export interface Conflict {
  readonly kind: LinkKind;
  readonly name: string;
  /** Every repo that contributed this name, in input order. */
  readonly repos: readonly string[];
  readonly resolution: 'namespaced';
}

export interface TaskRoot {
  /** The generated `CLAUDE.md`, which is the only one loaded at session start. */
  readonly claudeMd: string;
  readonly links: readonly LinkPlan[];
  readonly conflicts: readonly Conflict[];
  /** Things the user should be told; today, settings that cannot be aggregated. */
  readonly notices: readonly string[];
}

export function synthTaskRoot(input: SynthInput): TaskRoot {
  const skills = planKind('skill', input.repos, (repo) => repo.skills);
  const agents = planKind('agent', input.repos, (repo) => repo.agents);

  // Settings are deliberately NOT aggregated. Measured: a nested repo's
  // settings.json never loads, so the choice is between merging N of them into
  // one generated file and telling the user they do not apply. Merging is not a
  // symlink and not a detail — it would union permission grants across repos
  // (privilege one repo never asked for) and fire every repo's hooks in every
  // task. That is its own decision with its own consequences, and inventing it
  // silently here is how it would arrive unexamined. So: report, do not merge.
  const notices = input.repos
    .filter((repo) => repo.hasSettings)
    .map(
      (repo) =>
        `${repo.name} has its own .claude/settings.json, which does not apply at the task root ` +
        `(a nested repo's settings are never loaded). Its hooks and permissions will not run here.`,
    );

  return {
    claudeMd: renderClaudeMd(input),
    links: [...skills.links, ...agents.links],
    conflicts: [...skills.conflicts, ...agents.conflicts],
    notices,
  };
}

/**
 * One namespace's worth of aggregation.
 *
 * When a name is contributed by more than one repo, **every** contributor is
 * namespaced — not "first one keeps the bare name". A winner-takes-the-short-name
 * rule would make the resolution depend on repo order, so adding a repo would
 * silently rename another repo's skill out from under whatever referenced it.
 * Namespacing all of them is order-independent and reads honestly in a listing.
 */
function planKind(
  kind: LinkKind,
  repos: readonly RepoContribution[],
  entriesOf: (repo: RepoContribution) => readonly string[],
): { links: LinkPlan[]; conflicts: Conflict[] } {
  const dir = kind === 'skill' ? 'skills' : 'agents';

  const contributors = new Map<string, string[]>();
  for (const repo of repos) {
    for (const entry of entriesOf(repo)) {
      const list = contributors.get(entry) ?? [];
      if (!list.includes(repo.name)) list.push(repo.name);
      contributors.set(entry, list);
    }
  }

  const links: LinkPlan[] = [];
  const conflicts: Conflict[] = [];
  for (const repo of repos) {
    for (const entry of entriesOf(repo)) {
      const shared = (contributors.get(entry) ?? []).length > 1;
      links.push({
        kind,
        repo: repo.name,
        linkPath: `.claude/${dir}/${shared ? `${repo.name}-${entry}` : entry}`,
        target: `${repo.path}/.claude/${dir}/${entry}`,
      });
    }
  }
  for (const [name, list] of contributors) {
    if (list.length > 1) conflicts.push({ kind, name, repos: list, resolution: 'namespaced' });
  }

  return { links, conflicts };
}

/**
 * What an agent reads the moment a session opens at the task root — and, because
 * Claude walks UP from cwd, what a workstream agent down inside a repo worktree
 * reads too.
 *
 * It ORIENTS before it informs. An agent that has just booted does not yet know
 * that these directories are throwaway worktrees rather than the user's real
 * checkouts, and that is the one fact here that changes what it is safe to do:
 * commit, rewrite, install, leave dirty. The repo map and the branch used to be
 * stated with no such frame, so both read as trivia.
 *
 * The brief goes LAST and goes QUOTED. Last because it is the one section that
 * is not about the workspace, and the orchestrator was handed it as its first
 * message anyway — it is here for the agent that was spawned into a worktree
 * with a two-line prompt and has no other way to learn what the task is.
 * Quoted because a brief is somebody's chat message: it arrives with its own
 * headings, its own lists, and sometimes a paste of this very file, and dropped
 * in raw it becomes the document's structure instead of a quotation inside it.
 */
function renderClaudeMd(input: SynthInput): string {
  const lines = [
    '# Shepherd task workspace',
    '',
    'You are an agent working in an isolated workspace Shepherd built for one task.',
    'Each repo below is a **git worktree** — its own checkout of that repo, on a',
    'branch of its own, living in this directory. Nothing you do here reaches the',
    'checkout the user works in day to day, so commit, rewrite history, install',
    'dependencies or leave the tree dirty as the work needs.',
    '',
    'The other half of that: the paths below are the copies to edit. Changing the',
    'original checkout instead puts the work outside this task.',
    '',
    '## Repos',
    '',
  ];
  if (input.repos.length === 0) {
    lines.push('_None — this task has no repos._', '');
  } else {
    // A path per repo, because the agent has to cd into these and because a
    // nested CLAUDE.md only loads once it does.
    for (const repo of input.repos) lines.push(`- \`${repo.name}/\` — ${repo.path}`);
    lines.push(
      '',
      'Only this file is loaded when a session starts. A repo’s own `CLAUDE.md` stays',
      'unread until you open a file inside that repo, so read it before you change',
      'anything in there.',
      '',
    );
  }

  /*
   * Said only when there is something to say. Measured: a nested repo's agents
   * and settings are NEVER loaded from here, so these links are the only reason
   * a repo's skills work at the root — but a task whose repos ship neither gets
   * a sentence about an empty directory.
   */
  const contributed = input.repos.some((repo) => repo.skills.length > 0 || repo.agents.length > 0);
  if (contributed) {
    lines.push(
      'Skills and agents from these repos are linked into `.claude/` at this root, so',
      'they work from anywhere in the task.',
      '',
    );
  }

  lines.push(
    /*
     * Stated as an invitation and not as an apology. The agent working here is
     * the first party in a position to name this branch well, and the reason it
     * is named what it is is history it does not need in order to act.
     */
    '## Branch',
    '',
    `Every worktree here is on \`${input.branch}\` — one branch across all of them, so a`,
    'change spanning two repos carries the same name in both. Rename it to something',
    'that describes the work:',
    '',
    '    shepherd task rename-branch <name>',
    '',
  );

  lines.push(
    /*
     * **The rail reads the last line, so the last line has to be worth reading.**
     *
     * A task row's second line finishes the sentence its state mark starts —
     * ready → with what result, failed → why. The only place that sentence can
     * come from is the agent, and left alone an agent ends a turn with whatever
     * it happened to be saying: a sign-off, a question, half a list.
     *
     * Asked for as a rule about the LAST LINE rather than as a heading or a
     * marker, because this is read by a human in a terminal first and by the
     * rail second. `TL;DR:` in every response is a machine affordance showing
     * through; a closing sentence is how a person would end anyway.
     *
     * It is a session-start instruction — this file is written once and read
     * into the system prompt when the agent boots — so it WILL lapse on a long
     * session, and the reader is built for that: a last line that does not look
     * like a summary yields no summary rather than being shown as one.
     */
    '## Ending a turn',
    '',
    'End every response with one short sentence summarising what changed or what you',
    'need — a single line, no heading, no label. Shepherd shows that line on this',
    "task's row in the sidebar, so it is what someone scanning a dozen agents reads",
    'to decide whether you need them. Say the outcome, not the activity.',
    '',
  );

  const brief = quoteBrief(input.brief);
  if (brief.length > 0) {
    lines.push(
      '## What was asked for',
      '',
      'The prompt that opened this task, as it was typed:',
      '',
      ...brief,
      '',
    );
  }

  return lines.join('\n');
}

/**
 * The brief as a blockquote — every line prefixed, blank lines included.
 *
 * Prefixing the BLANK lines too is what keeps it one quotation rather than
 * several: an unprefixed blank line ends a blockquote, and the next paragraph of
 * somebody's prompt would resume as the document's own voice.
 *
 * Long runs of blank lines collapse, because a brief is typed into a composer
 * and arrives with the spacing of a chat message.
 */
function quoteBrief(brief: string): readonly string[] {
  const body = brief.replace(/\n{3,}/g, '\n\n').trim();
  if (body === '') return [];
  return body.split('\n').map((line) => (line.trim() === '' ? '>' : `> ${line}`));
}
