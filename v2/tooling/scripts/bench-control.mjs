#!/usr/bin/env node
// What a command costs over `control.sock`, measured rather than asserted.
//
// The core/UI isolation design (§6) made a claim about this number, then
// measured it, and was wrong in BOTH directions. So the number lives in a script
// that anybody can re-run against a build, rather than in a sentence somebody
// has to believe. It exists to answer one question before a change lands: did
// the wire contract every client shares get slower.
//
// It spawns its OWN app instance with throwaway directories, for the reason
// every smoke does: benchmarking the daily driver measures whatever that app
// happens to be doing, and two runs a day apart are not comparable.
//
//   node tooling/scripts/bench-control.mjs [--no-build] [--iterations 3000]
//
// The command it times is a KERNEL handler (`layout.listRoots`) and an
// EXTENSION-HOST one (`diagnostics.ping`), because those are two different cost
// classes: the second pays the utility-process hop whatever the transport is,
// and conflating them is how "the socket is slow" gets said about a number that
// is mostly a port.

import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { Agent } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, electronBinary, electronEnv, entry, killStrays } from './smoke-lib.mjs';

const FLAG = '--shepherd-bench=control';
const iterations = Number(argOf('--iterations') ?? 3000);
const warmup = 300;

if (!process.argv.includes('--no-build')) build();
killStrays(FLAG);

const userData = mkdtempSync(join(tmpdir(), 'shepherd-bench-'));
const support = mkdtempSync(join(tmpdir(), 'shepherd-bench-sup-'));
const home = mkdtempSync(join(tmpdir(), 'shepherd-bench-home-'));
writeFileSync(join(home, '.claude.json'), '{}\n');

const socket = join(support, 'control.sock');

const child = spawn(
  electronBinary,
  [
    entry,
    FLAG,
    `--shepherd-user-data=${userData}`,
    `--shepherd-support=${support}`,
    `--shepherd-home=${home}`,
  ],
  { env: electronEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
);
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});

// One kept-alive connection, because that is what a real client has. Dialling
// per call would measure connect() and report it as the protocol's cost.
const agent = new Agent({ keepAlive: true, maxSockets: 1 });

try {
  await waitForSocket();
  const results = [];
  for (const [label, command] of [
    ['kernel handler (layout.listRoots)', 'layout.listRoots'],
    ['extension-host handler (diagnostics.ping)', 'diagnostics.ping'],
  ]) {
    const reachable = await invoke(command);
    if (!reachable.ok) {
      process.stdout.write(`bench: SKIP ${label} — ${JSON.stringify(reachable.error)}\n`);
      continue;
    }
    for (let i = 0; i < warmup; i++) await invoke(command);
    const samples = [];
    for (let i = 0; i < iterations; i++) {
      const started = process.hrtime.bigint();
      await invoke(command);
      samples.push(Number(process.hrtime.bigint() - started) / 1000);
    }
    results.push({ label, ...summarise(samples) });
  }

  process.stdout.write(`\nbench: ${iterations} kept-alive /invoke calls per row\n`);
  for (const row of results) {
    process.stdout.write(
      `bench: ${row.label.padEnd(42)} p50 ${µs(row.p50)}  p90 ${µs(row.p90)}  p99 ${µs(row.p99)}  max ${µs(row.max)}\n`,
    );
  }
} finally {
  agent.destroy();
  child.kill('SIGKILL');
  killStrays(FLAG);
  for (const dir of [userData, support, home]) rmSync(dir, { recursive: true, force: true });
}

function argOf(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function µs(value) {
  return `${value.toFixed(1)}µs`.padStart(9);
}

function summarise(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return { p50: at(0.5), p90: at(0.9), p99: at(0.99), max: sorted[sorted.length - 1] };
}

async function waitForSocket() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (existsSync(socket)) {
      const answer = await invoke('layout.listRoots').catch(() => null);
      if (answer !== null) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`no control socket at ${socket} after 90s`);
}

function invoke(command, args = {}) {
  const body = JSON.stringify({
    command,
    args,
    // The entitlement a local socket client gets — the same one `shepherd` uses.
    caller: { kind: 'device', deviceId: 'local-cli' },
  });
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: socket,
        path: '/invoke',
        method: 'POST',
        agent,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(text));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
