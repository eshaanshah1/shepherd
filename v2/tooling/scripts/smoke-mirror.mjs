#!/usr/bin/env node
// `pnpm smoke:mirror` — R0's claim against a real pty running a real full-screen
// program, and (since R1) across the daemon that owns it.
//
// Throwaway userData AND support dirs. The support dir is the load-bearing one:
// the control, hook and — since R1 — **session** sockets are all derived from
// it, so without `--shepherd-support` this run would talk to the daily app's
// daemon and drive its ptys. That is not hypothetical; it is what happened on
// the first run of this file, which connected to a daemon left behind by an
// earlier smoke and then timed out against it.
//
// It also kills the daemon it started. A daemon deliberately outlives its
// client, which is the milestone — so a smoke that did not clean up would leave
// one process per run, each holding a temp directory open.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, electronBinary, electronEnv, entry, killStrays } from './smoke-lib.mjs';

const FLAG = '--shepherd-smoke=mirror';

if (!process.argv.includes('--no-build')) build();
killStrays(FLAG);

const userData = mkdtempSync(join(tmpdir(), 'shepherd-v2-mirror-'));
const support = mkdtempSync(join(tmpdir(), 'shepherd-v2-mirror-sup-'));
let output = '';
let status = 1;

try {
  const result = spawnSync(
    electronBinary,
    [entry, FLAG, `--shepherd-user-data=${userData}`, `--shepherd-support=${support}`],
    {
      encoding: 'utf8',
      timeout: 180_000,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: electronEnv(),
    },
  );
  output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  status = result.status ?? 1;
} finally {
  // Matched on the socket path this run owns, so nothing else on the machine is
  // touched — including the user's real daemon. `socket=`, NOT `--socket=`: a
  // pkill pattern starting with `--` is parsed as an OPTION and matches nothing,
  // silently.
  spawnSync('pkill', ['-f', `socket=${support}/session.sock`], { stdio: 'ignore' });
  rmSync(userData, { recursive: true, force: true });
  rmSync(support, { recursive: true, force: true });
}

// An exit code alone is not enough: an Electron main process ends ZERO for
// reasons nobody wrote down. The pass condition is the code AND the last line
// the smoke itself writes.
if (status === 0 && !output.includes('smoke: OK')) {
  process.stdout.write('smoke: FAIL exited 0 without reporting OK\n');
  status = 1;
}
process.exit(status);
