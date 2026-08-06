import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { fonts, metrics, xtermTheme, type ThemeMode } from '@shepherd/design-tokens';
import type { TerminalLike } from './pane-sessions.ts';
import '@xterm/xterm/css/xterm.css';

/**
 * The one file that knows what a terminal actually is.
 *
 * Everything else — the registry, the pane component, the tests — is written
 * against `TerminalLike`, so xterm's DOM measurement (which jsdom cannot do)
 * never sits between a lifecycle claim and the test that proves it.
 *
 * The grid is drawn from the SAME tokens as the chrome, and the cell metrics
 * are the design language's first rule made literal: xterm's `lineHeight` is a
 * multiplier, so it is derived from the two token values rather than typed as
 * a third number that can drift from them.
 */
export function createXtermTerminal(mode: ThemeMode = 'dark'): TerminalLike {
  const terminal = new Terminal({
    fontFamily: fonts.mono,
    fontSize: metrics.fontSize,
    lineHeight: metrics.lineHeight / metrics.fontSize,
    theme: xtermTheme(mode),
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
