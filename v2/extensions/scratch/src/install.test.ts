import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSkill } from './skill.ts';
import { installSkill } from './install.ts';
import { CLAUDE_CODE, skillFile, skillsDir } from './provider.ts';

let home: string;
let repo: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'shepherd-skill-home-'));
  repo = mkdtempSync(join(tmpdir(), 'shepherd-skill-repo-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

const doc = (name = 'deploy-checks'): string =>
  ['---', `name: ${name}`, 'description: Runs the pre-deploy suite.', '---', '', '# Deploy checks', '', 'Reads the manifest.'].join(
    '\n',
  );

/** `readSkill` is the only way to make one, so the tests go through it too. */
function skill(name?: string) {
  const read = readSkill(doc(name));
  if (read === undefined) throw new Error('fixture is not a skill');
  return read;
}

describe('skillsDir', () => {
  it('puts a claude-code skill under .claude/skills', () => {
    expect(skillsDir('/w/api', CLAUDE_CODE)).toBe(join('/w/api', '.claude', 'skills'));
  });
});

describe('skillFile', () => {
  it('writes the fences back around the frontmatter', () => {
    const file = skillFile(skill());
    expect(file.startsWith('---\nname: deploy-checks\n')).toBe(true);
    expect(file).toContain('\n---\n');
    expect(file).toContain('# Deploy checks');
  });

  it('ends with exactly one newline', () => {
    const file = skillFile(skill());
    expect(file.endsWith('\n')).toBe(true);
    expect(file.endsWith('\n\n')).toBe(false);
  });

  /*
   * The warning said "installs as deploy-checks", so the written file has to say
   * so too: Claude Code reads the name from the frontmatter and the directory is
   * named from the slug, and a file where those disagree is a broken skill.
   */
  it('normalises the name to the slug it installs under', () => {
    const file = skillFile(skill('Deploy_Checks'));
    expect(file).toContain('name: deploy-checks');
    expect(file).not.toContain('Deploy_Checks');
  });

  it('leaves an already-valid name untouched', () => {
    expect(skillFile(skill())).toContain('name: deploy-checks');
  });

  it('round-trips: what it writes reads back as the same skill', () => {
    const again = readSkill(skillFile(skill()));
    expect(again?.name).toBe('deploy-checks');
    expect(again?.description).toBe('Runs the pre-deploy suite.');
  });

  it('keeps a body-less skill valid', () => {
    const read = readSkill('---\nname: a\ndescription: B.\n---\n');
    if (read === undefined) throw new Error('fixture is not a skill');
    expect(skillFile(read)).toBe('---\nname: a\ndescription: B.\n---\n');
  });
});

describe('installSkill', () => {
  it('writes SKILL.md into a directory named for the skill', () => {
    const out = installSkill({ skill: skill(), dir: skillsDir(home, CLAUDE_CODE) });
    expect(out.ok).toBe(true);
    const path = join(home, '.claude', 'skills', 'deploy-checks', 'SKILL.md');
    expect(out.ok && out.path).toBe(path);
    expect(readFileSync(path, 'utf8')).toContain('name: deploy-checks');
  });

  it('creates every missing parent', () => {
    installSkill({ skill: skill(), dir: skillsDir(repo, CLAUDE_CODE) });
    expect(existsSync(join(repo, '.claude', 'skills', 'deploy-checks', 'SKILL.md'))).toBe(true);
  });

  it('uses the slug for the directory when the name is not one', () => {
    installSkill({ skill: skill('Deploy_Checks'), dir: skillsDir(home, CLAUDE_CODE) });
    expect(existsSync(join(home, '.claude', 'skills', 'deploy-checks', 'SKILL.md'))).toBe(true);
  });

  /*
   * The refusal that matters: somebody else's skill of the same name is work you
   * can destroy in one click, so the first answer is always no.
   */
  it('refuses a directory that already exists, and says it exists', () => {
    const dir = skillsDir(home, CLAUDE_CODE);
    mkdirSync(join(dir, 'deploy-checks'), { recursive: true });
    writeFileSync(join(dir, 'deploy-checks', 'SKILL.md'), 'mine\n');
    const out = installSkill({ skill: skill(), dir });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.exists).toBe(true);
    expect(readFileSync(join(dir, 'deploy-checks', 'SKILL.md'), 'utf8')).toBe('mine\n');
  });

  it('overwrites when asked, and only then', () => {
    const dir = skillsDir(home, CLAUDE_CODE);
    mkdirSync(join(dir, 'deploy-checks'), { recursive: true });
    writeFileSync(join(dir, 'deploy-checks', 'SKILL.md'), 'mine\n');
    const out = installSkill({ skill: skill(), dir, overwrite: true });
    expect(out.ok).toBe(true);
    expect(readFileSync(join(dir, 'deploy-checks', 'SKILL.md'), 'utf8')).toContain('name: deploy-checks');
  });

  /*
   * Overwriting replaces the FILE, not the directory: a skill folder carries
   * references, scripts and assets beside its SKILL.md, and removing the tree
   * would delete work the user never mentioned.
   */
  it('overwriting leaves the rest of the skill folder alone', () => {
    const dir = skillsDir(home, CLAUDE_CODE);
    mkdirSync(join(dir, 'deploy-checks', 'references'), { recursive: true });
    writeFileSync(join(dir, 'deploy-checks', 'references', 'notes.md'), 'keep me\n');
    installSkill({ skill: skill(), dir, overwrite: true });
    expect(readFileSync(join(dir, 'deploy-checks', 'references', 'notes.md'), 'utf8')).toBe('keep me\n');
  });

  it('refuses a name with nothing usable in it', () => {
    const read = readSkill('---\nname: "!!!"\ndescription: B.\n---\n');
    if (read === undefined) throw new Error('fixture is not a skill');
    const out = installSkill({ skill: read, dir: skillsDir(home, CLAUDE_CODE) });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.exists).toBeUndefined();
  });

  /*
   * A refusal, never a throw. Every caller here is a command handler, and this
   * codebase's convention is that a verb that failed answers with a reason —
   * `scratch.open` says so where it declines a `file://` link.
   */
  it('answers with a reason rather than throwing when the path is not a directory', () => {
    writeFileSync(join(home, 'wall'), 'x');
    const out = installSkill({ skill: skill(), dir: join(home, 'wall', '.claude', 'skills') });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason.length > 0).toBe(true);
  });
});
