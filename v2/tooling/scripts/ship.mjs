#!/usr/bin/env node
/**
 * `pnpm ship` — put what is in this checkout into the app you use.
 *
 * The loop it replaces is eight commands, one of which (`pnpm install`) is easy
 * to forget and leaves the test suite failing in files nobody touched — the
 * pack hook swaps the workspace links for compiled copies and something has to
 * put them back.
 *
 * **It survives killing the app it is running inside.** A session is a `node-pty`
 * child of the app's main process, so shipping from an agent's pane means the
 * process running this script dies partway through. So the slow part (build,
 * package, restore links) happens here, and the swap-and-relaunch is handed to a
 * DETACHED shell script that waits for the app to exit, replaces the bundle and
 * reopens it. Same shape as v1's updater, for the same reason.
 *
 * What it does NOT do is preserve your agents. Main's code is in the bundle
 * being replaced, so this is the restart tier. The other tier — renderer-only —
 * is `pnpm dev`, where Vite reloads the page and the ptys keep running; the
 * packaged app cannot use it because it loads the renderer from inside
 * `app.asar`, which is the file being swapped.
 *
 *   pnpm ship          → Shep,       to /Applications/Shep.app
 *   pnpm ship --dev    → Shep Night, to /Applications/Shep Night.app
 *
 * `--dev` is the one to reach for while iterating: it leaves your daily Shep and
 * everything running in it alone.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const isDev = process.argv.includes('--dev');
/**
 * Restart the daemon as part of the swap, instead of leaving it running.
 *
 * The daemon is detached to outlive the app and `reclaimSocketPath` REFUSES to
 * take over a live socket, so a second one can never start while the first
 * lives: a new build talks to the old daemon until that process dies. Nothing
 * drains — the staleness is sticky, not transient.
 *
 * So this is a genuine either/or rather than a safety flag. Without it your ptys
 * and agents survive the swap (the §7b promise) and the daemon keeps running the
 * PREVIOUS bundle's session code. With it every ship installs everything, and
 * every session dies. The default is survival, and the note printed after the
 * swap is what stops the trade being invisible.
 */
const restartDaemon = process.argv.includes('--restart-daemon');
const name = isDev ? 'Shep Night' : 'Shep';
const installed = `/Applications/${name}.app`;
const built = join(root, 'packages/app/release/mac-arm64', `${name}.app`);

/**
 * The daemon's pids, told apart from the window by ARGV.
 *
 * Both run from the same bundle and so share an executable name; only the daemon
 * entrypoint distinguishes them. Used to report what survived, and to end it
 * under `--restart-daemon`.
 */
function daemonPids() {
  const found = spawnSync('pgrep', ['-x', name], { encoding: 'utf8' });
  const pids = (found.stdout ?? '').split('\n').filter((line) => line.trim() !== '');
  return pids.filter((pid) => {
    const argv = spawnSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8' });
    return (argv.stdout ?? '').includes('out/daemon/main.js');
  });
}

const say = (line) => process.stdout.write(`ship: ${line}\n`);

/**
 * Every command runs with NODE_OPTIONS unset.
 *
 * An ambient one makes Electron exit **9** before running a line of our code,
 * and the symptom is every step failing at once with nothing to explain why.
 */
function run(command, args) {
  const { NODE_OPTIONS: _dropped, ...env } = process.env;
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env });
  if (result.status !== 0) {
    say(`FAILED: ${command} ${args.join(' ')}`);
    process.exit(result.status ?? 1);
  }
}

/*
 * Said UP FRONT, because it is the one thing about a ship somebody might want to
 * stop for — and because the swapper's own output goes to a log file the pane
 * that started it usually does not outlive.
 */
const daemonsBefore = daemonPids();
if (daemonsBefore.length > 0) {
  say(
    restartDaemon
      ? `daemon ${daemonsBefore.join(' ')} will be ENDED — every session in it dies`
      : `daemon ${daemonsBefore.join(' ')} will survive, still running the current bundle`,
  );
  if (!restartDaemon) say('  (daemon-side changes will not land until it restarts — see the note at the end)');
}

