#!/usr/bin/env node
// The M3 smoke: a task is real work on disk, and it survives being shelved.
//
// The milestone's exit criterion under the plan's cut — created through the same
// transport an agent uses (the control socket), provisioned into real git
// worktrees, archived and restored with its uncommitted work intact. Every hop
// is unit-tested; none of those tests spans it, which is the gap this closes.
//
// It builds its own git repo, because a fixture that borrowed a real one would
// make the smoke's result depend on the machine it ran on.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, check, electronBinary, electronEnv, entry, finish, killStrays } from './smoke-lib.mjs';

const FLAG = '--shepherd-smoke=m3';

if (!process.argv.includes('--no-build')) build();
killStrays(FLAG);

const userData = mkdtempSync(join(tmpdir(), 'shepherd-v2-m3-'));
const support = mkdtempSync(join(tmpdir(), 'shepherd-v2-m3-sup-'));
const repo = mkdtempSync(join(tmpdir(), 'shepherd-v2-m3-repo-'));
// A throwaway HOME as well as a throwaway support dir, because `ctx.homeDir` is
// written to: `tasks` pre-seeds Claude Code's trust record for every task root
// it generates, and without this the smoke would leave records for a dozen
// deleted temp directories in the developer's own ~/.claude.json on every run.
const home = mkdtempSync(join(tmpdir(), 'shepherd-v2-m3-home-'));
// An empty but VALID config, because that is the case the seeding is for: the
// extension refuses to create a `.claude.json` that is not there (a machine
// that has never run Claude Code has no agent to unblock), so a run with no
// file would assert nothing.
writeFileSync(join(home, '.claude.json'), '{}\n');

// `-c user.*` per command: an unset user.name fails the commit, and gpgsign
// would block it on a passphrase prompt with no UI to answer (v1's lesson).
const git = (...args) =>
  spawnSync('git', ['-c', 'user.email=smoke@shepherd', '-c', 'user.name=smoke', '-c', 'commit.gpgsign=false', ...args], {
    cwd: repo,
    encoding: 'utf8',
  });
git('init', '-q', '.');
writeFileSync(join(repo, 'README.md'), 'hello\n');
writeFileSync(join(repo, 'gone.txt'), 'delete me\n');
git('add', '-A');
git('commit', '-qm', 'init');

let output = '';
let status = 1;

try {
  const result = spawnSync(
    electronBinary,
    [
      entry,
      FLAG,
      `--shepherd-user-data=${userData}`,
      `--shepherd-support=${support}`,
      `--shepherd-home=${home}`,
      `--shepherd-m3-repo=${repo}`,
    ],
    {
      encoding: 'utf8',
      timeout: 180_000,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: electronEnv(),
    },
  );
  output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  status = result.status ?? 1;
  process.stdout.write(output);
} finally {
  rmSync(userData, { recursive: true, force: true });
  rmSync(support, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
}

check(status === 0, `electron exited ${status}`);
check(output.includes('smoke: OK m3'), 'the m3 smoke reported OK');
check(output.includes('ok — the worktree and the task root are on disk'), 'the task became real work');
check(
  output.includes('ok — the generated directories are pre-trusted'),
  'a spawned agent will not open on Claude Code’s trust dialog',
);
check(
  output.includes('ok — the repo’s worktree hook ran before the task root was built'),
  'the repo’s worktree hook ran in its worktree, under a real shell',
);
check(output.includes('ok — the round trip is byte-identical'), 'archive/restore kept the work');
check(output.includes('ok — creating a task alerted nobody'), 'the silence held');
finish('m3');
