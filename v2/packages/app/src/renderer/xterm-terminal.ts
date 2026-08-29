import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import {
  fonts,
  metrics,
  minimumContrastRatio,
  paneTitleSurface,
  xtermSearchDecorations,
  xtermTheme,
  type ThemeMode,
} from '@shepherd/design-tokens';
import type { TerminalLike } from './pane-sessions.ts';
import { terminalKeyBytes } from './terminal-keys.ts';
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
 * the font's own line box: xterm sizes `█ ▀ ▄` to `fontSize` whichever renderer
 * is drawing, so a multiplier above 1 pads the cell without growing the glyph
 * and every block row gets a seam.
 *
 * The grid is drawn on the GPU — see `accelerate`, which is what keeps a wall of
 * streaming panes off the renderer's main thread.
 */
export function createXtermTerminal(initialMode: ThemeMode = DEFAULT_THEME_MODE): TerminalLike {
  /**
   * Mutable, because a terminal OUTLIVES a theme change (`shepherd.theme`) and is
   * re-themed in place rather than rebuilt: a rebuilt terminal is a released pty
   * and a lost scrollback. Everything below that depends on the palette reads this
   * variable at call time — see `searchOptions`, whose own comment predicted it.
   */
  let mode = initialMode;
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
  const searchAddon = new SearchAddon();
  terminal.loadAddon(searchAddon);

  /*
   * The chords xterm's VT map answers wrongly for an agent. The rule is
   * `terminal-keys.ts` and is unit tested there; this is the seam that applies
   * it, and it is deliberately the only key handling in this file.
   *
   * `preventDefault` is not optional. Returning false short-circuits xterm
   * (`CoreBrowserTerminal._keyDown`) but does NOT stop the browser, so the
   * keystroke would still reach the helper textarea xterm reads input from — an
   * Enter inserting a newline there, a Backspace editing it — and the pty would
   * receive both our bytes and whatever that produced.
   *
   * `input()` rather than a write to the session: this file knows nothing about
   * sessions, and `input` fires `onData`, which is the ONE path a keystroke
   * takes to the pty. A second path would be a second thing to keep in step.
   */
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;
    const bytes = terminalKeyBytes(event);
    if (bytes === null) return true;
    event.preventDefault();
    terminal.input(bytes);
    return false;
  });

  /**
   * The search options, rebuilt per call.
   *
   * `decorations` carries colours, and a terminal outlives a theme change — a
   * frozen object here would keep painting matches in the palette that was live
   * when the pane opened.
   */
  const searchOptions = () => ({ decorations: xtermSearchDecorations(mode) });

  /**
   * The grid is drawn on the GPU, and it has to be, because xterm's other
   * renderer is a DOM one.
   *
   * Without a renderer addon every cell is a `<span>`, and a frame is
   * `replaceChildren` over every dirty row — so Chromium then re-styles,
   * re-lays-out and re-paints the whole grid. An agent's TUI does not append,
   * it redraws its whole box per token batch, so every frame dirties every row
   * of every pane on screen.
   *
   * The bill is spans per frame, which is cells × style runs — NOT bytes. So
   * the load that hurts is the ordinary one: several panes of colour-fragmented
   * output at the frame rate. Nine panes streaming at 60Hz measured 92% of a
   * core in the renderer on the DOM renderer and 21% on this one; in the app,
   * eight panes measured 49% against 17%, and the page went from 872 elements
   * with 441 row spans to 261 with none. Per twenty seconds of wall clock the
   * DOM renderer also spent 0.89s in layout and 0.34s in style recalculation,
   * against 0.01s and 0.02s here — the work that starves the main thread and
   * makes the rest of the window stop answering.
   *
   * `Terminal.open` has to have run first — the addon needs the element to put
   * its canvas in, and throws if there is not one yet. That is why this is
   * called from `open` below rather than beside the other two `loadAddon`s.
   */
  let accelerated = false;
  const accelerate = (): void => {
    let addon: WebglAddon;
    try {
      addon = new WebglAddon();
    } catch {
      // No WebGL here — a blocklisted GPU, a software-rendered VM. xterm keeps
      // its DOM renderer, which is slow and correct.
      return;
    }
    /*
     * A lost context is not a broken pane.
     *
     * The GPU process can drop a context at any time — Chromium caps how many
     * live at once, and macOS drops them on GPU switches and on wake. Disposing
     * the addon is what hands drawing back to the DOM renderer; leaving it
     * loaded leaves the pane blank, still holding a session that is still
     * producing output nobody can see.
     */
    addon.onContextLoss(() => {
      accelerated = false;
      addon.dispose();
    });
    try {
      terminal.loadAddon(addon);
      accelerated = true;
    } catch {
      addon.dispose();
    }
  };

  return {
    get cols() {
      return terminal.cols;
    },
    get rows() {
      return terminal.rows;
    },
    /**
     * Re-theme in place, both halves.
     *
     * `minimumContrastRatio` moves with the palette because its input is the
     * background actually painted (`paneTitleSurface`), and a floor left at the
     * dark reading over-brightens ANSI colours on a light grid — which is the same
     * one-source rule the constructor above states.
     */
    setTheme: (next) => {
      mode = next;
      const themed = xtermTheme(next);
      terminal.options.theme = themed;
      terminal.options.minimumContrastRatio = minimumContrastRatio(paneTitleSurface(themed.background));
    },
    open: (host) => {
      terminal.open(host);
      accelerate();
    },
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
    accelerated: () => accelerated,
    search: {
      findNext: (term, incremental = false) =>
        searchAddon.findNext(term, { ...searchOptions(), incremental }),
      findPrevious: (term) => searchAddon.findPrevious(term, searchOptions()),
      clear: () => searchAddon.clearDecorations(),
      onResults: (listener) => searchAddon.onDidChangeResults(listener),
    },
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
