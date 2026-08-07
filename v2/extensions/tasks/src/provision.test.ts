import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { materializeTaskRoot } from './provision.ts';
import { synthTaskRoot } from './model/root-synth.ts';

/**
 * The materializer — the half that touches disk, so the plan can stay pure.
 *
 * Everything asserted here traces to probe 1: per-entry symlinks (only they can
 * merge N repos into one namespace), agents aggregated as well as skills (a
 * nested repo's are NEVER loaded), and the root CLAUDE.md written because it is
 * the only one loaded at session start.
 */

let root: string;
let repoDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'shepherd-taskroot-'));
  repoDir = mkdtempSync(join(tmpdir(), 'shepherd-repo-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

function seedRepo(skills: string[] = [], agents: string[] = []): void {
  mkdirSync(join(repoDir, '.claude', 'skills'), { recursive: true });
  mkdirSync(join(repoDir, '.claude', 'agents'), { recursive: true });
  for (const skill of skills) {
    mkdirSync(join(repoDir, '.claude', 'skills', skill), { recursive: true });
    writeFileSync(join(repoDir, '.claude', 'skills', skill, 'SKILL.md'), `# ${skill}\n`);
  }
  for (const agent of agents) writeFileSync(join(repoDir, '.claude', 'agents', agent), `# ${agent}\n`);
}

const plan = (skills: string[] = [], agents: string[] = []) =>
  synthTaskRoot({
    title: 'Fix login',
    brief: 'Make it work.',
    repos: [{ name: 'api', path: repoDir, skills, agents, hasSettings: false }],
  });

describe('materializeTaskRoot', () => {
  it('writes the root CLAUDE.md — the only one loaded at session start', () => {
    materializeTaskRoot(root, plan());
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toContain('Make it work.');
  });

  it('links a skill per entry, and the link resolves to the repo’s real directory', () => {
    seedRepo(['deploy']);
    materializeTaskRoot(root, plan(['deploy']));
    const link = join(root, '.claude', 'skills', 'deploy');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(repoDir, '.claude', 'skills', 'deploy'));
    expect(readFileSync(join(link, 'SKILL.md'), 'utf8')).toContain('deploy');
  });

  it('links agents too', () => {
    seedRepo([], ['reviewer.md']);
    materializeTaskRoot(root, plan([], ['reviewer.md']));
    expect(existsSync(join(root, '.claude', 'agents', 'reviewer.md'))).toBe(true);
  });

  it('is idempotent — re-materializing an existing root does not throw', () => {
    seedRepo(['deploy']);
    materializeTaskRoot(root, plan(['deploy']));
    expect(() => materializeTaskRoot(root, plan(['deploy']))).not.toThrow();
  });

  it('replaces a link whose target moved, rather than leaving the old one', () => {
    // A REAL new location, deliberately: pointing at a nonexistent path would
    // test the missing-target rule below at the same time, and a test that
    // asserts two rules at once tells you nothing when it fails.
    seedRepo(['deploy']);
    const moved = mkdtempSync(join(tmpdir(), 'shepherd-repo-moved-'));
    mkdirSync(join(moved, '.claude', 'skills', 'deploy'), { recursive: true });
    try {
      materializeTaskRoot(root, plan(['deploy']));
      materializeTaskRoot(
        root,
        synthTaskRoot({
          title: 'Fix login',
          brief: 'b',
          repos: [{ name: 'api', path: moved, skills: ['deploy'], agents: [], hasSettings: false }],
        }),
      );
      expect(readlinkSync(join(root, '.claude', 'skills', 'deploy'))).toBe(
        join(moved, '.claude', 'skills', 'deploy'),
      );
    } finally {
      rmSync(moved, { recursive: true, force: true });
    }
  });

  it('refuses to create a DANGLING link, and says which', () => {
    // A symlink to nothing resolves to nothing and reports no error, so the
    // skill silently stops existing — which is the same silent-failure shape the
    // collision rule exists to prevent, one layer along.
    const out = materializeTaskRoot(root, plan(['absent']));
    expect(existsSync(join(root, '.claude', 'skills', 'absent'))).toBe(false);
    expect(out.failed[0]).toContain('absent');
  });

  it('reports what it linked and what it could not', () => {
    seedRepo(['deploy']);
    const out = materializeTaskRoot(root, plan(['deploy', 'absent']));
    expect(out.linked).toBe(1);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0]).toContain('absent');
  });

  it('does NOT fail the whole task because one link could not be made', () => {
    // A missing skill is a degraded task, not a broken one. Refusing to create
    // the task would make one stale directory entry block the work.
    expect(() => materializeTaskRoot(root, plan(['absent']))).not.toThrow();
  });

  it('never writes a .claude ABOVE the task root', () => {
    // Probe 1: Claude walks UP from cwd for `.claude/` and CLAUDE.md, measured
    // from three levels. Anything this wrote above the root would leak into
    // every other task.
    materializeTaskRoot(root, plan());
    expect(existsSync(join(root, '..', '.claude'))).toBe(false);
    expect(existsSync(join(root, '..', 'CLAUDE.md'))).toBe(false);
  });
});
