#!/usr/bin/env node
// `pnpm smoke:single-instance` — two copies, one userData directory.
//
// Instance A takes the lock and stays alive. Instance B is then launched
// against the SAME directory and must exit promptly with the second-instance
// code. "Promptly" is half the claim: the failure mode measured on this machine
// was not a wrong exit code but a HANG — a stray Electron held the lock, the
// next launch reported `lock=false`, and then sat there with no window and no
// message until somebody killed it. A test that only checked the code would
// have waited out its own timeout and reported a failure that named the wrong
// thing.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXIT_SECOND_INSTANCE,
  alive,
  build,
  check,
  electronBinary,
  entry,
  finish,
  electronEnv,
  killStrays,
  strayCount,
} from './smoke-lib.mjs';

const FLAG = '--shepherd-smoke=hold';
const B_DEADLINE_MS = 15_000;

if (!process.argv.includes('--no-build')) build();
killStrays(FLAG);

const userData = mkdtempSync(join(tmpdir(), 'shepherd-v2-lock-'));
const args = [entry, FLAG, `--shepherd-user-data=${userData}`];

let a;
try {
  // --- A: take the lock and hold it.
  a = spawn(electronBinary, args, { stdio: ['ignore', 'pipe', 'pipe'], env: electronEnv() });
  const gotLock = await waitForLine(a, /lock=true/, 30_000);
  check(gotLock !== null, `instance A took the lock (${gotLock ?? 'never said so'})`);

  // --- B: same directory, while A is alive.
  const started = Date.now();
  const b = spawnSync(electronBinary, args, {
    encoding: 'utf8',
    timeout: B_DEADLINE_MS,
    env: electronEnv(),
    // See `smoke-m0.mjs`: a hung Electron declines SIGTERM.
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const elapsed = Date.now() - started;
  const output = `${b.stdout ?? ''}${b.stderr ?? ''}`;
  process.stdout.write(output.replace(/^/gm, '  [B] '));

  // Measured, while planting a "never exits" defect: Electron handles the
  // SIGTERM `spawnSync`'s timeout sends and exits ZERO with `signal` null — so
  // "was it killed?" is not answerable from the result object, and only the
  // clock can tell a prompt exit from the runner's own deadline.
  check(
    elapsed < B_DEADLINE_MS,
    `instance B exited on its own rather than on the runner's ${B_DEADLINE_MS}ms deadline (${elapsed}ms)`,
  );
  check(
    b.status === EXIT_SECOND_INSTANCE,
    `instance B exited ${EXIT_SECOND_INSTANCE} (second instance), got ${b.status}`,
  );
  check(elapsed < 10_000, `instance B exited promptly rather than hanging (${elapsed}ms)`);
  check(output.includes('lock=false'), 'instance B said the lock was refused');
  check(
    output.includes('another instance owns'),
    'instance B named the directory that is taken, instead of exiting in silence',
  );
  check(a.exitCode === null, 'instance A is still running — B did not disturb it');

  // --- and the lock is released when A goes: a third try must succeed.
  a.kill('SIGTERM');
  // 20s, not 10s. Measured after M3: instance A spends ~7s starting — four
  // built-ins now activate, and the last of them forks the extension host —
  // before it can even process the quit, so a 10s budget was being eaten by
  // startup and failed roughly one run in four. The budget is for SHUTDOWN and
  // has to outlive the startup it queues behind; it scales with the number of
  // extensions, which is why it is a generous constant rather than a tight one.
  await waitForExit(a, 20_000);
  check(!alive(a.pid), 'instance A is gone');

  const c = spawnSync(electronBinary, [...args, '--shepherd-print-paths'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: electronEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  check(c.status === 0, `a later launch into the freed directory starts fine (got ${c.status})`);
} finally {
  if (a && a.exitCode === null) a.kill('SIGKILL');
  killStrays(FLAG);
  rmSync(userData, { recursive: true, force: true });
}

check(strayCount(FLAG) === 0, 'no stray instances left behind');
finish('single-instance');

// ----------------------------------------------------------------- helpers

function waitForLine(child, pattern, timeoutMs) {
  return new Promise((resolve) => {
    let buffer = '';
    const timer = setTimeout(() => resolve(null), timeoutMs);
    const onChunk = (chunk) => {
      buffer += String(chunk);
      process.stdout.write(String(chunk).replace(/^/gm, '  [A] '));
      const line = buffer.split('\n').find((l) => pattern.test(l));
      if (line !== undefined) {
        clearTimeout(timer);
        resolve(line.trim());
      }
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
