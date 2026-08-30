#!/usr/bin/env node
// The takeover smoke: the window, MEASURED.
//
// Every defect this exists for was a layout defect and every one was invisible
// to a unit test — the composer opening behind the band, the terminal's first
// line clipped under it, the `Ship` button off the right edge. jsdom has no
// layout, so a test there can prove an element is in the document and learn
// nothing about whether a person can see it or click it.
//
// The in-app half is `packages/app/src/main/smoke-takeover.ts`; this side only
// launches the real app and reports the exit.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, check, electronBinary, electronEnv, entry, finish, killStrays } from './smoke-lib.mjs';

const FLAG = '--shepherd-smoke=takeover';

if (!process.argv.includes('--no-build')) build();
killStrays(FLAG);

const userData = mkdtempSync(join(tmpdir(), 'shepherd-v2-take-'));
const support = mkdtempSync(join(tmpdir(), 'shepherd-v2-take-sup-'));
// A throwaway HOME for the reason every other smoke takes one: extensions write
// there, and a run must not leave records in the developer's own ~/.claude.json.
const home = mkdtempSync(join(tmpdir(), 'shepherd-v2-take-home-'));
writeFileSync(join(home, '.claude.json'), '{}\n');

let output = '';
let status = 1;

try {
  const result = spawnSync(
    electronBinary,
    [entry, FLAG, `--shepherd-user-data=${userData}`, `--shepherd-support=${support}`, `--shepherd-home=${home}`],
    {
      encoding: 'utf8',
      timeout: 120_000,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: electronEnv(),
    },
  );
  output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  status = result.status ?? 1;
  process.stdout.write(output);
} finally {
  rmSync(userData, { recursive: true, force: true });
  rmSync(support, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

check(status === 0, `electron exited ${status}`);
check(output.includes('takeover: done'), 'the takeover smoke ran to the end');
finish('takeover');