say(`building ${name}…`);
run('pnpm', ['--filter', '@shepherd/app', isDev ? 'package:dev' : 'package']);

/**
 * The links, before anything else can go wrong.
 *
 * `beforePack` replaces `packages/app/node_modules/@shepherd/*` with compiled
 * copies, and the next renderer build resolves those instead of source and fails
 * on a file the stage does not contain. The pack hook restores them on its own
 * exit too; this is the belt to that pair of braces, and it costs a few seconds.
 */
say('restoring the workspace links…');
run('pnpm', ['install', '--silent']);

/**
 * The swap, detached.
 *
 * `pgrep -x` on the executable name, which is the product name — so shipping
 * Shep Night never waits on (or reopens) your daily Shep. The loop exits
 * immediately when the app is not running, which is the ordinary case for a
 * first install.
 *
 * `ditto` rather than `cp -R`: it preserves the bundle's symlinks and resource
 * forks, and it is what the installed app has to be for macOS to accept it.
 */
const log = join(tmpdir(), 'shep-ship.log');
const script = join(mkdtempSync(join(tmpdir(), 'shep-ship-')), 'swap.sh');
writeFileSync(
  script,
  [
    '#!/bin/bash',
    'set -e',
    // Everything below is invisible — the parent is detached with stdio ignored,
    // and it usually outlives the pane that started it. A branch that ends in
    // "and then nothing happened" has to say why somewhere.
    `exec >>${JSON.stringify(log)} 2>&1`,
    `echo "--- $(date '+%F %T') swap ${name}"`,
    /*
     * The quit lives HERE, and repeats.
     *
     * It used to be one `osascript` from the parent beside a `pgrep` loop that
     * only watched, and that pair loses twice. A quit that is refused (no
     * Automation permission) is silent, so the loop waits for an app nobody
     * asked to leave; and a `pgrep` poll cannot tell "gone" from "gone and
     * relaunched between two polls" — which is exactly what a user reopening
     * from the Dock does, and it left the swapper waiting forever on an app that
     * had already restarted from the OLD bundle. `ship` had printed success half
     * an hour earlier. Asking again every cycle covers both: a relaunch is asked
     * to leave too, and the wait is bounded so a refusal is reported instead of
     * being waited out.
     */
    /*
     * The wait watches the GUI app ONLY, and the daemon is excluded by its argv.
     *
     * MEASURED, and it made `ship` unable to finish at all: the daemon runs from
     * the same bundle and so has the same executable name, so `pgrep -x` matched
     * it — but `quit app` addresses a GUI application and cannot touch a
     * background process, so the loop asked something that could never answer and
     * duly hit its own deadline. The window had exited within seconds; the swap
     * never happened, and the log reported "still running" about a process nobody
     * meant. `/Applications` was left holding the OLD bundle with the app shut.
     *
     * The daemon is EXPECTED to outlive a swap — it is what keeps ptys alive
     * across a restart (§7b) — so waiting on it is not a stricter version of the
     * right check, it is the wrong check. Its argv carries the daemon entrypoint,
     * which is the only thing separating two processes that share a name.
     */
    'gui_running() {',
    `  for pid in $(pgrep -x ${JSON.stringify(name)} || true); do`,
    '    if ps -o command= -p "$pid" | grep -q \'out/daemon/main.js\'; then continue; fi',
    '    return 0',
    '  done',
    '  return 1',
    '}',
    // The same split, the other way round. `if` rather than `&&`, so a grep that
    // finds nothing cannot end the function on a non-zero status under `set -e`.
    'daemon_pids() {',
    '  local found=""',
    `  for pid in $(pgrep -x ${JSON.stringify(name)} || true); do`,
    '    if ps -o command= -p "$pid" | grep -q \'out/daemon/main.js\'; then found="$found $pid"; fi',
    '  done',
    '  echo "$found"',
    '}',
    'deadline=$((SECONDS + 120))',
    'while gui_running; do',
    '  if (( SECONDS > deadline )); then',
    `    echo "gave up: ${name}'s window is still running after 120s — quit it and re-run pnpm ship"`,
    '    exit 1',
    '  fi',
    `  osascript -e 'quit app ${JSON.stringify(name)}' >/dev/null 2>&1 || true`,
    '  sleep 2',
    'done',
    'survivors="$(daemon_pids)"',
    ...(restartDaemon
      ? [
          /*
           * Ended BEFORE the bundle goes, so it dies while the code it is running
           * still exists on disk. A daemon whose asar has been deleted under it is
           * a process that fails on its next lazy `require`, at a moment nobody
           * can connect to this.
           */
          'if [ -n "$survivors" ]; then',
          '  echo "ending the daemon:$survivors"',
          '  kill $survivors 2>/dev/null || true',
          '  for _ in 1 2 3 4 5 6 7 8 9 10; do',
          '    [ -z "$(daemon_pids)" ] && break',
          '    sleep 1',
          '  done',
          '  remaining="$(daemon_pids)"',
          '  if [ -n "$remaining" ]; then kill -9 $remaining 2>/dev/null || true; fi',
          '  echo "the daemon is gone; the new bundle will start a fresh one"',
          'fi',
        ]
      : []),
    `rm -rf ${JSON.stringify(installed)}`,
    `ditto ${JSON.stringify(built)} ${JSON.stringify(installed)}`,
    `xattr -cr ${JSON.stringify(installed)} || true`,
    `open ${JSON.stringify(installed)}`,
    `echo "swapped and reopened ${installed}"`,
    /*
     * What survived, said out loud.
     *
     * A daemon from the previous bundle keeps serving the ptys, the session
     * protocol, the store and the remote data path, and NOTHING else reports it:
     * `reclaimSocketPath` will not let a second daemon start, so this one is not
     * phased out — it is the only daemon until it dies. The protocol version is
     * the one skew that announces itself, and it only moves on a breaking change.
     */
    ...(restartDaemon
      ? []
      : [
          'if [ -n "$survivors" ]; then',
          '  echo "NOTE — daemon$survivors still runs the PREVIOUS bundle"',
          '  echo "       it serves the ptys, sessions, store and remote path"',
          '  echo "       your agents survived; daemon-side changes did NOT land"',
          '  echo "       to load them: pnpm ship --restart-daemon  (ends every session)"',
          'fi',
        ]),
  ].join('\n'),
  { mode: 0o755 },
);

