// Probe 6: does the mirror COST or SAVE, once background panes stop streaming?
//
// The claim to test: today every mounted pane keeps a live xterm.js — parsing,
// rendering, and holding a 5000-line scrollback — even when hidden, because a
// pane that stopped listening could never catch up. With a host-authoritative
// screen a hidden pane can drop its terminal and re-materialize from a snapshot,
// so only VISIBLE panes stream.
//
// Honest limits of this measurement:
//   - Rendering cannot be measured headless. It is the largest term in the
//     current model and it is removed for background panes, so every number
//     below is a LOWER BOUND on the saving.
//   - @xterm/headless is the same parser xterm.js uses, so it stands in for the
//     renderer's parse cost fairly.

import headless from '@xterm/headless';
const { Terminal } = headless;
import serializeMod from '@xterm/addon-serialize';
const { SerializeAddon } = serializeMod;

const PANES = 20;              // a realistic busy fleet
const VISIBLE = 1;             // one pane on screen
const RENDERER_SCROLLBACK = 5000;   // what xterm-terminal.ts actually sets today
const MIRROR_SCROLLBACK = 1000;     // the design's default
const AGENT_BYTES_PER_SEC = 200_000; // the generous per-agent rate

function makeTerm(scrollback) {
  const t = new Terminal({ cols: 120, rows: 40, allowProposedApi: true, scrollback });
  const s = new SerializeAddon();
  t.loadAddon(s);
  return { t, s };
}
const feed = (t, chunks) => new Promise((resolve) => {
  for (let i = 0; i < chunks.length - 1; i++) t.write(chunks[i]);
  t.write(chunks.at(-1), resolve);
});

const line = (i) => `\x1b[3${i % 8}magent output line ${i} doing some real work here\x1b[0m\r\n`;
const burst = Array.from({ length: 400 }, (_, i) => line(i));

// --- parse throughput, to price one parse -----------------------------------
async function parseCostMs(scrollback) {
  const { t } = makeTerm(scrollback);
  await feed(t, burst);                       // warm
  const chunks = Array.from({ length: 4000 }, (_, i) => line(i));
  const bytes = chunks.reduce((n, c) => n + Buffer.byteLength(c), 0);
  const started = process.hrtime.bigint();
  await feed(t, chunks);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  t.dispose();
  return { msPerMB: (ms / (bytes / 1e6)) };
}
const { msPerMB } = await parseCostMs(MIRROR_SCROLLBACK);

// --- memory held by a terminal at each scrollback depth ----------------------
async function memPerTerminal(scrollback, n) {
  if (global.gc) global.gc();
  const before = process.memoryUsage().heapUsed;
  const held = [];
  for (let i = 0; i < n; i++) {
    const { t, s } = makeTerm(scrollback);
    await feed(t, Array.from({ length: scrollback + 200 }, (_, k) => line(k)));
    held.push({ t, s });
  }
  if (global.gc) global.gc();
  const mb = (process.memoryUsage().heapUsed - before) / 1e6 / n;
  const snapshotKB = Buffer.byteLength(held[0].s.serialize({ scrollback: MIRROR_SCROLLBACK })) / 1024;
  for (const h of held) h.t.dispose();
  if (global.gc) global.gc();
  return { mbPerTerminal: mb, snapshotKB };
}

const rendererTerm = await memPerTerminal(RENDERER_SCROLLBACK, 8);
const mirrorTerm = await memPerTerminal(MIRROR_SCROLLBACK, 8);

// --- the two accountings ----------------------------------------------------
const mbPerSecAllPanes = (PANES * AGENT_BYTES_PER_SEC) / 1e6;

const current = {
  parsesPerByte: PANES,                                  // every pane parses everything
  cpuMsPerSec: mbPerSecAllPanes * msPerMB,               // renderer-side, all panes
  rendererMemMB: PANES * rendererTerm.mbPerTerminal,     // in the PAGE
  hostMemMB: PANES * 0.256,                              // the 256 KB ring each
  ipcMBPerSec: mbPerSecAllPanes,                         // every byte crosses to the page
  renderingPanes: PANES,                                 // ← not measurable here; the big term
};

const proposed = {
  parsesPerByte: PANES + VISIBLE,                        // host mirror + visible pane only
  cpuMsPerSec: mbPerSecAllPanes * msPerMB                // host mirrors: all panes
             + (VISIBLE * AGENT_BYTES_PER_SEC / 1e6) * msPerMB,  // renderer: visible only
  rendererMemMB: VISIBLE * rendererTerm.mbPerTerminal,
  hostMemMB: PANES * mirrorTerm.mbPerTerminal,
  ipcMBPerSec: (VISIBLE * AGENT_BYTES_PER_SEC) / 1e6,    // only the visible pane streams
  renderingPanes: VISIBLE,
};

const pct = (a, b) => `${(((b - a) / a) * 100).toFixed(0)}%`;

console.log(JSON.stringify({
  measured: {
    msPerMBParsed: +msPerMB.toFixed(2),
    rendererTerminalMB_at5000: +rendererTerm.mbPerTerminal.toFixed(2),
    mirrorTerminalMB_at1000: +mirrorTerm.mbPerTerminal.toFixed(2),
    snapshotKB: +mirrorTerm.snapshotKB.toFixed(1),
  },
  assumptions: { PANES, VISIBLE, AGENT_BYTES_PER_SEC },
  current: {
    cpuMsPerSec: +current.cpuMsPerSec.toFixed(1),
    percentOfOneCore: +(current.cpuMsPerSec / 10).toFixed(2),
    rendererMemMB: +current.rendererMemMB.toFixed(1),
    hostMemMB: +current.hostMemMB.toFixed(1),
    ipcMBPerSec: +current.ipcMBPerSec.toFixed(2),
    panesRendering: current.renderingPanes,
  },
  proposed: {
    cpuMsPerSec: +proposed.cpuMsPerSec.toFixed(1),
    percentOfOneCore: +(proposed.cpuMsPerSec / 10).toFixed(2),
    rendererMemMB: +proposed.rendererMemMB.toFixed(1),
    hostMemMB: +proposed.hostMemMB.toFixed(1),
    ipcMBPerSec: +proposed.ipcMBPerSec.toFixed(2),
    panesRendering: proposed.renderingPanes,
  },
  delta: {
    cpu: pct(current.cpuMsPerSec, proposed.cpuMsPerSec),
    rendererMem: pct(current.rendererMemMB, proposed.rendererMemMB),
    hostMem: pct(current.hostMemMB, proposed.hostMemMB),
    ipc: pct(current.ipcMBPerSec, proposed.ipcMBPerSec),
    rendering: `${current.renderingPanes} panes -> ${proposed.renderingPanes} (not measured; the largest term)`,
    costToSwitchPanes: `one ${(+mirrorTerm.snapshotKB).toFixed(0)} KB snapshot`,
  },
}, null, 2));
