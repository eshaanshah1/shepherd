import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeConfigFile, planTrust, seedClaudeTrust, trustKeys } from './trust.ts';

/**
 * The trust seeding, at the two levels it can be wrong: the shape of the record
 * (pure, and measured against Claude Code 2.1.226 — see `trust.ts`) and what
 * happens to somebody else's config file when things are not as expected.
 *
 * The second half is the one worth having. A wrong write into `~/.claude.json`
 * is worse than the prompt this feature exists to skip, so every degradation
 * asserts that the file came back UNCHANGED, not merely that the call returned.
 */

const home = (): string => mkdtempSync(join(tmpdir(), 'shepherd-trust-'));

describe('planTrust', () => {
  it('writes the record Claude Code reads: hasTrustDialogAccepted === true', () => {
    const plan = planTrust({}, ['/tasks/fix-login']);
    expect(plan.config).toEqual({ projects: { '/tasks/fix-login': { hasTrustDialogAccepted: true } } });
    expect(plan.added).toEqual(['/tasks/fix-login']);
  });

  it('trusts exactly the keys it was given and nothing else', () => {
    // The whole claim of this feature's narrowness: no blanket flag anywhere in
    // the output, and no key nobody asked for.
    const plan = planTrust({ projects: { '/somebody/repo': { hasTrustDialogAccepted: false } } }, ['/tasks/t']);
    const projects = plan.config['projects'] as Record<string, unknown>;
    expect(Object.keys(projects).sort()).toEqual(['/somebody/repo', '/tasks/t']);
    expect(projects['/somebody/repo']).toEqual({ hasTrustDialogAccepted: false });
  });

  it('MERGES into an existing entry rather than replacing it', () => {
    // An entry carries allowedTools, MCP server lists and onboarding flags, and
    // a task root re-provisioned by a restore must not lose them.
    const plan = planTrust(
      { projects: { '/tasks/t': { allowedTools: ['Bash'], projectOnboardingSeenCount: 2 } } },
      ['/tasks/t'],
    );
    expect((plan.config['projects'] as Record<string, unknown>)['/tasks/t']).toEqual({
      allowedTools: ['Bash'],
      projectOnboardingSeenCount: 2,
      hasTrustDialogAccepted: true,
    });
  });

  it('leaves every other key of the config alone', () => {
    const plan = planTrust({ numStartups: 47, theme: 'dark' }, ['/tasks/t']);
    expect(plan.config['numStartups']).toBe(47);
    expect(plan.config['theme']).toBe('dark');
  });

  it('reports an already-trusted path as unchanged, so nothing is written', () => {
    const plan = planTrust({ projects: { '/tasks/t': { hasTrustDialogAccepted: true } } }, ['/tasks/t']);
    expect(plan.added).toEqual([]);
    expect(plan.already).toEqual(['/tasks/t']);
  });

  it('upgrades an entry that says false — the user declined once, we created this one', () => {
    const plan = planTrust({ projects: { '/tasks/t': { hasTrustDialogAccepted: false } } }, ['/tasks/t']);
    expect(plan.added).toEqual(['/tasks/t']);
  });

  it('leaves an entry that is not an object alone rather than reshaping it', () => {
    // Whatever it is, it is not ours to replace, and Claude Code already reads
    // it as untrusted — so leaving it costs the prompt and replacing it destroys
    // something we do not understand.
    const plan = planTrust({ projects: { '/tasks/t': 'surprise' } }, ['/tasks/t']);
    expect(plan.skipped).toEqual(['/tasks/t']);
    expect((plan.config['projects'] as Record<string, unknown>)['/tasks/t']).toBe('surprise');
  });

  it('does not touch a `projects` that is not an object', () => {
    const plan = planTrust({ projects: 'nonsense' }, ['/tasks/t']);
    expect(plan.added).toEqual(['/tasks/t']);
    // The nonsense is dropped from the value we would write, but only because
    // it was unreadable to Claude Code too — what matters is that nothing about
    // it was interpreted.
    expect(plan.config['projects']).toEqual({ '/tasks/t': { hasTrustDialogAccepted: true } });
  });
});

describe('trustKeys', () => {
  it('carries the literal path and its realpath, since we cannot tell which is looked up', () => {
    const keys = trustKeys('/tmp/tasks/t', (path) => path.replace('/tmp', '/private/tmp'));
    expect([...keys].sort()).toEqual(['/private/tmp/tasks/t', '/tmp/tasks/t']);
  });

  it('collapses to one key when the path is already real', () => {
    expect(trustKeys('/tasks/t', (path) => path)).toEqual(['/tasks/t']);
  });

  it('still yields the literal key when the directory is not there', () => {
    expect(
      trustKeys('/tasks/gone', () => {
        throw new Error('ENOENT');
      }),
    ).toEqual(['/tasks/gone']);
  });
});

