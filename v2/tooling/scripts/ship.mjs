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
const name = isDev ? 'Shep Night' : 'Shep';
const installed = `/Applications/${name}.app`;
const built = join(root, 'packages/app/release/mac-arm64', `${name}.app`);

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
const script = join(mkdtempSync(join(tmpdir(), 'shep-ship-')), 'swap.sh');
writeFileSync(
  script,
  [
    '#!/bin/bash',
    'set -e',
    `while pgrep -x ${JSON.stringify(name)} >/dev/null; do sleep 0.2; done`,
    `rm -rf ${JSON.stringify(installed)}`,
    `ditto ${JSON.stringify(built)} ${JSON.stringify(installed)}`,
    `xattr -cr ${JSON.stringify(installed)} || true`,
    `open ${JSON.stringify(installed)}`,
  ].join('\n'),
  { mode: 0o755 },
);

say(`swapping ${installed} and relaunching once ${name} exits`);
spawn('/bin/bash', [script], { detached: true, stdio: 'ignore' }).unref();

/**
 * And ask it to quit — AFTER the swapper is watching, or the app can exit in the
 * gap and the loop never sees it running.
 *
 * `osascript` rather than `pkill`, so the app tears down its sessions the way a
 * ⌘Q does. If it is not running this is a no-op and the swap happens at once.
 */
spawnSync('osascript', ['-e', `quit app ${JSON.stringify(name)}`], { stdio: 'ignore' });
say(`${name} is on its way back — this pane's own agent went with it`);
