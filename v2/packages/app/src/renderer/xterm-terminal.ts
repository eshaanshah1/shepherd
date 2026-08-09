import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import {
  fonts,
  metrics,
  minimumContrastRatio,
  paneTitleSurface,
  xtermTheme,
  type ThemeMode,
} from '@shepherd/design-tokens';
import type { TerminalLike } from './pane-sessions.ts';
import { DEFAULT_THEME_MODE } from './theme.ts';
import '@xterm/xterm/css/xterm.css';

/**
 * The one file that knows what a terminal actually is.
 *
 * Everything else — the registry, the pane component, the tests — is written
 * against `TerminalLike`, so xterm's DOM measurement (which jsdom cannot do)
 * never sits between a lifecycle claim and the test that proves it.
 *
 * The grid is drawn from the SAME tokens as the chrome, but its row height is
 * the font's own line box: xterm's DOM renderer sizes `█ ▀ ▄` to `fontSize`, so
 * a multiplier above 1 pads the cell without growing the glyph and every block
 * row gets a seam.
 */
export function createXtermTerminal(mode: ThemeMode = DEFAULT_THEME_MODE): TerminalLike {
  const theme = xtermTheme(mode);
  const terminal = new Terminal({
    fontFamily: fonts.mono,
    fontSize: metrics.fontSize,
    lineHeight: 1,
    theme,
    /*
     * The contrast floor, gated by the SAME reading the pane chrome uses — and
     * taken from the theme object just built, not from `mode`. There is one
     * source for "is this a light surface" (`paneTitleSurface`) and its input is
     * the background actually painted, so a themed grid and the bar above it
     * cannot come to different conclusions about what they are sitting on.
     *
     * 4.5 light / 3 dark, from the Orca reading in the UI reference notes: the
     * 4.5 floor over-brightens vibrant ANSI colours on a near-black grid.
     */
    minimumContrastRatio: minimumContrastRatio(paneTitleSurface(theme.background)),
    cursorBlink: true,
    cursorStyle: 'block',
    // steps(), not ease — rule 7. xterm's blink is already a hard toggle.
    scrollback: 5000,
    allowProposedApi: true,
    // The renderer decodes; main never turns bytes into a string (see channels.ts).
    convertEol: false,
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  return {
    get cols() {
      return terminal.cols;
    },
    get rows() {
      return terminal.rows;
    },
    open: (host) => terminal.open(host),
    write: (data) => terminal.write(data),
    // The host's decision, not ours: this reshapes the grid without telling
    // the host, which would otherwise bounce back as a viewport change.
    resize: (cols, rows) => terminal.resize(cols, rows),
    onData: (listener) => terminal.onData(listener),
    onResize: (listener) => terminal.onResize(listener),
    focus: () => terminal.focus(),
    fit: () => {
      // `fit()` throws on an element with no box yet (hidden, or measured
      // before layout). A pane that cannot be measured keeps its 80×24 until
      // the next resize, which is a far better outcome than a thrown effect.
      try {
        const proposed = fitAddon.proposeDimensions();
        if (proposed === undefined || !(proposed.cols > 0) || !(proposed.rows > 0)) return null;
        fitAddon.fit();
        return { cols: terminal.cols, rows: terminal.rows };
      } catch {
        return null;
      }
    },
    text: () => readBuffer(terminal),
    dispose: () => terminal.dispose(),
  };
}

/**
 * The buffer as plain text. This is diagnostics, and it is what the terminal
 * smoke reads to assert that pty bytes made it all the way through xterm's
 * parser — rather than only that an IPC message arrived, which is a much
 * weaker claim wearing the same clothes.
 */
function readBuffer(terminal: Terminal): string {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i += 1) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
  }
  return lines.join('\n');
}
