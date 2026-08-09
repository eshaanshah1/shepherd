// Probe 3: throughput, measured correctly.
//
// p2 awaited every write. xterm's write() is asynchronous and drains on an
// internal timer, so awaiting each chunk measures ONE TIMER TICK PER CHUNK
// (~1.3ms), not parsing — the 0.8 MB/s it reported was the event loop, not the
// emulator. A pty pushes bytes without waiting, so: push everything, await the
// LAST callback (which fires once the whole queue has drained), measure that.
//
// Also measures the thing that actually matters for a fleet: N terminals fed
// concurrently, since they share one event loop in the host.

import headless from '@xterm/headless';
const { Terminal } = headless;
import serializeMod from '@xterm/addon-serialize';
const { SerializeAddon } = serializeMod;

function makeTerm(scrollback = 1000) {
  const t = new Terminal({ cols: 120, rows: 40, allowProposedApi: true, scrollback });
  const s = new SerializeAddon();
  t.loadAddon(s);
  return { t, s };
}

/** Push every chunk, then resolve when the LAST one has been parsed. */
function feed(t, chunks) {
  return new Promise((resolve) => {
    for (let i = 0; i < chunks.length - 1; i++) t.write(chunks[i]);
    t.write(chunks.at(-1), resolve);
  });
}

async function throughput(label, chunk, count) {
  const { t } = makeTerm(5000);
  const chunks = Array.from({ length: count }, () => chunk);
  const bytes = Buffer.byteLength(chunk) * count;
  const started = process.hrtime.bigint();
  await feed(t, chunks);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  t.dispose();
  return { label, mb: +(bytes / 1e6).toFixed(2), ms: +ms.toFixed(1), mbPerSec: +((bytes / 1e6) / (ms / 1000)).toFixed(1) };
}

const plain = 'the quick brown fox jumps over the lazy dog 0123456789\r\n'.repeat(20);
const sgr = Array.from({ length: 20 }, (_, i) =>
  `\x1b[38;5;${i % 256}m\x1b[48;5;${(i * 7) % 256}m\x1b[1mstyled row ${i}\x1b[0m\r\n`).join('');
const redraw = '\x1b[H' + Array.from({ length: 40 }, (_, y) =>
  `\x1b[${y + 1};1H\x1b[K\x1b[3${y % 8}m` + 'x'.repeat(100)).join('') + '\x1b[0m';

const single = [];
single.push(await throughput('plain-text', plain, 2000));
single.push(await throughput('heavy-sgr', sgr, 2000));
single.push(await throughput('full-screen-redraw', redraw, 3000));

// Concurrent fleet: 20 terminals all being fed at once, one event loop.
async function fleet(n, chunk, count) {
  const terms = Array.from({ length: n }, () => makeTerm(1000));
  const chunks = Array.from({ length: count }, () => chunk);
  const bytes = Buffer.byteLength(chunk) * count * n;
  const started = process.hrtime.bigint();
  await Promise.all(terms.map(({ t }) => feed(t, chunks)));
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  for (const { t } of terms) t.dispose();
  return { terminals: n, mbTotal: +(bytes / 1e6).toFixed(2), ms: +ms.toFixed(1), mbPerSec: +((bytes / 1e6) / (ms / 1000)).toFixed(1) };
}

const concurrent = await fleet(20, plain, 200);

// The realistic question: an agent streaming output. How much wall-clock does
// ONE SECOND of a chatty agent's output (~200 KB/s is generous) cost the host?
const oneSecondOfAgent = 200_000;
const perByteMs = single[1].ms / (single[1].mb * 1e6);   // use the SGR-heavy figure
console.log(JSON.stringify({
  single,
  concurrent,
  budget: {
    note: 'cost of absorbing one second of a chatty agent (200 KB/s), using the heavy-SGR rate',
    msOfCpuPerAgentSecond: +(oneSecondOfAgent * perByteMs).toFixed(2),
    percentOfOneCore: +((oneSecondOfAgent * perByteMs) / 1000 * 100).toFixed(2),
  },
}, null, 2));
