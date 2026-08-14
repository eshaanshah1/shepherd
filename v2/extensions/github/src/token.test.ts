import { describe, expect, it } from 'vitest';
import type { ExecErr, ExecOk, ExecOptions, ProcessAPI, SecretStore } from '@shepherd/sdk';
import { resolveToken, TOKEN_SECRET_KEY, type TokenSource } from './token.ts';

interface Run {
  readonly cmd: readonly string[];
  readonly options: ExecOptions;
}

function harness(
  answers: Readonly<Record<string, ExecOk | ExecErr>>,
  stored?: string,
): { source: TokenSource; runs: Run[] } {
  const runs: Run[] = [];
  const process: ProcessAPI = {
    exec: (cmd, options) => {
      runs.push({ cmd, options });
      const answer = answers[cmd[0] ?? ''] ?? { ok: false as const, code: 127, stdout: '', stderr: 'not found' };
      return Promise.resolve(answer);
    },
    gitRead: () => Promise.resolve({ ok: false, code: 1, stdout: '', stderr: 'unused' }),
    gitWrite: () => Promise.resolve({ ok: false, code: 1, stdout: '', stderr: 'unused' }),
  };
  const secrets: SecretStore = {
    get: () => Promise.resolve(stored),
    set: () => Promise.resolve(),
    delete: () => Promise.resolve(),
  };
  return {
    runs,
    source: { process, secrets, env: { homeDir: '/Users/eshaan', userName: 'eshaan' }, cwd: '/tmp' },
  };
}

const ok = (stdout: string): ExecOk => ({ ok: true, stdout, stderr: '' });

describe('resolveToken', () => {
  it('asks gh first, so the common case needs no configuration', async () => {
    const { source, runs } = harness({ '/opt/homebrew/bin/gh': ok('gho_abc123\n') });
    await expect(resolveToken(source)).resolves.toEqual({ value: 'gho_abc123', origin: 'gh' });
    expect(runs[0]?.cmd).toEqual(['/opt/homebrew/bin/gh', 'auth', 'token']);
  });

  it('probes the places a GUI app’s PATH does not have', async () => {
    // A `.app` inherits a minimal PATH, so Homebrew's `gh` is invisible to a
    // bare `gh`. v1 learned this; the probe order is copied from it.
    const { source, runs } = harness({ '/usr/local/bin/gh': ok('gho_local') });
    await expect(resolveToken(source)).resolves.toEqual({ value: 'gho_local', origin: 'gh' });
    expect(runs.map((run) => run.cmd[0])).toEqual(['/opt/homebrew/bin/gh', '/usr/local/bin/gh']);
  });

  it('hands the child USER as well as HOME, or gh reports itself logged out', async () => {
    // Measured, and recorded in CLAUDE.md: `exec` REPLACES the environment, and
    // a vendor CLI without `USER` cannot reach the keychain — which looks
    // exactly like a machine nobody signed in on.
    const { source, runs } = harness({ '/opt/homebrew/bin/gh': ok('t') });
    await resolveToken(source);
    expect(runs[0]?.options.env).toEqual({ HOME: '/Users/eshaan', USER: 'eshaan' });
  });

  it('names no PATH, so it inherits the app’s harvested one', async () => {
    /*
     * It used to name one, and that was the last hardcoded PATH list outside
     * `platform/darwin`. `exec` composes the standard locations over the app's
     * own PATH — which since startup is the user's LOGIN-SHELL PATH — so naming
     * one here would replace a good answer with a fixed one, and put this
     * extension back to knowing where tools live.
     */
    const { source, runs } = harness({ '/opt/homebrew/bin/gh': ok('t') });
    await resolveToken(source);
    expect(runs[0]?.options.env).not.toHaveProperty('PATH');
  });

  it('keeps looking past a gh that exits 0 with nothing — that one is logged out', async () => {
    const { source } = harness({ '/opt/homebrew/bin/gh': ok('  \n'), '/usr/local/bin/gh': ok('gho_second') });
    await expect(resolveToken(source)).resolves.toEqual({ value: 'gho_second', origin: 'gh' });
  });

  it('falls back to this extension’s own secret when no gh answers', async () => {
    const { source } = harness({}, 'ghp_stored');
    await expect(resolveToken(source)).resolves.toEqual({ value: 'ghp_stored', origin: 'secret' });
  });

  it('treats a blank stored secret as no secret', async () => {
    const { source } = harness({}, '   ');
    await expect(resolveToken(source)).resolves.toBeNull();
  });

  it('answers null rather than throwing when there is nothing to find', async () => {
    // No token is an ordinary state — a machine that has never signed in — and
    // the surfaces above draw "not signed in" from it.
    const { source } = harness({});
    await expect(resolveToken(source)).resolves.toBeNull();
  });

  it('stores a PAT under a key namespaced to this extension by the host', () => {
    // The host derives the namespace from the manifest id; the extension names
    // only the leaf, and a bare `token` is the honest leaf.
    expect(TOKEN_SECRET_KEY).toBe('token');
  });

  it('never reads an environment variable for a token', async () => {
    // `GH_TOKEN` in a shell profile is a credential the app would pick up
    // without anybody deciding it should. The child's env is what we hand it,
    // and it contains no token.
    const { source, runs } = harness({ '/opt/homebrew/bin/gh': ok('t') });
    await resolveToken(source);
    expect(JSON.stringify(runs[0]?.options.env)).not.toContain('TOKEN');
  });
});

describe('a host that has not implemented secrets yet', () => {
  it('answers "no token" rather than throwing', async () => {
    /*
     * Not a hypothetical. `SecretStore` is typed in the SDK and `secrets.get`
     * THROWS in this build — deliberately, so an author finds out at the call.
     * A machine with no `gh` therefore took the extension host down through an
     * unhandled rejection, on the path whose entire purpose is to answer "there
     * is no token". Found by `smoke:m3`.
     */
    const process: ProcessAPI = {
      exec: () => Promise.resolve({ ok: false, code: 127, stdout: '', stderr: 'not found' }),
      gitRead: () => Promise.resolve({ ok: false, code: 1, stdout: '', stderr: '' }),
      gitWrite: () => Promise.resolve({ ok: false, code: 1, stdout: '', stderr: '' }),
    };
    const secrets: SecretStore = {
      get: () => Promise.reject(new Error('secrets.get is not available in this build')),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    };
    await expect(
      resolveToken({ process, secrets, env: { homeDir: '/h', userName: 'u' }, cwd: '/h' }),
    ).resolves.toBeNull();
  });
});
