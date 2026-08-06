#!/usr/bin/env node
// node-pty 1.1.0's darwin prebuild ships `spawn-helper` with mode 0644 and its
// own install script only cleans `build/Release`, so every pty.spawn() throws
// `Error: posix_spawnp failed.` with nothing pointing at a file mode. Measured
// twice; this runs from v2's own postinstall so a fresh clone is never one
// unexplainable error away from a working terminal.
//
// Companion trap (closed in package.json, not here): pnpm >= 10 ignores
// dependency lifecycle scripts unless they are listed in
// pnpm.onlyBuiltDependencies — without that, node-pty is not even built.

import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HELPERS = ['spawn-helper'];

function log(msg) {
  process.stdout.write(`[fix-node-pty-perms] ${msg}\n`);
}

/** Every node-pty copy pnpm's virtual store holds (there can be more than one). */
function nodePtyRoots(workspaceRoot) {
  const roots = [];
  const direct = join(workspaceRoot, 'node_modules', 'node-pty');
  if (existsSync(direct)) roots.push(direct);

  const store = join(workspaceRoot, 'node_modules', '.pnpm');
  if (existsSync(store)) {
    for (const entry of readdirSync(store)) {
      if (!entry.startsWith('node-pty@')) continue;
      const p = join(store, entry, 'node_modules', 'node-pty');
      if (existsSync(p)) roots.push(p);
    }
  }
  return roots;
}

function main() {
  if (process.platform !== 'darwin') {
    log(`platform ${process.platform}: nothing to do`);
    return;
  }

  const workspaceRoot = process.cwd();
  const roots = nodePtyRoots(workspaceRoot);
  if (roots.length === 0) {
    // Not an error: `pnpm install --ignore-scripts` or a pre-dependency state.
    log('no node-pty found under node_modules — skipping');
    return;
  }

  let fixed = 0;
  let alreadyOk = 0;
  for (const root of roots) {
    const dir = join(root, 'prebuilds', `${process.platform}-${process.arch}`);
    for (const helper of HELPERS) {
      const file = join(dir, helper);
      if (!existsSync(file)) {
        log(`MISSING ${file} — a pty.spawn() will fail; check the prebuild`);
        continue;
      }
      const mode = statSync(file).mode & 0o777;
      if ((mode & 0o111) === 0o111) {
        alreadyOk += 1;
        continue;
      }
      chmodSync(file, 0o755);
      fixed += 1;
      log(`chmod +x ${file} (was ${mode.toString(8)})`);
    }
  }
  log(`done: ${fixed} fixed, ${alreadyOk} already executable`);
}

main();
