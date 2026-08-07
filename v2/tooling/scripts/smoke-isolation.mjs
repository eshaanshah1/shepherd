#!/usr/bin/env node
// `pnpm smoke:isolation` — build the app twice and ask each build one question:
// which userData directory do you own?
//
// The dev build must answer with a dev-suffixed directory and the prod build
// with the plain one. That is what keeps a dev copy from taking the daily app's
// single-instance lock (Chromium keys the lock off this directory), and it is
// invisible from the outside: a build that always runs alone behaves the same
// either way.
//
// The second half matters as much as the first. `IS_DEV` must be a constant
// SUBSTITUTED INTO THE BUNDLE, not a runtime read — an env var or an argv flag
// is a switch anybody can flip to point a dev build at the production
// directory. So the bundle is also searched: the identifier must be gone, and
// the literal must be there.
//
// `--shepherd-print-paths` answers before any lock is requested, so this script
// never takes one and never creates a directory in ~/Library.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { build, check, electronBinary, entry, finish, killStrays } from './smoke-lib.mjs';

const FLAG = '--shepherd-print-paths';

function ask(mode) {
  build(mode === 'dev' ? { mode: 'development' } : {});
  const bundle = readFileSync(entry, 'utf8');
  const result = spawnSync(electronBinary, [entry, FLAG], {
    encoding: 'utf8',
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  process.stdout.write(output.replace(/^/gm, `  [${mode}] `));
  const line = output.split('\n').find((l) => l.includes('userData='));
  return {
    status: result.status,
    bundle,
    isDev: /isDev=(\w+)/.exec(line ?? '')?.[1],
    userData: /userData=(.*)$/.exec(line ?? '')?.[1],
  };
}

killStrays(FLAG);

const dev = ask('dev');
const prod = ask('prod');

check(dev.status === 0, `the dev build answers and exits 0 (got ${dev.status})`);
check(prod.status === 0, `the prod build answers and exits 0 (got ${prod.status})`);

check(dev.isDev === 'true', `the dev build reports IS_DEV=true (got ${dev.isDev})`);
check(prod.isDev === 'false', `the prod build reports IS_DEV=false (got ${prod.isDev})`);

check(
  (dev.userData ?? '').endsWith('Shepherd v2 (dev)'),
  `dev userData is a dev-suffixed directory: ${dev.userData}`,
);
check(
  (prod.userData ?? '').endsWith('Shepherd v2'),
  `prod userData is the plain directory: ${prod.userData}`,
);
check(dev.userData !== prod.userData, 'the two builds own DIFFERENT directories');

// Built constant, not a runtime read.
check(
  !dev.bundle.includes('__SHEPHERD_IS_DEV__'),
  'the dev bundle carries no __SHEPHERD_IS_DEV__ identifier (it was substituted)',
);
check(
  !prod.bundle.includes('__SHEPHERD_IS_DEV__'),
  'the prod bundle carries no __SHEPHERD_IS_DEV__ identifier (it was substituted)',
);
// The two bundles must actually differ, or the "substitution" did nothing.
check(dev.bundle !== prod.bundle, 'the two bundles differ — the constant really is baked in');
check(
  !/process\.env\[?['"`]?SHEPHERD_DEV/.test(prod.bundle),
  'nothing reads a SHEPHERD_DEV environment variable',
);

finish('isolation');
