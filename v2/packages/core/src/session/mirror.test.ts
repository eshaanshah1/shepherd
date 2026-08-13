import { describe, expect, it } from 'vitest';
import { TerminalMirror, type ObservedPatch } from './mirror.ts';

const encode = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

const captured = (mirror: TerminalMirror, scrollback?: number) =>
  new Promise<Uint8Array>((resolve) => {
    mirror.capture(resolve, scrollback);
  });

/** Feed a snapshot into a SECOND mirror and read its screen back. */
async function repaint(snapshot: Uint8Array, cols = 80, rows = 24): Promise<string> {
  const replay = new TerminalMirror({ cols, rows });
  replay.feed(snapshot);
  await captured(replay);
  const { text } = replay.screen();
  replay.dispose();
  return text;
}

describe('TerminalMirror', () => {
  it('reports the screen a stream produced', async () => {
    const mirror = new TerminalMirror();
    mirror.feed(encode('hello\r\nworld\r\n'));
    await captured(mirror);

    const screen = mirror.screen();
    const lines = screen.text.split('\n');
    expect(lines[0]).toBe('hello');
    expect(lines[1]).toBe('world');
    expect(screen.cols).toBe(80);
    expect(screen.rows).toBe(24);
    expect(screen.altScreen).toBe(false);
    mirror.dispose();
  });

  /**
   * A snapshot REPLACES a screen; it does not add to one.
   *
   * The serializer reconstructs a terminal from scratch and writes no reset of
   * its own, so a repaint delivered to a viewer that already had content
   * appended a second whole copy. On screen that read as the last command
   * having run again — `❯ ❯ echo …`, two prompts on one line — rather than as
   * one screen drawn twice, which is why it was hunted as an input bug.
   */
  it('repaints a viewer that already has content, instead of stacking on it', async () => {
    const mirror = new TerminalMirror();
    mirror.feed(encode('only line\r\n'));
    const snapshot = await captured(mirror);

    // A viewer mid-session: it has a screen already, and is handed a repaint.
    const viewer = new TerminalMirror();
    viewer.feed(encode('stale line\r\n'));
    await captured(viewer);
    viewer.feed(snapshot);
    await captured(viewer);

    expect(viewer.screen().text).toBe(mirror.screen().text);
    expect(viewer.screen().text).not.toContain('stale line');
    viewer.dispose();
    mirror.dispose();
  });

  it('round-trips a snapshot into an identical screen', async () => {
    const mirror = new TerminalMirror();
    mirror.feed(encode('\x1b[31;1mred bold\x1b[0m plain\r\nsecond line\r\n'));
    const snapshot = await captured(mirror);
    expect(await repaint(snapshot)).toBe(mirror.screen().text);
    mirror.dispose();
  });

  /**
   * The case a byte ring cannot do, and the reason this class exists at all: a
   * replay of the raw stream re-runs `?1049h` against a fresh emulator with no
   * idea what the app had drawn, and the viewer gets a blank alt screen.
   */
  it('round-trips the ALT SCREEN, which a byte replay corrupts', async () => {
    const mirror = new TerminalMirror();
    mirror.feed(encode('shell scrollback here\r\n'));
    mirror.feed(encode('\x1b[?1049h\x1b[H\x1b[2J\x1b[1;1H~ \x1b[7mVIM\x1b[0m\x1b[5;3Hediting'));
    const snapshot = await captured(mirror);

    expect(mirror.screen().altScreen).toBe(true);
    expect(decode(snapshot)).toContain('VIM');
    expect(await repaint(snapshot)).toBe(mirror.screen().text);
    mirror.dispose();
  });

  it('reports the cursor where the stream left it', async () => {
    const mirror = new TerminalMirror();
    mirror.feed(encode('\x1b[2J\x1b[H\x1b[12;40Hx'));
    await captured(mirror);
    // 1-based CUP -> 0-based buffer coords; printing `x` advanced the column.
    expect(mirror.screen().cursor).toEqual({ x: 40, y: 11 });
    mirror.dispose();
  });

  /**
   * THE contract, and the one this file exists to defend.
   *
   * Probe p4 refuted `await barrier; serialize()`: `await` resumes on a
   * microtask, xterm keeps parsing synchronously past the callback, and the
   * snapshot then contains bytes the caller is ALSO about to be sent as live
   * output — 223 of them, in the probe. A test that captures from an idle mirror
   * cannot see this, which is exactly how this class of bug has survived before.
   */
  it('captures exactly the bytes fed BEFORE the capture, under load', async () => {
    const mirror = new TerminalMirror({ scrollback: 2000 });
    for (let i = 0; i < 300; i += 1) mirror.feed(encode(`M${i}\r\n`));

    const snapshot = captured(mirror, 2000);
    // Keep feeding while the capture is in flight — the whole point.
    for (let i = 300; i < 600; i += 1) mirror.feed(encode(`M${i}\r\n`));

    const text = decode(await snapshot);
    // Word-boundary matching: `M299` must not be satisfied by `M2990`.
    expect(text).toMatch(/M299(?![0-9])/);
    expect(text).not.toMatch(/M300(?![0-9])/);
    mirror.dispose();
  });

  it('resizes without losing the screen', async () => {
    const mirror = new TerminalMirror({ cols: 80, rows: 24 });
    mirror.feed(encode('keep me\r\n'));
    await captured(mirror);

    mirror.resize(100, 30);
    await captured(mirror);

    expect(mirror.cols).toBe(100);
    expect(mirror.rows).toBe(30);
    expect(mirror.screen().text).toContain('keep me');
    mirror.dispose();
  });

  it('ignores a resize that is not a positive integer', () => {
    const mirror = new TerminalMirror({ cols: 80, rows: 24 });
    mirror.resize(0, -1);
    mirror.resize(1.5, 24);
    mirror.resize(80, Number.NaN);
    expect(mirror.cols).toBe(80);
    expect(mirror.rows).toBe(24);
    mirror.dispose();
  });

  it('survives a multi-byte sequence split across two feeds', async () => {
    const mirror = new TerminalMirror();
    const bytes = encode('日本語');
    // Split mid-character: a stateless decoder turns this into replacement chars.
    mirror.feed(bytes.subarray(0, 4));
    mirror.feed(bytes.subarray(4));
    await captured(mirror);
    expect(mirror.screen().text.split('\n')[0]).toBe('日本語');
    mirror.dispose();
  });

  it('drops feeds and captures after dispose rather than throwing', () => {
    const mirror = new TerminalMirror();
    mirror.feed(encode('x'));
    mirror.dispose();
    mirror.dispose(); // idempotent
    expect(() => mirror.feed(encode('y'))).not.toThrow();
    expect(() => {
      mirror.capture(() => undefined);
    }).not.toThrow();
  });

  /** OSC 2 (window title). xterm fires `onTitleChange` for OSC 0 and 2. */
  it('reports an OSC 2 title', async () => {
    const mirror = new TerminalMirror();
    const seen: ObservedPatch[] = [];
    mirror.onObserved((patch) => seen.push(patch));

    mirror.feed(encode(']2;building'));
    await captured(mirror);

    expect(seen).toEqual([{ title: 'building' }]);
    mirror.dispose();
  });

  it('reports an OSC 7 cwd for this machine, decoded', async () => {
    const mirror = new TerminalMirror({ hostname: 'mac-b.local' });
    const seen: ObservedPatch[] = [];
    mirror.onObserved((patch) => seen.push(patch));

    mirror.feed(encode(']7;file://mac-b/Users/me/my%20code\\'));
    await captured(mirror);

    expect(seen).toEqual([{ cwd: '/Users/me/my code' }]);
    mirror.dispose();
  });

  it('says nothing about an OSC 7 from another machine', async () => {
    const mirror = new TerminalMirror({ hostname: 'mac-b' });
    const seen: ObservedPatch[] = [];
    mirror.onObserved((patch) => seen.push(patch));

    mirror.feed(encode(']7;file://build-box/srv/app\\'));
    await captured(mirror);

    expect(seen).toEqual([]);
    mirror.dispose();
  });

  /**
   * oh-my-zsh re-emits the same cwd on every prompt. Suppressed HERE, so the
   * frame never crosses the socket rather than being ignored six layers along.
   */
  it('says nothing when a value repeats', async () => {
    const mirror = new TerminalMirror({ hostname: 'mac-b' });
    const seen: ObservedPatch[] = [];
    mirror.onObserved((patch) => seen.push(patch));

    mirror.feed(encode(']2;same]2;same]2;other'));
    await captured(mirror);

    expect(seen).toEqual([{ title: 'same' }, { title: 'other' }]);
    mirror.dispose();
  });

  /**
   * A pty chunk boundary lands wherever it lands. xterm's parser holds state
   * across writes; this pins that we have not put a decode in front of it that
   * does not.
   */
  it('reads a sequence split across two feeds', async () => {
    const mirror = new TerminalMirror();
    const seen: ObservedPatch[] = [];
    mirror.onObserved((patch) => seen.push(patch));

    mirror.feed(encode(']2;spl'));
    mirror.feed(encode('it'));
    await captured(mirror);

    expect(seen).toEqual([{ title: 'split' }]);
    mirror.dispose();
  });

  /**
   * The shell re-sets its prompt title after EVERY command, so this has to clear
   * the name rather than be ignored — ignoring it would leave the tab reading
   * `vim` for the rest of the session.
   */
  it('clears the name when a shell goes back to its prompt', async () => {
    const mirror = new TerminalMirror();
    const seen: ObservedPatch[] = [];
    mirror.onObserved((patch) => seen.push(patch));

    // BEL-terminated, as a shell sends them: a bare ESC starting the next
    // sequence ABORTS the one in progress, so an unterminated run dispatches
    // nothing at all.
    mirror.feed(encode('\x1b]2;me@box:~\x07'));
    mirror.feed(encode('\x1b]2;vim\x07'));
    mirror.feed(encode('\x1b]2;me@box:~/code\x07'));
    await captured(mirror);

    // The first prompt title says nothing (the name was already empty); the
    // second has to undo `vim`.
    expect(seen).toEqual([{ title: 'vim' }, { title: '' }]);
    mirror.dispose();
  });

  it('stops reporting once disposed', async () => {
    const mirror = new TerminalMirror();
    const seen: ObservedPatch[] = [];
    const subscription = mirror.onObserved((patch) => seen.push(patch));

    subscription.dispose();
    mirror.feed(encode(']2;ignored'));
    await captured(mirror);

    expect(seen).toEqual([]);
    mirror.dispose();
  });
});
