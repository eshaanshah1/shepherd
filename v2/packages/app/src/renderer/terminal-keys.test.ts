import { describe, expect, it } from 'vitest';
import { terminalKeyBytes } from './terminal-keys.ts';

/** A keydown, as the decision reads it. Everything defaults to "not held". */
function chord(key: string, held: Partial<Record<'shift' | 'ctrl' | 'alt' | 'meta', boolean>> = {}) {
  return {
    key,
    shiftKey: held.shift ?? false,
    ctrlKey: held.ctrl ?? false,
    altKey: held.alt ?? false,
    metaKey: held.meta ?? false,
  };
}

describe('terminalKeyBytes', () => {
  it('sends ESC CR for shift+enter, which is what makes it a different key', () => {
    // Measured before the fix: xterm sends CR for both, so `cat -v` in a pane
    // showed the line submitting on shift+enter exactly as on enter.
    expect(terminalKeyBytes(chord('Enter', { shift: true }))).toBe('\x1b\r');
  });

  it('leaves plain enter to xterm', () => {
    expect(terminalKeyBytes(chord('Enter'))).toBeNull();
  });

  it('leaves enter alone when another modifier is also held', () => {
    // ⌘⏎ and ⌥⏎ are somebody else's — the menu's, or xterm's own ESC CR for alt.
    expect(terminalKeyBytes(chord('Enter', { shift: true, meta: true }))).toBeNull();
    expect(terminalKeyBytes(chord('Enter', { shift: true, ctrl: true }))).toBeNull();
    expect(terminalKeyBytes(chord('Enter', { shift: true, alt: true }))).toBeNull();
  });

  it('sends ^W for ctrl+backspace, the word rubout readline and agents both bind', () => {
    // Measured before the fix: xterm's `ev.ctrlKey ? '\b' : DEL` sent ^H, which
    // showed up as a literal `^H` under `cat -v` and nothing bound it.
    expect(terminalKeyBytes(chord('Backspace', { ctrl: true }))).toBe('\x17');
  });

  it('leaves plain backspace to xterm', () => {
    expect(terminalKeyBytes(chord('Backspace'))).toBeNull();
  });

  it('leaves backspace alone when another modifier is also held', () => {
    // ⌥⌫ is already a word rubout via xterm's ESC DEL, and ⌘⌫ is line-kill
    // territory — neither is this rule's to claim.
    expect(terminalKeyBytes(chord('Backspace', { ctrl: true, alt: true }))).toBeNull();
    expect(terminalKeyBytes(chord('Backspace', { ctrl: true, meta: true }))).toBeNull();
    expect(terminalKeyBytes(chord('Backspace', { alt: true }))).toBeNull();
  });

  it('claims nothing else', () => {
    for (const key of ['a', 'Tab', 'Escape', 'ArrowUp', 'Delete', 'f']) {
      expect(terminalKeyBytes(chord(key)), key).toBeNull();
      expect(terminalKeyBytes(chord(key, { ctrl: true })), key).toBeNull();
      expect(terminalKeyBytes(chord(key, { shift: true })), key).toBeNull();
    }
  });
});
