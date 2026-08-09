#!/usr/bin/env node
// `pnpm smoke` — the M0 gate.
//
// One run of the real built app proves the milestone claim end to end (see
// `packages/app/src/main/smoke-m0.ts` for the assertions). This runner adds the
// two things only a runner can check:
//
//   1. **The app leaves nothing behind — but the DAEMON does, on purpose.**
//      Since R1 the ptys live in `shepherdd`, so quitting the app must NOT kill
//      them; that is the whole milestone. The runner therefore asserts both
//      halves, which is strictly stronger than the "they must be gone" this
//      replaced: after the app exits the pids are still ALIVE, and after the
//      daemon is stopped they are gone. A terminal app that leaks a shell per
//      window is still a bug you notice a week later in Activity Monitor — the
//      leak just has a different owner now.
//   2. **It runs twice, back to back, into the SAME userData directory.** That
//      is the only way to catch a leaked single-instance lock: if run 1 left an
//      Electron alive, run 2 exits with the second-instance code instead of
//      doing anything. A fresh directory per run would hide exactly that.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  alive,
  build,
  check,
  electronBinary,
  electronEnv,
  entry,
  finish,
  killStrays,
  strayCount,
} from './smoke-lib.mjs';

const FLAG = '--shepherd-smoke=m0';

if (!process.argv.includes('--no-build')) build();
killStrays(FLAG);

// ONE directory, reused. See (2) above.
const userData = mkdtempSync(join(tmpdir(), 'shepherd-v2-m0-'));

try {
  for (const pass of [1, 2]) {
    /**
     * A support directory PER PASS, unlike userData.
     *
     * The sockets — control, hooks and, since R1, the daemon's — are derived
     * from it, so sharing one across the passes would have pass 2 adopt pass 1's
     * daemon and see FOUR live sessions where it asserts two. Sharing it with
     * the machine (which this runner did until R1, having no `--shepherd-support`
     * at all) is worse: the smoke drives the daily app's ptys.
     *
     * userData stays shared, because the leaked single-instance lock that the
     * two passes exist to catch is keyed on it.
     */
    const support = mkdtempSync(join(tmpdir(), `shepherd-v2-m0-sup${pass}-`));
    // The layout persists (M3 D3), and this smoke asserts "the app opens with
    // ONE pane" — but pass 1 splits and quits via `app.quit()`, so `will-quit`
    // flushes a two-pane tree. Drop the database, keep the DIRECTORY: the leaked
    // single-instance lock this reuse exists to catch is keyed on the directory,
    // so the property survives and the assertion stops being a lie.
    rmSync(join(userData, 'store.db'), { force: true });
    const result = spawnSync(
      electronBinary,
      [entry, FLAG, `--shepherd-user-data=${userData}`, `--shepherd-support=${support}`],
      {
        encoding: 'utf8',
        timeout: 90_000,
        // SIGKILL, not the default SIGTERM. Measured, while proving that an ESM
        // preload cannot load in a sandboxed renderer: the app hung with no
        // window and no error line, and it then IGNORED the SIGTERM this
        // timeout sends — the run was still alive seventeen minutes later. A
        // timeout that the thing it is bounding can decline is not a timeout.
        killSignal: 'SIGKILL',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: electronEnv(),
      },
    );
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    process.stdout.write(output.replace(/^/gm, `  [run ${pass}] `));

    check(result.status === 0, `run ${pass} exited 0 (got ${result.status})`);
    // An exit code alone is not enough: an Electron main process ends ZERO for
    // reasons nobody wrote down (an unhandled rejection, a window event), so
    // the pass condition is the code AND the line the smoke itself writes.
    check(output.includes('smoke: OK'), `run ${pass} reported OK`);
    check(output.includes('lock=true'), `run ${pass} got the single-instance lock`);

    const pids = (/pids=([\d,]+)/.exec(output)?.[1] ?? '')
      .split(',')
      .filter((p) => p !== '')
      .map(Number);
    check(pids.length === 2, `run ${pass} reported its two pty pids (${pids.join(', ') || 'none'})`);
    check(strayCount(FLAG) === 0, `run ${pass} left no stray Electron`);

    // THE R1 claim, from the outside: the app is gone and its ptys are not.
    await sleep(500);
    check(
      pids.every((pid) => alive(pid)),
      `run ${pass}: the ptys SURVIVED the app quitting (${pids.map((p) => `${p}:${alive(p) ? 'alive' : 'GONE'}`).join(' ')})`,
    );

    // …and the other half: stopping the daemon takes them with it, so nothing
    // is leaked. Matched on this pass's own socket path, so nothing else on the
    // machine is touched.
    // `socket=`, NOT `--socket=`: a pkill pattern starting with `--` is parsed as
    // an OPTION and matches nothing, silently. Measured — the daemon was never
    // being killed, and the assertion below read as "the daemon does not clean
    // up its ptys" when it does.
    spawnSync('pkill', ['-f', `socket=${support}/session.sock`], { stdio: 'ignore' });
    await sleep(700);
    check(
      pids.every((pid) => !alive(pid)),
      `run ${pass}: stopping the daemon left no stray shells (${pids.map((p) => `${p}:${alive(p) ? 'ALIVE' : 'gone'}`).join(' ')})`,
    );
    rmSync(support, { recursive: true, force: true });
  }
} finally {
  killStrays(FLAG);
  rmSync(userData, { recursive: true, force: true });
}

finish('M0');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
