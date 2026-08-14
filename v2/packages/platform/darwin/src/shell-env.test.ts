import { describe, expect, it } from 'vitest';
import {
  HARVESTED,
  captureScript,
  installShellEnvironment,
  mergePath,
  readCaptured,
  shellCandidates,
} from './shell-env.ts';
import { FALLBACK_SHELLS } from './shell.ts';

/**
 * The parsing and merging, without a shell — which is why they are separate
 * functions from the spawn at all. Every case below is a shape a real profile
 * produces: one that prints a banner, one that exports nothing, one that
 * overwrote `PATH` instead of appending to it.
 *
 * `installShellEnvironment` itself is exercised at the end against the machine
 * this runs on, and it is written so that a machine with no usable shell passes
 * the same assertions as one with a rich profile.
 */

describe('captureScript', () => {
  it('reads the variable with printenv rather than expanding it', () => {
    // `echo $PATH` is expanded by the shell writing the script, which is us —
    // so it would print OUR value back and the probe would always agree with
    // itself.
    expect(captureScript(['PATH'])).toContain('printenv PATH');
    expect(captureScript(['PATH'])).not.toContain('$PATH');
  });

  it('tolerates an unset variable, because `set -e` in a profile is real', () => {
    // printenv exits non-zero for a name that is not set. Without the `|| true`
    // a profile that turned on errexit would end the script there, and every
    // name after it would be silently missing.
    expect(captureScript(['SSH_AUTH_SOCK'])).toContain('|| true');
  });

  it('names only characters that cannot mean anything to a shell', () => {
    // The names are a constant in this file, not user input — but they are
    // interpolated into a script, and this is the assertion that keeps that
    // true if the list ever grows.
    for (const name of HARVESTED) expect(name).toMatch(/^[A-Z_]+$/);
  });
});

describe('readCaptured', () => {
  const wrap = (name: string, value: string): string =>
    `__SHEPHERD_ENV_${name}_start__\n${value}\n__SHEPHERD_ENV_${name}_end__\n`;

  it('reads a value out of a profile that also printed other things', () => {
    // The reason for markers rather than parsing `env`: a profile prints motd,
    // fastfetch, a version-manager warning — and any of it can look like a
    // KEY=value line.
    const noisy = `Welcome back!\nPATH=/decoy\n${wrap('PATH', '/opt/homebrew/bin:/usr/bin')}nvm: no .nvmrc\n`;
    expect(readCaptured(noisy, ['PATH'])).toEqual({ PATH: '/opt/homebrew/bin:/usr/bin' });
  });

  it('reads several, and skips the ones that are not set', () => {
    const output = `${wrap('PATH', '/usr/bin')}${wrap('SSH_AUTH_SOCK', '')}`;
    expect(readCaptured(output, ['PATH', 'SSH_AUTH_SOCK'])).toEqual({ PATH: '/usr/bin' });
  });

  it('answers nothing for a shell that printed nothing at all', () => {
    // The timeout case, and the no-such-shell case. Both land here.
    expect(readCaptured('', ['PATH'])).toEqual({});
    expect(readCaptured('zsh: command not found: printenv', ['PATH'])).toEqual({});
  });

  it('drops a value whose closing marker never arrived', () => {
    // A shell killed mid-print. Half a PATH is worse than none: it would be
    // merged in and then used to resolve programs.
    expect(readCaptured(`__SHEPHERD_ENV_PATH_start__\n/opt/homebrew`, ['PATH'])).toEqual({});
  });
});

describe('mergePath', () => {
  it('puts the harvested path first and keeps the inherited one', () => {
    // Harvested first because it is the one the user configured; inherited kept
    // because dropping it can only ever take something away.
    expect(mergePath('/opt/homebrew/bin:/usr/bin', '/usr/bin:/bin')).toBe(
      '/opt/homebrew/bin:/usr/bin:/bin',
    );
  });

  it('survives a profile that OVERWROTE PATH instead of appending', () => {
    // Real, and the reason this merges rather than replaces: a `PATH=~/bin`
    // line with no `:$PATH` would otherwise take /usr/bin away from an app that
    // had it a moment ago.
    expect(mergePath('/Users/me/bin', '/usr/bin:/bin')).toBe('/Users/me/bin:/usr/bin:/bin');
  });

  it('drops an empty entry, which to execvp means the current directory', () => {
    expect(mergePath('/usr/bin::/bin', undefined)).toBe('/usr/bin:/bin');
  });

  it('answers the inherited path when nothing was harvested', () => {
    expect(mergePath(undefined, '/usr/bin:/bin')).toBe('/usr/bin:/bin');
    expect(mergePath(undefined, undefined)).toBe('');
  });
});

