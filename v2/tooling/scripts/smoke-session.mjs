#!/usr/bin/env node
// Runs packages/app/src/main/smoke-session.ts under the real Electron binary.
//
// The entry is TypeScript and there is no build step: Electron 43 ships Node
// 24.18.1, whose type stripping is on by default, and pnpm's workspace symlinks
// realpath out of node_modules so the imported `@shepherd/core` sources are
// stripped too (measured on this machine). `erasableSyntaxOnly` in
// tsconfig.base.json is what keeps that true — a non-erasable construct fails
// typecheck rather than surprising this script at runtime.
//
// The throwaway userData dir is not tidiness. Chromium keys the single-instance
// lock off it, so a stray Electron from a previous run would hold the lock and
// this one would report lock=false and hang. Hence: a fresh mkdtemp every run,
// and a pre-kill of anything still holding one of ours.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { electronEnv } from './smoke-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..', '..', 'packages', 'app');
const requireFromApp = createRequire(join(appDir, 'package.json'));
const electronBinary = requireFromApp('electron');
const entry = join(appDir, 'src', 'main', 'smoke-session.ts');

// Pre-kill strays from an earlier interrupted run (matched on our own entry
// path, so nothing else on the machine is touched).
spawnSync('pkill', ['-f', 'smoke-session.ts'], { stdio: 'ignore' });

const userData = mkdtempSync(join(tmpdir(), 'shepherd-v2-smoke-'));
let status = 1;
try {
  const result = spawnSync(
    electronBinary,
    [entry, `--shepherd-user-data=${userData}`],
    { stdio: 'inherit', timeout: 60_000, env: electronEnv() },
  );
  status = result.status ?? 1;
} finally {
  rmSync(userData, { recursive: true, force: true });
}
process.exit(status);
