import { skillSlug, type Skill } from './skill.ts';

/**
 * Where a skill goes, and what it looks like when it gets there.
 *
 * Split from `install.ts` for ONE reason and it is a hard one: this module is
 * imported by `ui/`, which runs in the renderer, and `install.ts` imports
 * `node:fs`. A path is a string and a file is a syscall — the boundary between
 * them is the boundary between the two halves of this extension.
 */

/**
 * A provider is the agent harness a skill is installed FOR, and today the only
 * thing it decides is the path fragment.
 *
 * Named as a value rather than left implicit because the command schema has to
 * accept it, and because the whole point of asking is that there will be a second
 * one. When there is, it is a row in this record and nothing else moves.
 */
export const CLAUDE_CODE = 'claude-code';

const PROVIDER_DIRS: Readonly<Record<string, readonly string[]>> = {
  [CLAUDE_CODE]: ['.claude', 'skills'],
};

/** What a provider is CALLED, for a checkbox beside it. */
export const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  [CLAUDE_CODE]: 'Claude Code',
};

export const providers = (): readonly string[] => Object.keys(PROVIDER_DIRS);

export function isProvider(value: string): boolean {
  return Object.hasOwn(PROVIDER_DIRS, value);
}

/**
 * Where a provider keeps its skills, under a user's home or a repo's root.
 *
 * `posix`-style joining by hand rather than `node:path`, so this file stays
 * importable by the renderer half. Every path it is given is already absolute and
 * already the platform's.
 */
export function skillsDir(root: string, provider: string): string {
  const parts = PROVIDER_DIRS[provider] ?? PROVIDER_DIRS[CLAUDE_CODE] ?? [];
  return [root.replace(/\/+$/, ''), ...parts].join('/');
}

/** The file this skill will be, at that target. What the dialog prints. */
export function skillPath(root: string, provider: string, name: string): string {
  return `${skillsDir(root, provider)}/${skillSlug(name)}/SKILL.md`;
}

/**
 * The file, as it lands on disk.
 *
 * **The `name` is normalised to the slug the directory uses.** Claude Code reads
 * a skill's name from its frontmatter and finds it by its directory, so a file
 * where those two disagree is a skill that half-works. `readSkill` has already
 * warned the user in exactly these words ("Installs as deploy-checks"), and this
 * is the half that keeps that promise.
 *
 * The rest of the document is written through untouched, comments and unknown
 * keys included: this is the user's file, not ours to tidy.
 */
export function skillFile(skill: Skill): string {
  const slug = skillSlug(skill.name);
  const frontmatter =
    slug === skill.name
      ? skill.frontmatter
      : skill.frontmatter.replace(/^(\s*name:\s*).*$/m, (_match, lead: string) => `${lead}${slug}`);
  const body = skill.body === '' ? '' : `\n${skill.body}\n`;
  return `---\n${frontmatter}\n---\n${body}`;
}
