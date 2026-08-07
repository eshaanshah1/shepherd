#!/usr/bin/env node
// The M1 smoke: boot the real app and drive the KERNEL from outside the process.
//
// `hooks.sock` accepts an envelope and it reaches the bus with its own sequence;
// `control.sock` invokes a real layout command and the window changes; attention
// aggregates to a count. Every one of those is unit-tested already — the point of
// running it here is that the wires exist in the real app.
//
// Both a throwaway userData dir AND a throwaway support dir. The second is not
// tidiness: the sockets live under the support directory, which is derived from
// $HOME, so without `--shepherd-support` a smoke run would bind (or refuse to
// bind, having found live) the real instance's control socket.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, check, electronBinary, electronEnv, entry, finish, killStrays } from './smoke-lib.mjs';

const FLAG = '--shepherd-smoke=m1';

if (!process.argv.includes('--no-build')) build();
killStrays(FLAG);

const userData = mkdtempSync(join(tmpdir(), 'shepherd-v2-m1-'));
const support = mkdtempSync(join(tmpdir(), 'shepherd-v2-m1-sup-'));
let output = '';
let status = 1;

try {
  const result = spawnSync(
    electronBinary,
    [entry, FLAG, `--shepherd-user-data=${userData}`, `--shepherd-support=${support}`],
    {
      encoding: 'utf8',
      timeout: 120_000,
      // See `smoke-m0.mjs`: a hung Electron declines SIGTERM.
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
  killStrays(FLAG);
  rmSync(userData, { recursive: true, force: true });
  rmSync(support, { recursive: true, force: true });
}

// An exit code alone is not enough: an Electron main process can end for reasons
// nobody wrote down, and a run that never reached the assertions would exit 0.
check(status === 0, `the app exited 0 (got ${status})`);
check(output.includes('smoke: OK'), 'the smoke reported OK');
check(!output.includes('smoke: FAIL'), 'no check failed');
check(
  output.includes('the kernel answered on both sockets'),
  'both sockets were actually exercised (not an early return)',
);

finish('m1');