describe('seedClaudeTrust', () => {
  it('trusts a generated directory in a real config file', () => {
    const dir = home();
    writeFileSync(claudeConfigFile(dir), JSON.stringify({ numStartups: 3, projects: {} }), 'utf8');
    const out = seedClaudeTrust({ homeDir: dir, dirs: ['/tasks/fix-login'], nonce: 1 });
    expect(out.ok).toBe(true);
    const after = JSON.parse(readFileSync(claudeConfigFile(dir), 'utf8')) as Record<string, unknown>;
    expect(after['numStartups']).toBe(3);
    expect((after['projects'] as Record<string, unknown>)['/tasks/fix-login']).toEqual({
      hasTrustDialogAccepted: true,
    });
  });

  it('says so, with the file and the paths, because this is a write into another program', () => {
    const dir = home();
    writeFileSync(claudeConfigFile(dir), '{}', 'utf8');
    const out = seedClaudeTrust({ homeDir: dir, dirs: ['/tasks/t'], nonce: 1 });
    expect(out.detail).toContain(claudeConfigFile(dir));
    expect(out.detail).toContain('/tasks/t');
  });

  it('trusts the realpath too, so a task root reached through a symlink is covered', () => {
    const dir = home();
    writeFileSync(claudeConfigFile(dir), '{}', 'utf8');
    const real = join(dir, 'real');
    const link = join(dir, 'link');
    mkdirSync(real);
    symlinkSync(real, link);
    seedClaudeTrust({ homeDir: dir, dirs: [link], nonce: 1 });
    const projects = (JSON.parse(readFileSync(claudeConfigFile(dir), 'utf8')) as Record<string, unknown>)[
      'projects'
    ] as Record<string, unknown>;
    // Both forms, because which one Claude Code looks up depends on the machine
    // — and `tmpdir()` is itself behind a symlink on macOS, which is exactly the
    // shape that makes a single-key write miss.
    expect(Object.keys(projects)).toContain(link);
    expect(Object.keys(projects)).toContain(realpathSync(link));
  });

  it('leaves a malformed config completely alone', () => {
    // The rule this feature is built around: no trust record is worth replacing
    // a user's configuration with a fresh object.
    const dir = home();
    const broken = '{ "projects": { unclosed';
    writeFileSync(claudeConfigFile(dir), broken, 'utf8');
    const out = seedClaudeTrust({ homeDir: dir, dirs: ['/tasks/t'], nonce: 1 });
    expect(out.ok).toBe(false);
    expect(readFileSync(claudeConfigFile(dir), 'utf8')).toBe(broken);
  });

  it('does not create a config that was not there', () => {
    // A machine that has never run Claude Code has no agent to unblock, and a
    // file we invent is one the real program will overwrite from its defaults.
    const dir = home();
    const out = seedClaudeTrust({ homeDir: dir, dirs: ['/tasks/t'], nonce: 1 });
    expect(out.ok).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses a config whose top level is not an object', () => {
    const dir = home();
    writeFileSync(claudeConfigFile(dir), '[1,2,3]', 'utf8');
    expect(seedClaudeTrust({ homeDir: dir, dirs: ['/tasks/t'], nonce: 1 }).ok).toBe(false);
    expect(readFileSync(claudeConfigFile(dir), 'utf8')).toBe('[1,2,3]');
  });

  it('reports a write it could not make, and leaves the file intact', () => {
    const dir = home();
    writeFileSync(claudeConfigFile(dir), '{}', 'utf8');
    // No write permission on the directory, so the temp file cannot be created.
    chmodSync(dir, 0o500);
    try {
      const out = seedClaudeTrust({ homeDir: dir, dirs: ['/tasks/t'], nonce: 1 });
      expect(out.ok).toBe(false);
      expect(out.detail).toContain('could not write');
      expect(readFileSync(claudeConfigFile(dir), 'utf8')).toBe('{}');
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it('leaves no temp file behind on either path', () => {
    const dir = home();
    writeFileSync(claudeConfigFile(dir), '{}', 'utf8');
    seedClaudeTrust({ homeDir: dir, dirs: ['/tasks/t'], nonce: 7 });
    expect(readdirSync(dir).filter((name) => name.includes('tmp'))).toEqual([]);
  });

  it('writes nothing when every path is already trusted', () => {
    const dir = home();
    const file = claudeConfigFile(dir);
    writeFileSync(file, JSON.stringify({ projects: { '/tasks/t': { hasTrustDialogAccepted: true } } }), 'utf8');
    const before = readFileSync(file, 'utf8');
    const out = seedClaudeTrust({ homeDir: dir, dirs: ['/tasks/t'], nonce: 1 });
    expect(out.ok).toBe(true);
    // Byte-identical: a re-provision must not rewrite the user's whole config
    // just to restate something it already says.
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('keeps the config readable only by its owner', () => {
    const dir = home();
    writeFileSync(claudeConfigFile(dir), '{}', { encoding: 'utf8', mode: 0o600 });
    seedClaudeTrust({ homeDir: dir, dirs: ['/tasks/t'], nonce: 1 });
    // `rename` keeps the mode of the file it MOVES, so the temp file's mode is
    // the one that survives — which is why the temp file is created 0600 and not
    // left to the default umask. A world-readable `~/.claude.json` is a
    // regression this feature would otherwise introduce silently.
    expect(statSync(claudeConfigFile(dir)).mode & 0o777).toBe(0o600);
  });
});
