#!/usr/bin/env node
// The P0 proof: node-pty loads and a real PTY spawns, echoes and exits.
// Kept as a script (not a vitest case) so it can be run against the *Electron*
// runtime too — `electron tooling/scripts/pty-proof.mjs` is the ABI check, and
// a failure here must never be mistaken later for a SessionHost bug.

import { spawn } from 'node-pty';

const term = spawn('/bin/sh', ['-c', 'echo ok'], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env,
});

let out = '';
term.onData((d) => {
  out += d;
});
term.onExit(({ exitCode }) => {
  const saw = out.includes('ok');
  process.stdout.write(`pty: exitCode=${exitCode} sawOutput=${saw} bytes=${JSON.stringify(out)}\n`);
  process.exit(saw ? 0 : 1);
});

setTimeout(() => {
  process.stdout.write('pty: TIMEOUT — no exit within 5s\n');
  process.exit(1);
}, 5000).unref?.();
