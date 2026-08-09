// Probe 4: the ONE correctness contract the whole attachment design rests on.
//
// PtyFanout's existing rule is "snapshot, register and replay are one step" —
// split them and you get a gap or a duplicate. A host-side emulator makes that
// harder, because serialize() reflects only what has been PARSED, and xterm's
// write() is asynchronous: parsing lags the feed. So a naive
// `serialize(); addSink()` can miss bytes, and `addSink(); serialize()` can
// double them.
//
// The proposed algorithm:
//   1. at attach, start buffering live bytes for this sink (do not deliver)
//   2. write a zero-length BARRIER into the mirror and wait for its callback
//   3. in the callback, serialize() — this must equal exactly the bytes fed
//      BEFORE the barrier, and nothing fed after it
//   4. deliver [snapshot, ...buffered], then go live
//
// Step 3 is the assumption under test: does xterm's write queue really fire the
// barrier callback BEFORE parsing anything queued after it? If callbacks can
// fire late (after later chunks are parsed), the snapshot contains bytes that
// are ALSO in the buffer, and every attach under load double-prints.

import headless from '@xterm/headless';
const { Terminal } = headless;
import serializeMod from '@xterm/addon-serialize';
const { SerializeAddon } = serializeMod;

const t = new Terminal({ cols: 80, rows: 24, allowProposedApi: true, scrollback: 200 });
const s = new SerializeAddon();
t.loadAddon(s);

// Feed a stream of uniquely identifiable markers, with an attach happening
// mid-flight and MORE bytes arriving during the barrier window.
const BEFORE = 400;   // markers fed before the attach
const DURING = 400;   // markers fed after the attach, while the barrier is in flight

for (let i = 0; i < BEFORE; i++) t.write(`M${i}\r\n`);

const buffered = [];
let snapshot = null;

// Attach: begin buffering, drop the barrier in.
const barrier = new Promise((resolve) => t.write('', resolve));

// ...and keep the pty firing during the barrier window, which is the whole point.
for (let i = BEFORE; i < BEFORE + DURING; i++) {
  const chunk = `M${i}\r\n`;
  t.write(chunk);
  buffered.push(chunk);
}

await barrier;
snapshot = s.serialize({ scrollback: 200 });

// --- the assertions ---------------------------------------------------------
// The snapshot must contain the LAST marker fed before the attach, and must NOT
// contain the first marker fed after it.
const lastBefore = `M${BEFORE - 1}`;
const firstDuring = `M${BEFORE}`;

// Word-boundary match: "M399" must not be satisfied by "M3990".
const has = (hay, needle) => new RegExp(`${needle}(?![0-9])`).test(hay);

const containsLastBefore = has(snapshot, lastBefore);
const containsFirstDuring = has(snapshot, firstDuring);

// And the reconstruction — snapshot then buffered — must reproduce the full
// stream exactly once each, which is the property that matters to a viewer.
const replay = new Terminal({ cols: 80, rows: 24, allowProposedApi: true, scrollback: 2000 });
await new Promise((r) => replay.write(snapshot, r));
await new Promise((r) => { for (let i = 0; i < buffered.length - 1; i++) replay.write(buffered[i]); replay.write(buffered.at(-1), r); });

const text = [];
for (let y = 0; y < replay.buffer.active.length; y++) {
  const line = replay.buffer.active.getLine(y);
  if (line) text.push(line.translateToString(true));
}
const joined = text.join('\n');
const counts = {};
for (const m of joined.matchAll(/M(\d+)/g)) counts[m[0]] = (counts[m[0]] ?? 0) + 1;
const duplicated = Object.entries(counts).filter(([, n]) => n > 1).map(([k]) => k);

// Markers still inside the replay terminal's window (the oldest have scrolled
// off the 200-line scrollback of the SOURCE, so only check the tail).
const tailStart = BEFORE + DURING - 150;
const missing = [];
for (let i = tailStart; i < BEFORE + DURING; i++) if (!counts[`M${i}`]) missing.push(`M${i}`);

console.log(JSON.stringify({
  barrierIsExact: containsLastBefore && !containsFirstDuring,
  snapshotContainsLastByteBeforeAttach: containsLastBefore,
  snapshotContainsFirstByteAfterAttach_MUST_BE_FALSE: containsFirstDuring,
  snapshotKB: +(Buffer.byteLength(snapshot) / 1024).toFixed(1),
  bufferedChunks: buffered.length,
  duplicatedMarkersInReplay: duplicated,
  missingMarkersInReplayTail: missing,
  VERDICT: (containsLastBefore && !containsFirstDuring && duplicated.length === 0 && missing.length === 0)
    ? 'barrier algorithm is sound — no gap, no duplicate'
    : 'BARRIER ALGORITHM IS UNSOUND — redesign the attach path',
}, null, 2));
