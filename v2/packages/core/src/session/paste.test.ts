import { describe, expect, it } from 'vitest';
import { pasteBytes } from './host.ts';
import { TerminalMirror } from './mirror.ts';

/**
 * Bracketed paste, decided from what the running program actually asked for.
 *
 * This is the property `sessions.write` rests on. Unbracketed, every newline in
 * pasted text is an Enter — so a six-line prompt handed to a TUI submits its
 * first line and scatters five into whatever runs next. v1 recorded that lesson
 * from the other side (`pasteText` vs `injectText`); this is the reading that
 * lets core act on it with no emulator in the loop.
 *
 * Two halves, tested where each is real. `pasteBytes` is what a paste BECOMES,
 * and it is pure. `TerminalMirror.bracketedPaste` is WHEN, and it is a parse of
 * a live stream. The plumbing between them is one line in `SessionHost.paste`.
 *
 * Deliberately NOT asserted through a pty: that would mean asserting on the
 * tty's echo of the input, and a tty in canonical mode echoes a control byte as
 * `^[` rather than as itself — so the test would be about line-discipline
 * settings rather than about this decision.
 */

const ESC = '\u001b';
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

describe('pasteBytes', () => {
  it('wraps the body when the program turned bracketing on', () => {
    expect(pasteBytes('one\ntwo', true)).toBe(`${PASTE_START}one\rtwo${PASTE_END}`);
  });

  it('sends plain CRs when it did not, so a shell paste still behaves', () => {
    expect(pasteBytes('one\ntwo', false)).toBe('one\rtwo');
  });

  it('normalizes every newline flavour to CR, bracketed or not', () => {
    // A pty carries Enter as CR; an `\n` reaches a program as a linefeed it
    // will not act on.
    expect(pasteBytes('a\r\nb\nc', false)).toBe('a\rb\rc');
    expect(pasteBytes('a\r\nb', true)).toBe(`${PASTE_START}a\rb${PASTE_END}`);
  });

  it('brackets an empty paste rather than sending nothing', () => {
    // An empty bracketed paste is what clears a TUI's pending input. Sending
    // nothing at all would be a different gesture.
    expect(pasteBytes('', true)).toBe(`${PASTE_START}${PASTE_END}`);
    expect(pasteBytes('', false)).toBe('');
  });

  it('does not add an Enter — submitting is a separate decision', () => {
    expect(pasteBytes('hi', true).endsWith(PASTE_END)).toBe(true);
    expect(pasteBytes('hi', false)).toBe('hi');
  });
});

describe('TerminalMirror.bracketedPaste', () => {
  const feed = (mirror: TerminalMirror, text: string): void => mirror.feed(new TextEncoder().encode(text));

  const settle = async (predicate: () => boolean, label: string): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  it('is off until a program asks, and follows it in both directions', async () => {
    const mirror = new TerminalMirror();
    expect(mirror.bracketedPaste).toBe(false);

    feed(mirror, `${ESC}[?2004h`);
    await settle(() => mirror.bracketedPaste, 'the mode to turn on');

    feed(mirror, `${ESC}[?2004l`);
    await settle(() => !mirror.bracketedPaste, 'the mode to turn off');
  });

  it('reads it off the same stream a viewer sees, not off a side channel', async () => {
    // The mode arrives interleaved with ordinary output, split across chunks the
    // way a real pty delivers it — which is the case a naive scan would miss.
    const mirror = new TerminalMirror();
    feed(mirror, 'starting up\r\n');
    feed(mirror, `${ESC}[?20`);
    feed(mirror, '04h');
    await settle(() => mirror.bracketedPaste, 'the split sequence to be understood');
  });
});
