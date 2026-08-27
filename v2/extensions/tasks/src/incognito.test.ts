import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ExecErr, ExecOk } from '@shepherd/sdk';
import {
  claudeCredentials,
  incognitoCommand,
  incognitoProfileDir,
  orphanProfiles,
  removeIncognitoProfile,
  seedIncognitoProfile,
} from './incognito.ts';

/**
 * The ephemeral Claude profile: where it lives, what is in it, and — the half
 * that actually matters — that it takes nothing from the user's real profile
 * and leaves nothing behind.
 */

const base = (): string => mkdtempSync(join(tmpdir(), 'shepherd-incognito-'));

describe('incognitoProfileDir', () => {
  it('sits beside .archives and .prompts, outside every task root and worktree', () => {
    expect(incognitoProfileDir('/Users/u/.shepherd/v2', 'task-7')).toBe(
      '/Users/u/.shepherd/v2/.incognito/task-7',
    );
  });
});

describe('seedIncognitoProfile', () => {
  it('creates a profile holding nothing but the config file', () => {
    const root = base();
    const dir = incognitoProfileDir(root, 'task-1');

    const seeded = seedIncognitoProfile({ dir, dirs: ['/tasks/t1'], realpath: (p) => p });

    expect(seeded.ok).toBe(true);
    expect(existsSync(join(dir, 'settings.json'))).toBe(false);
    expect(existsSync(join(dir, 'skills'))).toBe(false);
    expect(existsSync(join(dir, 'plugins'))).toBe(false);
    expect(existsSync(join(dir, 'projects'))).toBe(false);
    expect(existsSync(join(dir, 'history.jsonl'))).toBe(false);
  });

  it('pre-trusts the task directories, so no agent opens on the trust dialog', () => {
    const root = base();
    const dir = incognitoProfileDir(root, 'task-2');

    seedIncognitoProfile({ dir, dirs: ['/tasks/t2', '/tasks/t2/repo'], realpath: (p) => p });

    const config = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')) as Record<string, unknown>;
    expect(config['projects']).toEqual({
      '/tasks/t2': { hasTrustDialogAccepted: true },
      '/tasks/t2/repo': { hasTrustDialogAccepted: true },
    });
  });

  it('marks onboarding complete, so no agent opens on the theme picker', () => {
    const root = base();
    const dir = incognitoProfileDir(root, 'task-3');

    seedIncognitoProfile({ dir, dirs: ['/tasks/t3'], realpath: (p) => p, onboardingVersion: '2.1.245' });

    const config = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')) as Record<string, unknown>;
    expect(config['hasCompletedOnboarding']).toBe(true);
    expect(config['lastOnboardingVersion']).toBe('2.1.245');
  });

  it('carries the credential across, or the agent opens on “Please run /login”', () => {
    /*
     * Measured against Claude Code 2.1.245, and it is the one thing a blank
     * profile cannot do without. The OAuth token is in the macOS Keychain, but
     * Claude Code reads the Keychain only for its DEFAULT config dir — point
     * `CLAUDE_CONFIG_DIR` elsewhere and it looks for `.credentials.json` inside
     * it, so a profile without one is signed out no matter what else is copied
     * in. A full copy of `~/.claude.json`, `oauthAccount` and all, does not fix
     * it; this does.
     */
    const root = base();
    const dir = incognitoProfileDir(root, 'task-c');

    seedIncognitoProfile({
      dir,
      dirs: ['/tasks/tc'],
      realpath: (p) => p,
      credentials: '{"claudeAiOauth":{"accessToken":"t"}}',
    });

    expect(readFileSync(join(dir, '.credentials.json'), 'utf8')).toBe('{"claudeAiOauth":{"accessToken":"t"}}');
  });

  it('keeps the credential unreadable by anyone else', () => {
    const root = base();
    const dir = incognitoProfileDir(root, 'task-d');

    seedIncognitoProfile({ dir, dirs: ['/t'], realpath: (p) => p, credentials: '{}' });

    // A token that left the Keychain for a file is only as private as its mode.
    expect(statSync(join(dir, '.credentials.json')).mode & 0o777).toBe(0o600);
  });

  it('seeds without one rather than failing, when the Keychain would not answer', () => {
    const root = base();
    const dir = incognitoProfileDir(root, 'task-e');

    const seeded = seedIncognitoProfile({ dir, dirs: ['/t'], realpath: (p) => p });

    // Degraded, not broken: the task provisions and the agent asks for a login.
    expect(seeded.ok).toBe(true);
    expect(existsSync(join(dir, '.credentials.json'))).toBe(false);
  });

  it('carries the Shepherd plugin, or the rail never learns what the agent is doing', () => {
    /*
     * Shepherd tracks an agent through the hooks this plugin declares — the
     * kernel injects `SHEPHERD_SESSION_ID` and the socket paths, and the
     * plugin's `report.sh` is what posts back. A profile without it runs a
     * perfectly good Claude that Shepherd cannot see: no state mark, no
     * attention, no notification. Incognito is about what is KEPT, not about
     * opting out of the terminal you are sitting in.
     */
    const root = base();
    const dir = incognitoProfileDir(root, 'task-p');
    const plugin = join(root, 'real', 'skills', 'shepherd-v2');
    mkdirSync(plugin, { recursive: true });

    seedIncognitoProfile({ dir, dirs: ['/t'], realpath: (p) => p, plugin });

    // A LINK, not a copy: the plugin is the app's own and is read, never
    // written, so a copy per task would be a copy to keep in step.
    const linked = join(dir, 'skills', 'shepherd-v2');
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linked)).toBe(plugin);
  });

  it('carries the statusline, and nothing else out of the real settings', () => {
    const root = base();
    const dir = incognitoProfileDir(root, 'task-s');

    seedIncognitoProfile({
      dir,
      dirs: ['/t'],
      realpath: (p) => p,
      statusLine: { type: 'command', command: '~/.claude/statusline-command.sh' },
    });

    const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as Record<string, unknown>;
    // Not the model, not the permissions, not the other hooks — the one key
    // that was asked for. Everything else is still new.
    expect(settings).toEqual({ statusLine: { type: 'command', command: '~/.claude/statusline-command.sh' } });
  });

  it('writes no settings at all when there is no statusline to carry', () => {
    const root = base();
    const dir = incognitoProfileDir(root, 'task-n');

    seedIncognitoProfile({ dir, dirs: ['/t'], realpath: (p) => p });

    expect(existsSync(join(dir, 'settings.json'))).toBe(false);
  });

  it('seeds anyway when the plugin is not where it was said to be', () => {
    const root = base();
    const dir = incognitoProfileDir(root, 'task-m');

    const seeded = seedIncognitoProfile({
      dir,
      dirs: ['/t'],
      realpath: (p) => p,
      plugin: join(root, 'nothing', 'here'),
    });

    // Degraded, not broken: the task provisions and the agent runs untracked,
    // which is visible in the rail rather than silent.
    expect(seeded.ok).toBe(true);
    expect(existsSync(join(dir, '.claude.json'))).toBe(true);
  });

  it('carries nothing else — no identity, no history, no settings from the real profile', () => {
    const root = base();
    const dir = incognitoProfileDir(root, 'task-4');

    seedIncognitoProfile({ dir, dirs: ['/tasks/t4'], realpath: (p) => p, onboardingVersion: '2.1.245' });

    const config = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(config).sort()).toEqual([
      'hasCompletedOnboarding',
      'lastOnboardingVersion',
      'projects',
    ]);
  });

  it('adds to a profile it already seeded rather than clobbering it — a restore re-provisions', () => {
    const root = base();
    const dir = incognitoProfileDir(root, 'task-5');
    seedIncognitoProfile({ dir, dirs: ['/tasks/t5'], realpath: (p) => p });

    seedIncognitoProfile({ dir, dirs: ['/tasks/t5/late-repo'], realpath: (p) => p });

    const config = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(config['projects'] as object).sort()).toEqual(['/tasks/t5', '/tasks/t5/late-repo']);
  });
});

