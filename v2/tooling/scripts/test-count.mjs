#!/usr/bin/env node
// "The test count moved" is the bar every phase is held to, so it needs a
// mechanical form — eyeballing a green run is how a suite that compiles but
// never runs passes for a week. Prints `<files> files, <tests> tests` and a
// per-package breakdown, and exits non-zero if any package reports zero
// (a package with no tests is a vacuous pass, not a pass).

import { spawnSync } from 'node:child_process';

const result = spawnSync('pnpm', ['-r', 'test'], { encoding: 'utf8' });
const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

const perPackage = new Map();
for (const line of output.split('\n')) {
  // e.g. "packages/sdk test:       Tests  12 passed (12)"
  const match = /^(\S+) test:\s+Tests\s+(\d+) passed/.exec(line.trim());
  if (match) perPackage.set(match[1], Number(match[2]));
}

let total = 0;
for (const [pkg, count] of perPackage) {
  process.stdout.write(`${pkg}: ${count}\n`);
  total += count;
}
process.stdout.write(`TOTAL ${total} tests across ${perPackage.size} packages\n`);

if (result.status !== 0) {
  process.stdout.write('FAIL: `pnpm -r test` exited non-zero\n');
  process.exit(result.status ?? 1);
}
if (perPackage.size === 0 || [...perPackage.values()].some((n) => n === 0)) {
  process.stdout.write('FAIL: a package reported no passing tests\n');
  process.exit(1);
}
