import { color, type ThemeMode } from './palette.ts';

/**
 * The subset of xterm.js's ITheme we set. Typed structurally so this package
 * never has to depend on @xterm/xterm — tokens are data (boundary rule).
 */
export interface XtermTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/**
 * What a search match is painted with. The same structural typing as
 * `XtermTheme` and for the same reason — this package never imports xterm.
 *
 * The two overview-ruler fields are not optional in the addon's own type, so
 * they are not optional here either.
 */
export interface XtermSearchDecorations {
  matchBackground: string;
  matchOverviewRuler: string;
  activeMatchBackground: string;
  activeMatchBorder: string;
  activeMatchColorOverviewRuler: string;
}

/**
 * Every match washed neutrally, the current one RINGED in `signal`.
 *
 * The split is not the obvious one, and it is measured rather than reasoned.
 * **`activeMatchBackground` is never painted.** xterm selects the match it
 * navigates to, and the selection is drawn over the decoration — so the active
 * cell shows `selectionBackground` whatever this field says. Verified by setting
 * it to a colour that appears nowhere else in the app (`pasture`, green) and
 * screenshotting the running app: no green anywhere, only the border.
 *
 * Two consequences, and both are why the colours below look inverted:
 *
 *   - The **border is the whole signal** for "you are here", so it takes
 *     `signal` — the token whose job is exactly a live affordance — rather than
 *     a quiet outline.
 *   - The other matches must therefore be QUIET. Washed in `hay` they were the
 *     loudest thing on the grid and the current match, wearing the selection's
 *     dark fill, read as the one that was NOT highlighted. `wool-faint` is a
 *     neutral step: plainly a highlight, no hue to compete with the ring.
 *
 * `activeMatchBackground` is still set, and set LOUD: it costs nothing, and a
 * renderer that does paint it should paint the active match brightest.
 *
 * A match keeps its own foreground throughout — the addon washes a background
 * behind live cells, and choosing a text colour here would flatten whatever the
 * program drew.
 */
export function xtermSearchDecorations(mode: ThemeMode): XtermSearchDecorations {
  const c = (token: Parameters<typeof color>[0]) => color(token, mode);
  return {
    matchBackground: c('inkMute'),
    matchOverviewRuler: c('inkMute'),
    activeMatchBackground: c('sky'),
    activeMatchBorder: c('sky'),
    activeMatchColorOverviewRuler: c('sky'),
  };
}

/**
 * The grid is the same surface as the chrome, so the ANSI slots are drawn from
 * the same named colours rather than a stock scheme.
 *
 * Two things about this mapping are Shepherd UI's rather than inherited:
 *
 *   - **The grid's text is `textDim`, not `text`.** §2 gives the terminal body
 *     `#C4C4C4` while a title is `#EDEDED`; the app hosts other people's
 *     programs and its own chrome should be the brighter thing on screen only
 *     where it is naming something.
 *   - **The block cursor is `text`.** Flock had a fifth accent (`signal`) whose
 *     whole job was "a live affordance"; this language has five colours and none
 *     of them is spare, so the cursor is simply the loudest neutral — which is
 *     also what the prototype draws.
 *
 * yellow/magenta/cyan have no job in a five-colour language. They borrow the
 * nearest neighbour rather than introducing a sixth hue, which §6 refuses
 * outright.
 */
export function xtermTheme(mode: ThemeMode): XtermTheme {
  const c = (token: Parameters<typeof color>[0]) => color(token, mode);
  return {
    background: c('pane'),
    foreground: c('inkDim'),
    cursor: c('ink'),
    cursorAccent: c('pane'),
    selectionBackground: c('line'),

    black: c('canvas'),
    red: c('red'),
    green: c('grass'),
    yellow: c('clay'),
    blue: c('sky'),
    magenta: c('sky'),
    cyan: c('sky'),
    white: c('inkFaint'),

    brightBlack: c('inkGhost'),
    brightRed: c('red'),
    brightGreen: c('grass'),
    brightYellow: c('clay'),
    brightBlue: c('sky'),
    brightMagenta: c('sky'),
    brightCyan: c('sky'),
    brightWhite: c('ink'),
  };
}
