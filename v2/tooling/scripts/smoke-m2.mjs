#!/usr/bin/env node
// The M2 smoke: a stub agent's hooks drive a real state indicator.
//
// The milestone's exit criterion. Every hop in the chain is unit-tested and none
// of those tests spans it — which is exactly the gap v1's LAN bug lived in.
//
// Throwaway userData AND support dirs, for the reason smoke-m1 records: the
// sockets are derived from $HOME, so without `--shepherd-support` a run would
// bind the real instance's.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, check, electronBinary, electronEnv, entry, finish, killStrays } from './smoke-lib.mjs';

const FLAG = '--shepherd-smoke=m2';

if (!process.argv.includes('--no-build')) build();
killStrays(FLAG);

const userData = mkdtempSync(join(tmpdir(), 'shepherd-v2-m2-'));
const support = mkdtempSync(join(tmpdir(), 'shepherd-v2-m2-sup-'));
let output = '';
let status = 1;

try {
  const result = spawnSync(
    electronBinary,
    [entry, FLAG, `--shepherd-user-data=${userData}`, `--shepherd-support=${support}`],
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
} finally {
  rmSync(userData, { recursive: true, force: true });
  rmSync(support, { recursive: true, force: true });
}

process.stdout.write(output);

check(status === 0, `electron exited ${status}`);
check(output.includes('smoke: OK m2'), 'the m2 smoke reported OK');
// The legs that would silently pass if the chain were absent. Named here as
// well as in-process so a runner-level read of the log is enough to review.
check(output.includes('the indicator reaches the DOM'), 'the state reached the renderer');
check(output.includes('a watched turn raises NO banner'), 'ADR 0020 held on the real wire');

finish('m2');
