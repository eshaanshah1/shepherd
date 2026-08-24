import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { skillSlug, type Skill } from './skill.ts';
import { skillFile } from './provider.ts';

/**
 * Writing a skill to disk.
 *
 * `node:fs` directly, and no new permission for it: fs and path are stdlib and
 * allowed everywhere by `boundaries.js` — the OS-API deny-list is about reaching
 * the machine (`child_process`, `os`), not about reading a file. `tasks` writes
 * its task roots the same way.
 *
 * Everything here answers with a RESULT rather than throwing. The caller is a
 * command handler, and a verb that failed has to say why: a directory somebody
 * else owns, a path that is not writable, a name with nothing in it.
 */

export type InstallOutcome =
  | { readonly ok: true; readonly path: string }
  | {
      readonly ok: false;
      readonly reason: string;
      /**
       * Present only when the refusal is a skill that is already there, which is
       * the one refusal the caller can offer to get past. Absent — not `false` —
       * on every other, so a caller cannot accidentally offer to overwrite a
       * path that was never the problem.
       */
      readonly exists?: true;
    };

export interface InstallArgs {
  readonly skill: Skill;
  /** The provider's skills directory. `skillsDir` builds it. */
  readonly dir: string;
  readonly overwrite?: boolean;
}

/**
 * Writes `<dir>/<slug>/SKILL.md`.
 *
 * An existing directory refuses on the first attempt whatever is in it. That is
 * the one destructive thing this command can do, and a skill folder carries
 * references and scripts beside its `SKILL.md` — so overwrite replaces the FILE
 * and never the tree, and the refusal is what gets the user asked first.
 */
export function installSkill({ skill, dir, overwrite = false }: InstallArgs): InstallOutcome {
  const slug = skillSlug(skill.name);
  if (slug === '') {
    return { ok: false, reason: 'a skill needs a name with at least one letter or digit in it' };
  }

  const home = join(dir, slug);
  const file = join(home, 'SKILL.md');

  if (!overwrite && existsSync(home)) {
    return { ok: false, reason: `${slug} is already installed here`, exists: true };
  }

  try {
    mkdirSync(home, { recursive: true });
    // A directory where the file should be is not something `writeFileSync`
    // reports usefully, so it is checked rather than caught.
    if (existsSync(file) && statSync(file).isDirectory()) {
      return { ok: false, reason: 'SKILL.md is a directory here' };
    }
    writeFileSync(file, skillFile(skill), 'utf8');
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'could not write the skill' };
  }

  return { ok: true, path: file };
}
