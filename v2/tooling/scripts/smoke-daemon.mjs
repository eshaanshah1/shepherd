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
import { request } from 'node:http';
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
    [
      entry,
      flag,
      `--shepherd-user-data=${userData}`,
      `--shepherd-support=${support}`,
      // Forwarded to the daemon, so the reachability rule can be WATCHED rather
      // than waited a minute for.
      '--socket-check-ms=250',
    ],
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

/**
 * POST one hook envelope, exactly as `report.sh` would, to the daemon's socket.
 *
 * Used from HERE — between the two passes, with no app running — because that is
 * the whole claim: an agent finishing its turn while the app is being replaced.
 * Every in-app smoke necessarily has an app, so no in-app leg can reach this.
 */
function postHook(socket, sessionId, event, claudeSession) {
  const body = JSON.stringify({
    topic: 'claude.hook',
    session_id: sessionId,
    payload: { event, hook: { session_id: claudeSession } },
  });
  return new Promise((resolve) => {
    const req = request(
      {
        socketPath: socket,
        path: '/events',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', () => resolve(0));
    req.end(body);
  });
}

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

  /**
   * …and the daemon is still ACCEPTING agent hooks, with no app to hand them to.
   *
   * A 202 here is only possible if the daemon serves `hooks.sock` — while the app
   * owned it, this POST hit a dead socket and `report.sh` silently exited 0, which
   * is how every event fired during a restart was lost. Pass 2 then asserts the
   * consequence: this `Stop` ended the turn pass 1 started.
   */
  const hookSocket = `${support}/hooks.sock`;
  const status = await postHook(hookSocket, session1, 'Stop', 'claude-daemon-smoke-1');
  check(status === 202, `the daemon accepted a hook with NO app running (got ${status})`);

  const two = run('--shepherd-smoke=daemon-2');
  check(two.status === 0 && two.output.includes('smoke: OK'), 'pass 2 reported OK');
  const session2 = field(two.output, 'session');
  const pane2 = field(two.output, 'pane');
  const pid2 = Number(field(two.output, 'pid'));

  // Adopted, not recreated — the two ids are the load-bearing assertions.
  check(session2 === session1, `pass 2 REATTACHED the same session (${session1.slice(0, 8)} vs ${session2.slice(0, 8)})`);
  check(pane2 === pane1, `the pane kept its id across the restart (${pane1.slice(0, 8)} vs ${pane2.slice(0, 8)})`);
  check(pid2 === pid1, `it is the same pty, not a lookalike (${pid1} vs ${pid2})`);

  /**
   * And the leak the two passes above could never see: a daemon nobody can reach
   * must not keep its ptys for ever.
   *
   * Everything this file asserts rests on "sessions but no clients ⇒ never
   * exit", which is right for the restart between pass 1 and pass 2 and wrong
   * once the app is gone for good. Measured on one machine before this rule
   * existed: 51 abandoned daemons, 475 of macOS's 511 ptys consumed, every fresh
   * `pty create` failing. A smoke deletes its own support directory on the way
   * out — socket included — so this reproduces the exact condition.
   *
   * The `pkill` in the `finally` below is what used to be load-bearing here. It
   * stays as a belt for the case where the rule is broken; this check is what
   * says it is not.
   */
  const found = spawnSync('pgrep', ['-f', `socket=${support}/session.sock`], { encoding: 'utf8' });
  const daemonPid = Number(found.stdout.trim().split('\n')[0]);
  check(
    Number.isInteger(daemonPid) && daemonPid > 0 && alive(daemonPid),
    `the daemon is running with no app attached (pid ${daemonPid})`,
  );
  rmSync(`${support}/session.sock`, { force: true });
  // Its own interval plus room for the shutdown it triggers.
  const deadline = Date.now() + 10_000;
  while (alive(daemonPid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  check(!alive(daemonPid), 'a daemon whose socket is gone exits instead of holding its ptys for ever');
} finally {
  // `socket=`, not `--socket=`: a pkill pattern starting with `--` is parsed as
  // an option and matches nothing.
  spawnSync('pkill', ['-f', `socket=${support}/session.sock`], { stdio: 'ignore' });
  killStrays('--shepherd-smoke=daemon-');
  rmSync(userData, { recursive: true, force: true });
  rmSync(support, { recursive: true, force: true });
}

finish('daemon');
