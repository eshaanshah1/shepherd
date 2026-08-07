#!/usr/bin/env node
// `pnpm smoke:terminal` — build the app, then drive the built app once.
//
// Unlike `smoke:session` this one CANNOT run the TypeScript sources directly:
// the preload and the renderer are loaded by Chromium, not by node, so neither
// gets Node 24's type stripping. So it builds first (electron-vite → out/) and
// launches `out/main/index.js`, which is also the path a shipped app takes.
//
// The throwaway userData dir is not tidiness. Chromium keys the single-instance
// lock off it, so a stray Electron from a previous run holds the lock and this
// one exits at startup with no window. Hence: a fresh mkdtemp every run, and a
// pre-kill of anything still holding one of ours.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { electronEnv } from './smoke-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const appDir = join(root, 'packages', 'app');
const requireFromApp = createRequire(join(appDir, 'package.json'));
const electronBinary = requireFromApp('electron');
const entry = join(appDir, 'out', 'main', 'index.js');

if (!process.argv.includes('--no-build')) {
  const built = spawnSync('pnpm', ['--filter', '@shepherd/app', 'build'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (built.status !== 0) process.exit(built.status ?? 1);
}
if (!existsSync(entry)) {
  process.stdout.write(`smoke: FAIL no build at ${entry}\n`);
  process.exit(1);
}

// Strays from an earlier interrupted run, matched on our own flag so nothing
// else on the machine is touched.
spawnSync('pkill', ['-f', 'shepherd-smoke=terminal'], { stdio: 'ignore' });

const userData = mkdtempSync(join(tmpdir(), 'shepherd-v2-term-'));
let status = 1;
let output = '';
try {
  const result = spawnSync(
    electronBinary,
    [entry, '--shepherd-smoke=terminal', `--shepherd-user-data=${userData}`],
    { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, encoding: 'utf8', env: electronEnv() },
  );
  output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  status = result.status ?? 1;
} finally {
  rmSync(userData, { recursive: true, force: true });
}

// An exit code alone is not enough. An Electron main process can end for
// reasons nobody wrote down — an unhandled rejection, a quit triggered by a
// window event — and it ends ZERO when it does. Measured: a planted defect made
// the smoke throw after four assertions and still exit 0. So the pass condition
// is the code AND the last line the smoke itself writes.
if (status === 0 && !output.includes('smoke: OK')) {
  process.stdout.write('smoke: FAIL exited 0 without reporting OK\n');
  status = 1;
}
process.exit(status);