describe('shellCandidates', () => {
  it('asks the user’s own shell first', () => {
    // v1's recorded rule, one door along: probing with a hardcoded bash reads
    // BASH profiles, so a PATH configured in zsh is invisible and the probe
    // concludes the tool is not installed.
    expect(shellCandidates({ SHELL: '/opt/homebrew/bin/fish' })[0]).toBe('/opt/homebrew/bin/fish');
  });

  it('falls back to the same list a pane’s shell falls back to', () => {
    expect(shellCandidates({})).toEqual([...FALLBACK_SHELLS]);
  });

  it('ignores a relative $SHELL', () => {
    // It would be resolved against a PATH we do not trust yet, which is the
    // whole problem this file exists to solve.
    expect(shellCandidates({ SHELL: 'zsh' })).toEqual([...FALLBACK_SHELLS]);
  });

  it('does not ask the same shell twice', () => {
    expect(shellCandidates({ SHELL: '/bin/zsh' })).toEqual([...FALLBACK_SHELLS]);
  });
});

describe('installShellEnvironment', () => {
  /** A shell that prints what a profile with a version manager would. */
  const answers = (values: Record<string, string>): string =>
    Object.entries(values)
      .map(([name, value]) => `__SHEPHERD_ENV_${name}_start__\n${value}\n__SHEPHERD_ENV_${name}_end__\n`)
      .join('');

  const asked: string[][] = [];
  const probeReturning = (byCommand: Record<string, string>) => {
    asked.length = 0;
    return (command: string, args: readonly string[]) => {
      asked.push([command, ...args]);
      return Promise.resolve(byCommand[command] ?? '');
    };
  };

  const LAUNCHD = '/usr/bin:/bin:/usr/sbin:/sbin';

  it('takes the login shell’s PATH and keeps the one it already had', async () => {
    const env: NodeJS.ProcessEnv = { SHELL: '/bin/zsh', PATH: LAUNCHD };
    const report = await installShellEnvironment({
      env,
      probe: probeReturning({
        '/bin/zsh': answers({ PATH: '/Users/me/.local/share/mise/shims:/opt/homebrew/bin:/usr/bin:/bin' }),
      }),
    });

    expect(env['PATH']).toBe(
      '/Users/me/.local/share/mise/shims:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    );
    expect(report).toMatchObject({ origin: 'login-shell', shell: '/bin/zsh', added: 2 });
  });

  it('asks the shell as INTERACTIVE, not just as a login shell', async () => {
    // The line that puts a version manager on PATH lives in `.zshrc`, which a
    // non-interactive login shell never reads — so `-l` alone reports a PATH the
    // user has never seen in a terminal. This is the whole reason the feature
    // works at all, so it is asserted rather than left to the comment.
    const env: NodeJS.ProcessEnv = { SHELL: '/bin/zsh', PATH: LAUNCHD };
    await installShellEnvironment({ env, probe: probeReturning({ '/bin/zsh': answers({ PATH: '/x' }) }) });
    expect(asked[0]?.[1]).toBe('-ilc');
  });

  it('tries the next shell when the first one answers nothing', async () => {
    // `$SHELL` naming something that is no longer installed is the ordinary way
    // this happens — a shell uninstalled while it was still the login shell.
    const env: NodeJS.ProcessEnv = { SHELL: '/opt/homebrew/bin/fish', PATH: LAUNCHD };
    const report = await installShellEnvironment({
      env,
      probe: probeReturning({ '/bin/zsh': answers({ PATH: '/opt/homebrew/bin:/usr/bin' }) }),
    });

    expect(report.shell).toBe('/bin/zsh');
    expect(env['PATH']).toContain('/opt/homebrew/bin');
  });

  it('falls back to launchd when no shell answers', async () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const report = await installShellEnvironment({
      env,
      probe: probeReturning({ '/bin/launchctl': `${LAUNCHD}\n` }),
    });

    expect(report).toMatchObject({ origin: 'launchctl', shell: null });
    expect(env['PATH']).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
    expect(asked.at(-1)).toEqual(['/bin/launchctl', 'getenv', 'PATH']);
  });

  it('leaves the environment exactly as it was when everything fails', async () => {
    /*
     * The failure that matters: no shell, no launchd, nothing. The app must
     * behave precisely as it did before this file existed — which for a machine
     * launched from a terminal is already correct.
     */
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
    const report = await installShellEnvironment({ env, probe: probeReturning({}) });

    expect(env).toEqual({ PATH: '/usr/bin:/bin' });
    expect(report).toMatchObject({ origin: 'inherited', shell: null, added: 0 });
  });

  it('never asks launchd when the shell already answered', async () => {
    // It is a second spawn on the startup path, and startup is the one budget
    // this feature spends from.
    const env: NodeJS.ProcessEnv = { SHELL: '/bin/zsh', PATH: '/usr/bin' };
    await installShellEnvironment({ env, probe: probeReturning({ '/bin/zsh': answers({ PATH: '/x' }) }) });
    expect(asked.map(([command]) => command)).not.toContain('/bin/launchctl');
  });

  it('fills in SSH_AUTH_SOCK only when launchd did not supply one', async () => {
    // Overwriting a working agent socket with a profile's idea of where one
    // should be is how you break ssh for somebody it was working for.
    const shell = answers({ PATH: '/usr/bin', SSH_AUTH_SOCK: '/from/profile.sock' });

    const missing: NodeJS.ProcessEnv = { SHELL: '/bin/zsh', PATH: '/usr/bin' };
    await installShellEnvironment({ env: missing, probe: probeReturning({ '/bin/zsh': shell }) });
    expect(missing['SSH_AUTH_SOCK']).toBe('/from/profile.sock');

    const live: NodeJS.ProcessEnv = { SHELL: '/bin/zsh', PATH: '/usr/bin', SSH_AUTH_SOCK: '/live.sock' };
    await installShellEnvironment({ env: live, probe: probeReturning({ '/bin/zsh': shell }) });
    expect(live['SSH_AUTH_SOCK']).toBe('/live.sock');
  });

  it('takes nothing from a profile beyond the two names it asked for', async () => {
    // `shell.ts` exists to STRIP inherited variables — a proxy pointing at a dead
    // port, another agent's session ids, forty npm_* keys. Harvesting is the same
    // door in the other direction, so it stays narrow by construction.
    const env: NodeJS.ProcessEnv = { SHELL: '/bin/zsh', PATH: '/usr/bin' };
    await installShellEnvironment({
      env,
      probe: probeReturning({
        '/bin/zsh': answers({ PATH: '/usr/bin', HTTPS_PROXY: 'http://127.0.0.1:9', CI: 'true' }),
      }),
    });
    expect(env).toEqual({ SHELL: '/bin/zsh', PATH: '/usr/bin' });
  });

  it('reports the time it cost, because that time is added to every launch', async () => {
    let clock = 1000;
    const report = await installShellEnvironment({
      env: { PATH: '/usr/bin' },
      probe: probeReturning({}),
      now: () => (clock += 40),
    });
    expect(report.ms).toBe(40);
  });

  it('never takes a directory away, against the real machine', async () => {
    /*
     * The one test that spawns for real — and it asserts the one property that
     * has to hold on a machine we have never seen: whatever the harvest returns,
     * every directory that was on PATH before is still on it after.
     *
     * Deliberately makes no claim about what it FINDS. This runs on a developer's
     * machine, in CI, and on whatever a contributor uses; a test that expected
     * Homebrew to be there would be a test about the machine.
     */
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: '/usr/bin:/bin:/sentinel' };
    const report = await installShellEnvironment({ env });

    for (const dir of ['/usr/bin', '/bin', '/sentinel']) {
      expect(env['PATH']?.split(':')).toContain(dir);
    }
    expect(['login-shell', 'launchctl', 'inherited']).toContain(report.origin);
  });
});
