// Probe 5: fixing what probe 4 refuted.
//
// Probe 4's failure, precisely: `t.write('', resolve)` then `await barrier;
// serialize()` puts the serialize on a MICROTASK. xterm's _innerWrite fires the
// callback and then KEEPS PARSING synchronously, so by the time the awaiting
// continuation ran, 224 later chunks were already in the grid — and those same
// chunks were also in the buffered list. Every attach during a burst would
// double-print them.
//
// The fix under test: serialize INSIDE the callback, synchronously, so the
// snapshot is taken at the barrier's position in the queue and not a microtask
// later.
//
// Both orderings are measured:
//   A. all writes issued in ONE synchronous block (probe 4's shape — the worst
//      case, an attach landing inside a burst that is already queued)
//   B. writes spread across ticks (what a real pty does)

import headless from '@xterm/headless';
const { Terminal } = headless;
import serializeMod from '@xterm/addon-serialize';
const { SerializeAddon } = serializeMod;

const SCROLLBACK = 2000;   // big enough that nothing under test scrolls away

function makeTerm() {
  const t = new Terminal({ cols: 80, rows: 24, allowProposedApi: true, scrollback: SCROLLBACK });
  const s = new SerializeAddon();
  t.loadAddon(s);
  return { t, s };
}

const has = (hay, needle) => new RegExp(`${needle}(?![0-9])`).test(hay);

async function run(label, { spreadAcrossTicks }) {
  const { t, s } = makeTerm();
  const BEFORE = 300, DURING = 300;

  for (let i = 0; i < BEFORE; i++) t.write(`M${i}\r\n`);

  const buffered = [];
  let snapshot = null;

  // THE FIX: capture synchronously in the callback, at the barrier's own
  // position in the write queue.
  const captured = new Promise((resolve) => {
    t.write('', () => { snapshot = s.serialize({ scrollback: SCROLLBACK }); resolve(); });
  });

  for (let i = BEFORE; i < BEFORE + DURING; i++) {
    const chunk = `M${i}\r\n`;
    t.write(chunk);
    buffered.push(chunk);
    if (spreadAcrossTicks && i % 50 === 0) await new Promise((r) => setTimeout(r, 0));
  }

  await captured;

  const lastBefore = `M${BEFORE - 1}`;
  const firstDuring = `M${BEFORE}`;
  const containsLastBefore = has(snapshot, lastBefore);
  const containsFirstDuring = has(snapshot, firstDuring);

  // End-to-end: snapshot + buffered must reproduce every marker exactly once.
  const replay = new Terminal({ cols: 80, rows: 24, allowProposedApi: true, scrollback: SCROLLBACK });
  await new Promise((r) => replay.write(snapshot, r));
  await new Promise((r) => {
    for (let i = 0; i < buffered.length - 1; i++) replay.write(buffered[i]);
    replay.write(buffered.at(-1), r);
  });

  const lines = [];
  for (let y = 0; y < replay.buffer.active.length; y++) {
    const line = replay.buffer.active.getLine(y);
    if (line) lines.push(line.translateToString(true));
  }
  const counts = {};
  for (const m of lines.join('\n').matchAll(/M(\d+)/g)) counts[m[0]] = (counts[m[0]] ?? 0) + 1;
  const duplicated = Object.entries(counts).filter(([, n]) => n > 1).map(([k]) => k);
  const missing = [];
  for (let i = 0; i < BEFORE + DURING; i++) if (!counts[`M${i}`]) missing.push(`M${i}`);

  t.dispose(); replay.dispose();
  return {
    label,
    snapshotEndsAtBarrier: containsLastBefore && !containsFirstDuring,
    containsLastBeforeAttach: containsLastBefore,
    containsFirstAfterAttach_MUST_BE_FALSE: containsFirstDuring,
    duplicatedCount: duplicated.length,
    missingCount: missing.length,
    ok: containsLastBefore && !containsFirstDuring && duplicated.length === 0 && missing.length === 0,
  };
}

const results = [];
results.push(await run('A: burst already queued (probe 4 shape)', { spreadAcrossTicks: false }));
results.push(await run('B: bytes spread across ticks (real pty)', { spreadAcrossTicks: true }));

console.log(JSON.stringify(results, null, 2));
console.log('\nVERDICT:', results.every((r) => r.ok)
  ? 'synchronous-capture-in-callback is sound — no gap, no duplicate, in both orderings'
  : 'STILL UNSOUND');