/**
 * The relaunch gets an ALLOW-LIST, not this process's environment.
 *
 * `open` hands the app the environment of whoever called it, and this script is
 * usually called from an agent's pane — so shipping from a sandboxed Claude Code
 * session baked that sandbox's `HTTPS_PROXY` and its throwaway CA into the app,
 * which then copied them into every pane it opened. The proxy dies with the
 * session; the app keeps pointing at it, and every `claude` launched afterwards
 * fails to verify its token. (`shell.ts` strips these at the pane seam too — this
 * is the half that keeps them out of the app in the first place, so its own
 * network is clean as well.)
 *
 * A deny-list would have to enumerate the vocabulary of every tool that might
 * have launched us. Nothing below needs more than a PATH and an identity.
 */
const RELAUNCH_ENV = Object.fromEntries(
  ['PATH', 'HOME', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'LANG']
    .map((key) => [key, process.env[key]])
    .filter(([, value]) => value !== undefined),
);

say(`swapping ${installed} and relaunching once ${name} exits`);
spawn('/bin/bash', [script], { detached: true, stdio: 'ignore', env: RELAUNCH_ENV }).unref();

// The swapper asks it to quit, repeatedly, and says so in the log — see the
// script. Nothing is done here, so there is no window in which the app can exit
// before anything is watching for it.
say(`${name} is on its way back — this pane's own agent went with it`);
say(`if it does not come back, the swapper says why: ${log}`);
