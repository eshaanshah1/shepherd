// Shared plumbing for the smoke runners: where the app is, how to build it,
// how to kill strays, and how to say a thing passed.
//
// The stray-killing is not tidiness. Chromium keys the single-instance lock off
// the userData directory, so one Electron left over from an interrupted run
// makes the next run report `lock=false` and — before this phase — hang. Every
// runner therefore uses a throwaway userData dir AND pre-kills anything still
// carrying one of our own flags.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const root = join(here, '..', '..');
export const appDir = join(root, 'packages', 'app');
export const entry = join(appDir, 'out', 'main', 'index.js');
export const electronBinary = createRequire(join(appDir, 'package.json'))('electron');

/** Exit code `bootstrap.ts` uses when another copy owns the userData dir. */
export const EXIT_SECOND_INSTANCE = 2;

/**
 * The environment an Electron spawn may inherit.
 *
 * `NODE_OPTIONS` is dropped because Electron **refuses to boot** on flags it
 * does not allow there — `electron: --openssl-legacy-provider is not allowed in
 * NODE_OPTIONS`, exit 9, before any of our code runs. Whoever set it did so for
 * some unrelated node tool, and the failure looks nothing like its cause: every
 * check in the runner fails at once with no app output to explain why.
 * `shellDefaults` already strips the same variable for *sessions*; this is the
 * same lesson one process earlier.
 */
export function electronEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_OPTIONS;
  return env;
}

export function build({ mode } = {}) {
  const args = ['--filter', '@shepherd/app', 'build'];
  if (mode) args.push('--mode', mode);
  const result = spawnSync('pnpm', args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    process.stdout.write(`smoke: FAIL build${mode ? ` (--mode ${mode})` : ''} exited ${result.status}\n`);
    process.exit(result.status ?? 1);
  }
  if (!existsSync(entry)) {
    process.stdout.write(`smoke: FAIL no build at ${entry}\n`);
    process.exit(1);
  }
}

export function killStrays(pattern) {
  spawnSync('pkill', ['-f', pattern], { stdio: 'ignore' });
}

export function strayCount(pattern) {
  const found = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
  if (found.status !== 0) return 0;
  return found.stdout.split('\n').filter((line) => line.trim() !== '').length;
}

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process EXISTS and we are not allowed to signal it —
    // which is "alive", not "gone". A bare `catch { return false }` reports
    // every such process as dead, so the stray check passes on anything it
    // cannot touch. Measured: `process.kill(1, 0)` raises EPERM here, and the
    // control that was supposed to fail this check passed instead.
    return error.code === 'EPERM';
  }
}

let failures = 0;

export function check(condition, description) {
  if (condition) {
    process.stdout.write(`smoke: ok — ${description}\n`);
  } else {
    failures += 1;
    process.stdout.write(`smoke: FAIL ${description}\n`);
  }
  return condition;
}

export function finish(label) {
  if (failures > 0) {
    process.stdout.write(`smoke: FAIL ${label} — ${failures} failed check(s)\n`);
    process.exit(1);
  }
  process.stdout.write(`smoke: OK ${label}\n`);
  process.exit(0);
}
