#!/usr/bin/env node
// Runs pty-proof.mjs under the Electron binary, which is the check that
// actually matters: node and Electron are different ABIs, and a native module
// that loads under one can fail under the other. Measured to pass with
// node-pty's stock Node-API prebuild — no @electron/rebuild.
//
// The throwaway --user-data-dir is not tidiness: a stray Electron process holds
// the single-instance lock keyed to that directory, and the next run would then
// hang instead of failing.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
// electron lives in packages/app, not at the root — resolve from there.
const requireFromApp = createRequire(join(here, '..', '..', 'packages', 'app', 'package.json'));
const electronBinary = requireFromApp('electron'); // the module exports the binary's path

const userData = mkdtempSync(join(tmpdir(), 'shepherd-v2-ptyproof-'));
let status = 1;
try {
  const result = spawnSync(
    electronBinary,
    [join(here, 'pty-proof.mjs'), `--user-data-dir=${userData}`],
    { stdio: 'inherit' },
  );
  status = result.status ?? 1;
} finally {
  rmSync(userData, { recursive: true, force: true });
}
process.exit(status);
