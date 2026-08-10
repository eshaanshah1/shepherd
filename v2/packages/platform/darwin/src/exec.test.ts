import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import {
  clearResolvedPrograms,
  execPath,
  findProgram,
  gitEnv,
  resolveProgram,
  runGit,
  searchDirs,
  spawnDetached,
  truncate,
  MAX_OUTPUT_BYTES,
  STANDARD_BIN_DIRS,
} from './exec.ts';

/**
 * The pure decisions inside the runner. `runExec` itself spawns a process and is
 * covered by the app's integration path; what is tested here is everything that
 * can be wrong without a subprocess — and both env rules are v1 bugs the Rebuild
 * checklist asked to make structural rather than remembered.
 */

describe('gitEnv', () => {
  it('sets GIT_OPTIONAL_LOCKS=0 for a read', () => {
    // v1: a plain `git status` REWRITES .git/index, which woke the watcher that
    // had just run it, and the two sustained each other with nothing happening
    // in the repo. This flag is git's own switch for exactly that.
    expect(gitEnv('read', {}, { HOME: '/u/me' }).GIT_OPTIONAL_LOCKS).toBe('0');
  });

  it('does NOT set it for a write, which legitimately takes the lock', () => {
    expect(gitEnv('write', {}, { HOME: '/u/me' }).GIT_OPTIONAL_LOCKS).toBeUndefined();
  });

  it('MERGES into the inherited environment rather than replacing it', () => {
    // v1: replacing loses HOME, and with it git's config — so a `git commit`
    // would fail on an unset user.name in a repo that was configured correctly.
    const env = gitEnv('write', { GIT_EDITOR: 'true' }, { HOME: '/u/me', PATH: '/somewhere/bin' });
    expect(env.HOME).toBe('/u/me');
    // PATH is the one key that is added to rather than passed through — every
    // entry of the inherited one survives, with the standard locations in front.
    expect(env.PATH?.split(':')).toContain('/somewhere/bin');
    expect(env.GIT_EDITOR).toBe('true');
  });

  it('gives the child the standard bin directories even when PATH has none', () => {
    // The bug this fixes: a GUI-launched .app inherits launchd's PATH, and
    // `git`'s own credential helpers and `ssh` are looked up in this string.
    const env = gitEnv('read', {}, { PATH: '/usr/bin:/bin' });
    for (const dir of STANDARD_BIN_DIRS) expect(env.PATH?.split(':')).toContain(dir);
  });

  it('adds a PATH even when the inherited environment has none at all', () => {
    // An absent PATH is dropped by the merge above (spawn rejects `undefined`),
    // which is how a child ends up with no PATH whatsoever.
    expect(gitEnv('read', {}, { HOME: '/u/me' }).PATH).toBe(STANDARD_BIN_DIRS.join(':'));
  });

  it('lets an explicit override win over the inherited value', () => {
    expect(gitEnv('write', { HOME: '/tmp/fake' }, { HOME: '/u/me' }).HOME).toBe('/tmp/fake');
  });

  it('drops inherited keys with no value, which spawn rejects', () => {
    expect('EMPTY' in gitEnv('read', {}, { HOME: '/u/me', EMPTY: undefined })).toBe(false);
  });
});

describe('searchDirs', () => {
  it('probes the standard locations BEFORE the inherited PATH', () => {
    // Deliberately this way round: the inherited PATH is minimal exactly when
    // the app was launched the way a user launches it, so trusting it first
    // would make which `git` we run depend on how the app was started.
    expect(searchDirs('/opt/custom/bin')).toEqual([...STANDARD_BIN_DIRS, '/opt/custom/bin']);
  });

  it('keeps every entry of the inherited PATH, in its own order', () => {
    expect(searchDirs('/a:/b')).toEqual([...STANDARD_BIN_DIRS, '/a', '/b']);
  });

  it('drops duplicates so the string stays readable in a log line', () => {
    expect(searchDirs('/usr/bin:/bin')).toEqual([...STANDARD_BIN_DIRS]);
  });

  it('drops empty entries, which mean "the current directory" to execvp', () => {
    // A program found in the cwd is a program somebody else put there.
    expect(searchDirs('/a::/b')).not.toContain('');
  });

  it('copes with no inherited PATH at all', () => {
    expect(execPath(undefined)).toBe(STANDARD_BIN_DIRS.join(':'));
  });
});

describe('findProgram', () => {
  const has = (...paths: string[]) => (path: string) => paths.includes(path);

  it('returns the first directory in the order that has it', () => {
    expect(findProgram('git', ['/a', '/b'], has('/a/git', '/b/git'))).toBe('/a/git');
  });

  it('walks past directories that do not', () => {
    expect(findProgram('git', ['/a', '/b'], has('/b/git'))).toBe('/b/git');
  });

  it('answers undefined when nothing has it, rather than guessing', () => {
    expect(findProgram('git', ['/a', '/b'], has())).toBeUndefined();
  });

  it('leaves a name that is already a path alone', () => {
    // `/usr/bin/git` and `./script` name a file; searching for the basename
    // would run a different program than the caller asked for.
    expect(findProgram('/usr/bin/git', ['/a'], has('/a/git'))).toBe('/usr/bin/git');
    expect(findProgram('./script', ['/a'], has('/a/script'))).toBe('./script');
  });
});

