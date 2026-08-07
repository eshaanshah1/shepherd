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
  readonly title: string;
  readonly brief: string;
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

function renderClaudeMd(input: SynthInput): string {
  const lines = [
    `# ${input.title}`,
    '',
    input.brief,
    '',
    '## Repos',
    '',
  ];
  if (input.repos.length === 0) {
    lines.push('_None — this task has no repos._');
  } else {
    // A path per repo, because the agent has to cd into these and because a
    // nested CLAUDE.md only loads once it does.
    for (const repo of input.repos) lines.push(`- \`${repo.name}/\` — ${repo.path}`);
  }
  lines.push(
    '',
    'Each repo above is a git worktree on this task’s branch. A repo’s own',
    '`CLAUDE.md` loads when you first read a file inside it.',
    '',
  );
  return lines.join('\n');
}
