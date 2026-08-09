// Probe 1: does @xterm/headless + addon-serialize give a faithful, repaintable
// snapshot — including colour, scrollback and the ALT SCREEN (the case v1's
// byte-ring explicitly could not do)?
//
// Method: feed bytes into terminal A, serialize, feed the serialization into a
// fresh terminal B of the same size, and compare B's grid to A's, cell by cell
// including SGR attributes. A byte-ring replay would fail the alt-screen case.

import headless from '@xterm/headless';
const { Terminal } = headless;
import serializeMod from '@xterm/addon-serialize';
const { SerializeAddon } = serializeMod;

const COLS = 80, ROWS = 24;

function makeTerm(scrollback = 1000) {
  const t = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback });
  const s = new SerializeAddon();
  t.loadAddon(s);
  return { t, s };
}

const write = (t, data) => new Promise((r) => t.write(data, r));

/** Every cell of the active buffer, with the attributes that make it look right. */
function grid(t) {
  const buf = t.buffer.active;
  const out = [];
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const cells = [];
    for (let x = 0; x < t.cols; x++) {
      const c = line.getCell(x);
      if (!c) continue;
      cells.push([c.getChars(), c.getFgColor(), c.getBgColor(), c.isBold(), c.isInverse(), c.isUnderline()].join(''));
    }
    out.push(cells.join(''));
  }
  return out.join('\n');
}

const report = [];
async function scenario(name, bytes, { scrollback = 1000 } = {}) {
  const a = makeTerm(scrollback);
  await write(a.t, bytes);
  const serialized = a.s.serialize({ scrollback });

  const b = makeTerm(scrollback);
  await write(b.t, serialized);

  const ga = grid(a.t), gb = grid(b.t);
  const same = ga === gb;
  const cursorSame = a.t.buffer.active.cursorX === b.t.buffer.active.cursorX
    && a.t.buffer.active.cursorY === b.t.buffer.active.cursorY;
  const altSame = a.t.buffer.active.type === b.t.buffer.active.type;
  report.push({
    name,
    gridIdentical: same,
    cursorIdentical: cursorSame,
    bufferTypeA: a.t.buffer.active.type,
    bufferTypeB: b.t.buffer.active.type,
    altScreenPreserved: altSame,
    serializedBytes: Buffer.byteLength(serialized),
    linesA: a.t.buffer.active.length,
    linesB: b.t.buffer.active.length,
  });
  if (!same) {
    const la = ga.split('\n'), lb = gb.split('\n');
    for (let i = 0; i < Math.max(la.length, lb.length); i++) {
      if (la[i] !== lb[i]) { report.at(-1).firstDiffLine = i; break; }
    }
  }
}

// 1. Plain text + colour + bold.
await scenario('sgr-colour', '\x1b[31;1mhello\x1b[0m normal \x1b[42mbg\x1b[0m\r\n');

// 2. Enough output to push into scrollback.
await scenario('scrollback-200-lines',
  Array.from({ length: 200 }, (_, i) => `line ${i} \x1b[3${i % 8}mcoloured\x1b[0m\r\n`).join(''));

// 3. THE case that matters: alt screen, as vim/less use it. Enter 1049, draw,
//    leave the primary buffer's content behind it.
await scenario('alt-screen-vim-like',
  'primary content here\r\n'
  + '\x1b[?1049h'                       // enter alt screen
  + '\x1b[H\x1b[2J'                     // home + clear
  + '\x1b[1;1H~ \x1b[7mVIM-LIKE\x1b[0m' // draw something with inverse video
  + '\x1b[5;10Hediting a file'
  + '\x1b[10;1H\x1b[34m~\x1b[0m\r\n');

// 4. Wide chars + combining marks — the decoder boundary case.
await scenario('wide-and-combining', 'CJK: 日本語テキスト  emoji: 👩‍💻🎉  combining: é\r\n');

// 5. A cleared screen with the cursor parked mid-grid (prompt redraw shape).
await scenario('cursor-position', '\x1b[2J\x1b[H\x1b[12;40Hcursor here');

// 6. DECAWM / margins-ish: a long wrapped line.
await scenario('wrapped-line', 'x'.repeat(250) + '\r\n');

console.log(JSON.stringify(report, null, 2));
console.log('\nALL IDENTICAL:', report.every((r) => r.gridIdentical && r.cursorIdentical && r.altScreenPreserved));
