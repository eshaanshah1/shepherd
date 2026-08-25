#!/usr/bin/env node
// The editor smoke: a real repo's files, listed, read, written and diffed
// through the real command registry.
//
// It builds its own git repo, because a fixture that borrowed a real one would
// make the smoke's result depend on the machine it ran on — and because the one
// thing this exists to assert is what GIT says about ignored files, which needs
// a real `.gitignore` and a real index.
//
// The in-app half is `packages/app/src/main/smoke-editor.ts`; this side only
// builds the fixture and reports the exit.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, check, electronBinary, electronEnv, entry, finish, killStrays } from './smoke-lib.mjs';

const FLAG = '--shepherd-smoke=editor';

if (!process.argv.includes('--no-build')) build();
killStrays(FLAG);

const userData = mkdtempSync(join(tmpdir(), 'shepherd-v2-editor-'));
const support = mkdtempSync(join(tmpdir(), 'shepherd-v2-editor-sup-'));
const repo = mkdtempSync(join(tmpdir(), 'shepherd-v2-editor-repo-'));
// A throwaway HOME for the same reason m3 takes one: extensions write there.
const home = mkdtempSync(join(tmpdir(), 'shepherd-v2-editor-home-'));
writeFileSync(join(home, '.claude.json'), '{}\n');

// `-c user.*` per command: an unset user.name fails the commit, and gpgsign
// would block it on a passphrase prompt with no UI to answer (v1's lesson).
const git = (...args) =>
  spawnSync(
    'git',
    ['-c', 'user.email=smoke@shepherd', '-c', 'user.name=smoke', '-c', 'commit.gpgsign=false', ...args],
    { cwd: repo, encoding: 'utf8' },
  );

const file = (rel, text) => {
  mkdirSync(join(repo, rel, '..'), { recursive: true });
  writeFileSync(join(repo, rel), text);
};

git('init', '-q');

/*
 * The fixture is shaped entirely around the one decision this asserts: an
 * ignored FILE is in the tree and an ignored DIRECTORY is not.
 *
 *   .env             ignored, and the file you opened the editor to change
 *   node_modules/    ignored, and must never be enumerated
 *   src/app.ts       tracked, and modified after the commit
 *   untracked.ts     untracked, so `--no-index` has something to diff
 */
file('.gitignore', 'node_modules/\n.env\n');
file('src/app.ts', 'export const app = "original";\n');
// A nested package, so the pane can be opened on a SUBDIRECTORY — where
// `git status` and `git ls-files` disagree about what a path is relative to.
file('pkg/lib.ts', 'export const lib = "original";\n');
git('add', '-A');
git('commit', '-qm', 'first');

file('src/app.ts', 'export const app = "changed";\n');
file('pkg/lib.ts', 'export const lib = "changed";\n');
file('pkg/fresh.ts', 'export const fresh = 1;\n');
file('untracked.ts', 'export const fresh = 1;\n');
file('.env', 'SECRET=1\n');
mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');

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
      `--shepherd-editor-repo=${repo}`,
      `--shepherd-editor-sub=${join(repo, 'pkg')}`,
    ],
    {
      encoding: 'utf8',
      timeout: 120_000,
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
check(output.includes('editor: done'), 'the editor smoke ran to the end');
/*
 * The extension being COMPILED IN, not merely registered. A manifest in
 * `main/index.ts` with no module in `builtins.ts` boots an app that is silently
 * missing the feature — how this extension's first build shipped, and
 * `worktree-hook`'s before it.
 */
check(!output.includes('no built-in module for shepherd.editor'), 'the editor module is in the build');

finish('editor');