describe('removeIncognitoProfile', () => {
  it('takes the whole profile with it', () => {
    const root = base();
    const dir = incognitoProfileDir(root, 'task-6');
    seedIncognitoProfile({ dir, dirs: ['/tasks/t6'], realpath: (p) => p });
    writeFileSync(join(dir, 'history.jsonl'), '{"display":"secret"}\n');

    const removed = removeIncognitoProfile(dir);

    expect(removed.ok).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it('is fine with a profile that is already gone', () => {
    const root = base();
    expect(removeIncognitoProfile(incognitoProfileDir(root, 'never-existed')).ok).toBe(true);
  });
});

describe('orphanProfiles', () => {
  it('names the profiles no live task claims — the sweep after a force-quit', () => {
    const root = base();
    mkdirSync(join(root, '.incognito', 'task-a'), { recursive: true });
    mkdirSync(join(root, '.incognito', 'task-b'), { recursive: true });

    expect(orphanProfiles(root, ['task-a'])).toEqual([join(root, '.incognito', 'task-b')]);
  });

  it('finds nothing when no profile has ever been made', () => {
    expect(orphanProfiles(base(), ['task-a'])).toEqual([]);
  });
});

describe('incognitoCommand', () => {
  it('exports the profile into the shell that runs the agent', () => {
    expect(incognitoCommand('claude "hi"', '/data/incognito/task-1')).toBe(
      `export CLAUDE_CONFIG_DIR='/data/incognito/task-1'; claude "hi"`,
    );
  });

  it('exports rather than prefixes, so a second agent typed in that pane is incognito too', () => {
    // A one-shot `VAR=x claude` would cover the launch and nothing after it.
    expect(incognitoCommand('claude', '/d/p')).toMatch(/^export /);
  });

  it('quotes a path with a space in it', () => {
    expect(incognitoCommand('claude', "/My Data/incognito/t")).toBe(
      `export CLAUDE_CONFIG_DIR='/My Data/incognito/t'; claude`,
    );
  });

  it('refuses a path holding a single quote rather than building a broken line', () => {
    expect(() => incognitoCommand('claude', "/d/it's")).toThrow(/quote/);
  });
});

describe('claudeCredentials', () => {
  const proc = (answer: ExecOk | ExecErr) => ({
    exec: async (cmd: readonly string[]) => {
      seen.push(cmd);
      return answer;
    },
    gitRead: async () => answer,
    gitWrite: async () => answer,
  });
  let seen: (readonly string[])[] = [];
  beforeEach(() => {
    seen = [];
  });

  it('asks the Keychain for the item Claude Code stores its token under', async () => {
    await claudeCredentials(proc({ ok: true, stdout: '{"claudeAiOauth":{}}\n', stderr: '' }));
    expect(seen[0]).toEqual(['security', 'find-generic-password', '-s', 'Claude Code-credentials', '-w']);
  });

  it('hands back the token exactly as the Keychain holds it', async () => {
    const answer = await claudeCredentials(proc({ ok: true, stdout: '{"claudeAiOauth":{"a":1}}\n', stderr: '' }));
    expect(answer).toBe('{"claudeAiOauth":{"a":1}}');
  });

  it('answers nothing when the Keychain has no such item', async () => {
    expect(await claudeCredentials(proc({ ok: false, code: 44, stdout: '', stderr: 'not found' }))).toBeUndefined();
  });

  it('answers nothing rather than a token-shaped string that is not one', async () => {
    // A `security` that printed a prompt, a warning or an empty line would
    // otherwise be written into the profile as the credential.
    expect(await claudeCredentials(proc({ ok: true, stdout: 'password: \n', stderr: '' }))).toBeUndefined();
  });
});

describe('incognitoCommand with no line', () => {
  /**
   * A terminal task opens a pane with nothing typed into it, and it still needs
   * the export — a shell without it sends the `claude` you type by hand into the
   * user's real profile, which is the one thing the mode promises not to do.
   */
  it('is the export alone, with no trailing separator', () => {
    expect(incognitoCommand('', '/data/incognito/task-1')).toBe(
      "export CLAUDE_CONFIG_DIR='/data/incognito/task-1'",
    );
    expect(incognitoCommand('   ', '/d/p')).toBe("export CLAUDE_CONFIG_DIR='/d/p'");
  });

  it('still refuses a path it cannot quote', () => {
    expect(() => incognitoCommand('', "/d/it's")).toThrow(/quote/);
  });
});
