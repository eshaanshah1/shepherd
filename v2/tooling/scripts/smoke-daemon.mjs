#!/usr/bin/env node
// `pnpm smoke:daemon` — R1's gate: quit the app, and your agents are still there.
//
// TWO passes against the SAME userData and the SAME support directory, with the
// app fully exited in between. That is the whole point: a fresh directory per
// pass would restore nothing and a fresh support dir would reach a different
// daemon, so the reuse IS the test.
//
// What only a runner can check sits between the passes — with no app running at
// all, the pty must still be alive.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alive, build, check, electronBinary, electronEnv, entry, finish, killStrays, strayCount } from './smoke-lib.mjs';

if (!process.argv.includes('--no-build')) build();
killStrays('--shepherd-smoke=daemon-');

const userData = mkdtempSync(join(tmpdir(), 'shepherd-v2-daemon-'));
const support = mkdtempSync(join(tmpdir(), 'shepherd-v2-daemon-sup-'));

const run = (flag) => {
  const result = spawnSync(
    electronBinary,
    [entry, flag, `--shepherd-user-data=${userData}`, `--shepherd-support=${support}`],
    {
      encoding: 'utf8',
      timeout: 150_000,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: electronEnv(),
    },
  );
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  process.stdout.write(output.replace(/^/gm, `  [${flag.split('=')[1]}] `));
  return { status: result.status ?? 1, output };
};

const field = (output, key) => new RegExp(`${key}=([^\\s]+)`).exec(output)?.[1] ?? '';

try {
  const one = run('--shepherd-smoke=daemon-1');
  check(one.status === 0 && one.output.includes('smoke: OK'), 'pass 1 reported OK');
  const session1 = field(one.output, 'session');
  const pane1 = field(one.output, 'pane');
  const pid1 = Number(field(one.output, 'pid'));
  check(session1 !== '' && pid1 > 0, `pass 1 reported its session (${session1.slice(0, 8)}) and pty pid (${pid1})`);

  killStrays('--shepherd-smoke=daemon-1');
  check(strayCount('--shepherd-smoke=daemon-1') === 0, 'pass 1’s app is gone');
  await new Promise((r) => setTimeout(r, 800));

  // THE claim, from outside any app: nothing of ours is running, and the pty is.
  check(alive(pid1), `the pty SURVIVED with no app running at all (pid ${pid1})`);

  const two = run('--shepherd-smoke=daemon-2');
  check(two.status === 0 && two.output.includes('smoke: OK'), 'pass 2 reported OK');
  const session2 = field(two.output, 'session');
  const pane2 = field(two.output, 'pane');
  const pid2 = Number(field(two.output, 'pid'));

  // Adopted, not recreated — the two ids are the load-bearing assertions.
  check(session2 === session1, `pass 2 REATTACHED the same session (${session1.slice(0, 8)} vs ${session2.slice(0, 8)})`);
  check(pane2 === pane1, `the pane kept its id across the restart (${pane1.slice(0, 8)} vs ${pane2.slice(0, 8)})`);
  check(pid2 === pid1, `it is the same pty, not a lookalike (${pid1} vs ${pid2})`);
} finally {
  // `socket=`, not `--socket=`: a pkill pattern starting with `--` is parsed as
  // an option and matches nothing.
  spawnSync('pkill', ['-f', `socket=${support}/session.sock`], { stdio: 'ignore' });
  killStrays('--shepherd-smoke=daemon-');
  rmSync(userData, { recursive: true, force: true });
  rmSync(support, { recursive: true, force: true });
}

finish('daemon');