describe('resolveProgram', () => {
  beforeEach(() => {
    clearResolvedPrograms();
  });

  it('finds a real executable on a PATH that does not list its directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-exec-'));
    const bin = join(dir, 'shepherd-probe-tool');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    expect(resolveProgram('shepherd-probe-tool', dir)).toBe(bin);
  });

  it('hands the bare name back when nothing has it', () => {
    // So the failure reads `spawn <name> ENOENT` — the true, recognisable error
    // for "it is not installed" — rather than an invented one from here.
    expect(resolveProgram('shepherd-no-such-tool-anywhere', '/nonexistent')).toBe(
      'shepherd-no-such-tool-anywhere',
    );
  });

  it('does not mistake a directory of the same name for the program', () => {
    // A directory carries the same x bits an executable does.
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-exec-'));
    mkdirSync(join(dir, 'shepherd-probe-dir'));
    expect(resolveProgram('shepherd-probe-dir', dir)).toBe('shepherd-probe-dir');
  });

  it('caches a success, so the probe is paid once per program', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-exec-'));
    const bin = join(dir, 'shepherd-cached-tool');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    expect(resolveProgram('shepherd-cached-tool', dir)).toBe(bin);
    // A second call with a PATH that could not possibly find it still answers,
    // which is only true if the first answer was remembered.
    expect(resolveProgram('shepherd-cached-tool', '/nonexistent')).toBe(bin);
  });

  it('does NOT cache a failure, so installing a tool mid-session takes effect', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-exec-'));
    expect(resolveProgram('shepherd-late-tool', dir)).toBe('shepherd-late-tool');
    const bin = join(dir, 'shepherd-late-tool');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    expect(resolveProgram('shepherd-late-tool', dir)).toBe(bin);
  });
});

describe('runGit against a real minimal PATH', () => {
  it('runs git even when the inherited PATH could never find it', async () => {
    // The measured bug, reproduced: a GUI-launched .app inherits launchd's PATH,
    // and `tasks.delete` came back `spawn git ENOENT`. Before the resolution
    // above, this call ran `git` under a PATH with no git in it and failed the
    // same way. `--version` is chosen because it needs no repository — the point
    // is only that the binary was found.
    const out = await runGit('read', ['--version'], {
      cwd: tmpdir(),
      env: { PATH: '/nonexistent' },
      timeoutMs: 30_000,
    });
    expect(out.stdout).toMatch(/^git version/);
    expect(out.ok).toBe(true);
  });
});

describe('truncate', () => {
  it('leaves ordinary output alone', () => {
    expect(truncate('hello')).toEqual({ text: 'hello', truncated: false });
  });

  it('caps output that would otherwise cross the port whole', () => {
    // A `git diff` can be megabytes, and it crosses a message port as a cloned
    // string. Both HTTP ingresses already cap their bodies; this path is the
    // one that did not.
    const out = truncate('x'.repeat(MAX_OUTPUT_BYTES * 2));
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(MAX_OUTPUT_BYTES + 200);
  });

  it('SAYS it truncated, in the output itself', () => {
    // Silent truncation reads as a complete answer, which is how a caller
    // concludes a file has no more matches.
    expect(truncate('x'.repeat(MAX_OUTPUT_BYTES * 2)).text).toMatch(/truncat/i);
  });

  it('keeps the beginning, not the end', () => {
    expect(truncate(`START${'x'.repeat(MAX_OUTPUT_BYTES * 2)}`).text.startsWith('START')).toBe(true);
  });
});

/**
 * The detached child's log, which is the whole of `shepherdd`'s ability to say
 * why it died.
 *
 * Worth a real subprocess — the rest of this file is deliberately pure — because
 * the thing that can be wrong here is fd plumbing, and fd plumbing that is wrong
 * fails by writing nowhere, which is indistinguishable from the daemon having
 * had nothing to say. That is precisely the state this replaced: a daemon that
 * exited an hour into a run and left no trace but a pid that no longer existed.
 */
describe('spawnDetached’s log file', () => {
  /** The child is detached, so its bytes land after we return. */
  const settled = async (path: string): Promise<string> => {
    for (let turn = 0; turn < 100; turn += 1) {
      try {
        const text = readFileSync(path, 'utf8');
        if (text !== '') return text;
      } catch {
        /* not there yet */
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return '';
  };

  it('carries the child’s stdout to the file, not to nowhere', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-detached-'));
    // A path one level deeper than anything that exists: the support directory
    // is created by whoever gets there first, and the launcher may not be it.
    const logFile = join(dir, 'nested', 'daemon.log');

    spawnDetached({ execPath: '/bin/echo', args: ['listening on a socket'], logFile });

    expect(await settled(logFile)).toContain('listening on a socket');
  });

  it('carries stderr too — a crash writes there, not to stdout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-detached-'));
    const logFile = join(dir, 'daemon.log');

    spawnDetached({
      execPath: '/bin/sh',
      args: ['-c', 'echo unhandledRejection 1>&2'],
      logFile,
    });

    expect(await settled(logFile)).toContain('unhandledRejection');
  });

  it('rolls a log that has grown past its cap aside instead of growing forever', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-detached-'));
    const logFile = join(dir, 'daemon.log');
    writeFileSync(logFile, 'x'.repeat(9 * 1024 * 1024));

    spawnDetached({ execPath: '/bin/echo', args: ['a fresh run'], logFile });

    const text = await settled(logFile);
    expect(text).toContain('a fresh run');
    // The new log is the new run's, and the old one is still readable beside it.
    expect(text.length).toBeLessThan(1024);
    expect(statSync(`${logFile}.1`).size).toBe(9 * 1024 * 1024);
  });

  it('still spawns when the log cannot be opened at all', async () => {
    // Diagnostics must never be the reason a terminal does not open. `/dev/null`
    // is a file, so a path UNDER it can never be created.
    const marker = join(mkdtempSync(join(tmpdir(), 'shepherd-detached-')), 'ran');

    expect(() =>
      spawnDetached({
        execPath: '/bin/sh',
        args: ['-c', `echo ran > '${marker}'`],
        logFile: '/dev/null/nope/daemon.log',
      }),
    ).not.toThrow();

    expect(await settled(marker)).toContain('ran');
  });
});
