#!/usr/bin/env node
// Bundle `shepherdd` into the app's `out/`, beside main and preload.
//
// **Why it must be bundled at all**, since the app runs TypeScript elsewhere:
// the daemon is launched as `electron --as-node <entry>`, and Node's type
// stripping deliberately refuses files under `node_modules`. Every workspace
// package resolves through a `node_modules` symlink, so `@shepherd/core` — the
// daemon's whole reason to exist — cannot be loaded from source. Measured: the
// daemon started, threw before its first line of our code, and the app reported
// only "the session daemon did not come up within 10000ms", because a detached
// child with `stdio: 'ignore'` has nowhere to say why.
//
// `node-pty` stays EXTERNAL. It is a native module; bundling it would inline a
// `require` of a `.node` binary that no longer sits where the bundle thinks. It
// is resolved at runtime from the app's own node_modules, which is exactly where
// the Electron build already puts it.

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const out = join(root, 'packages', 'app', 'out', 'daemon', 'main.js');

await build({
  entryPoints: [join(root, 'packages', 'daemon', 'src', 'main.ts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  // Electron 43 carries node 24; matching it means no downlevelling of syntax
  // the runtime already has.
  target: 'node24',
  format: 'esm',
  external: ['node-pty'],
  // The entry guards on `process.argv[1]` ending in main.ts/main.js, so the
  // bundle keeps the name the guard expects.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'warning',
});

process.stdout.write(`built shepherdd -> ${out}\n`);
