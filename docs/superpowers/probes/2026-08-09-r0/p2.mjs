// Probe 2: what does a host-side headless emulator COST?
//
// The design puts one @xterm/headless per live session in the host process.
// Three numbers decide whether that is affordable:
//   1. throughput  — MB/s of pty output the emulator can absorb
//   2. serialize() — how long a snapshot takes (it is on the attach path)
//   3. memory      — RSS per terminal with a full scrollback
//
// Reference point: the ring buffer this replaces is 256 KB/session and ~free.

import headless from '@xterm/headless';
const { Terminal } = headless;
import serializeMod from '@xterm/addon-serialize';
const { SerializeAddon } = serializeMod;

const write = (t, data) => new Promise((r) => t.write(data, r));

function makeTerm(scrollback) {
  const t = new Terminal({ cols: 120, rows: 40, allowProposedApi: true, scrollback });
  const s = new SerializeAddon();
  t.loadAddon(s);
  return { t, s };
}

// --- 1. throughput -----------------------------------------------------------
// Two shapes, because they stress different paths: plain text (the common case)
// and heavy SGR churn (what an agent's coloured, redrawing TUI actually emits).
async function throughput(label, chunk, chunks) {
  const { t } = makeTerm(5000);
  const bytes = Buffer.byteLength(chunk) * chunks;
  const started = process.hrtime.bigint();
  for (let i = 0; i < chunks; i++) await write(t, chunk);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  t.dispose();
  return { label, mb: +(bytes / 1e6).toFixed(2), ms: +ms.toFixed(1), mbPerSec: +((bytes / 1e6) / (ms / 1000)).toFixed(1) };
}

const plain = 'the quick brown fox jumps over the lazy dog 0123456789\r\n'.repeat(20);
const sgr = Array.from({ length: 20 }, (_, i) =>
  `\x1b[38;5;${i % 256}m\x1b[48;5;${(i * 7) % 256}m\x1b[1mstyled row ${i}\x1b[0m\r\n`).join('');
const redraw = '\x1b[H' + Array.from({ length: 40 }, (_, y) =>
  `\x1b[${y + 1};1H\x1b[K\x1b[3${y % 8}m` + 'x'.repeat(100)).join('') + '\x1b[0m';

const results = [];
results.push(await throughput('plain-text', plain, 2000));
results.push(await throughput('heavy-sgr', sgr, 2000));
results.push(await throughput('full-screen-redraw', redraw, 3000));

// --- 2. serialize() cost -----------------------------------------------------
// Measured at the scrollback depths a real attach would ask for.
const serializeCosts = [];
for (const scrollback of [0, 1000, 5000]) {
  const { t, s } = makeTerm(5000);
  await write(t, Array.from({ length: 6000 }, (_, i) =>
    `\x1b[3${i % 8}mline ${i} with some reasonably typical terminal content here\x1b[0m\r\n`).join(''));
  // Warm, then measure a handful — this is on the attach path, not a hot loop.
  s.serialize({ scrollback });
  const started = process.hrtime.bigint();
  const runs = 20;
  let size = 0;
  for (let i = 0; i < runs; i++) size = Buffer.byteLength(s.serialize({ scrollback }));
  const ms = Number(process.hrtime.bigint() - started) / 1e6 / runs;
  serializeCosts.push({ scrollback, msPerCall: +ms.toFixed(2), snapshotKB: +(size / 1024).toFixed(1) });
  t.dispose();
}

// --- 3. memory per terminal --------------------------------------------------
// 30 terminals, each with a full 5000-line scrollback — a heavy but real fleet.
if (global.gc) global.gc();
const before = process.memoryUsage().heapUsed;
const fleet = [];
const FLEET = 30;
for (let i = 0; i < FLEET; i++) {
  const { t, s } = makeTerm(5000);
  await write(t, Array.from({ length: 5200 }, (_, n) =>
    `\x1b[3${n % 8}msession ${i} line ${n} — content of a realistic width for a working pane\x1b[0m\r\n`).join(''));
  fleet.push({ t, s });
}
if (global.gc) global.gc();
const after = process.memoryUsage().heapUsed;

console.log(JSON.stringify({
  throughput: results,
  serialize: serializeCosts,
  memory: {
    terminals: FLEET,
    scrollbackLines: 5000,
    heapDeltaMB: +((after - before) / 1e6).toFixed(1),
    perTerminalMB: +(((after - before) / FLEET) / 1e6).toFixed(2),
    rssMB: +(process.memoryUsage().rss / 1e6).toFixed(1),
  },
}, null, 2));

for (const f of fleet) f.t.dispose();
