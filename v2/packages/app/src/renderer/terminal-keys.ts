/**
 * The two keys xterm gets wrong for an agent, as one pure decision.
 *
 * xterm's own map (`common/input/Keyboard.ts`) is the VT one, and on both of
 * these the VT answer is a key that means nothing:
 *
 *   - **⇧⏎** — case 13 reads `altKey` and nothing else, so shift+enter is
 *     byte-identical to enter (`CR`). An agent asked to insert a newline
 *     therefore receives a submit, which is not a missing binding on its side:
 *     there is nothing in the stream for it to bind. `ESC CR` is what
 *     `claude /terminal-setup` writes into iTerm2 and VS Code for exactly this,
 *     so it is the sequence agents already read.
 *   - **⌃⌫** — case 8 sends `BS` (`^H`), the VT "backspace" that everything
 *     already reaches through `DEL`. Nothing binds a bare `^H`, so the key is
 *     inert. `^W` is the word rubout readline (`unix-word-rubout`) and the
 *     agents both implement, so one sequence serves the shell and the TUI.
 *
 * Pure, and a chord rather than a `KeyboardEvent`, because this is the half
 * worth pinning: `xterm-terminal.ts` cannot be unit tested (jsdom cannot measure
 * a cell), and a rule buried in a handler there would be a rule nothing checks.
 *
 * The "another modifier is also held" guards are not decoration. ⌘⏎ is a menu
 * gesture and ⌥⏎/⌥⌫ are sequences xterm already sends correctly — claiming a
 * chord this file was not asked for would delete a working key.
 */

/** The part of a keydown this decision reads. */
export interface KeyChord {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

/** ESC CR — "newline, not submit". What `/terminal-setup` configures elsewhere. */
const ESC_CR = '\x1b\r';
/** ^W — delete the word before the cursor. */
const WORD_RUBOUT = '\x17';

/**
 * What this chord should send instead, or null to leave it to xterm.
 *
 * Null is the answer for all but two chords, deliberately: every other key in
 * the terminal is xterm's business, and a table here that grew would be a second
 * keymap to keep in step with the first.
 */
export function terminalKeyBytes(chord: KeyChord): string | null {
  if (chord.key === 'Enter' && chord.shiftKey && !chord.ctrlKey && !chord.altKey && !chord.metaKey) {
    return ESC_CR;
  }
  if (
    chord.key === 'Backspace' &&
    chord.ctrlKey &&
    !chord.altKey &&
    !chord.metaKey
  ) {
    return WORD_RUBOUT;
  }
  return null;
}
