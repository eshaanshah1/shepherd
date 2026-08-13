import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import { toDisposable, type Disposable } from '@shepherd/sdk';
import { cwdFromOsc7 } from './osc.ts';

/**
 * The host's authoritative view of what a session's screen IS.
 *
 * `PtyRing` recorded the last 256 KB a session produced, which is a recording of
 * a *stream*: correct only for a viewer that watched from the beginning. This is
 * the *screen* — a real VT state machine fed the same bytes — so a viewer that
 * arrives an hour late gets a correct repaint, including the alt screen, which a
 * byte replay corrupts. v1's remote design lists that corruption as an accepted
 * limitation ("full-screen apps across a cold reconnect may need one redraw");
 * this deletes it rather than mitigating it.
 *
 * Three things about this file are measured rather than reasoned
 * (`docs/superpowers/probes/2026-08-09-r0`):
 *
 *   1. **Both packages are CommonJS.** Every package here is `"type": "module"`,
 *      so a named import fails at runtime with "Named export 'Terminal' not
 *      found" — in the main process, at session creation, having typechecked
 *      cleanly. Hence the default-import-and-destructure below.
 *
 *   2. **`capture` takes a callback and is NOT async.** See its own comment. The
 *      obvious promise-shaped version is wrong in a way that no test attaching to
 *      an idle session can see.
 *
 *   3. **The cost is affordable and mostly not new.** ~70-108 MB/s of parsing,
 *      0.52 MB per mirror at the default depth, and roughly a wash against what
 *      the renderer already spends — because the parse largely MOVES here rather
 *      than doubling, once a pane that nobody is looking at can stop keeping a
 *      terminal of its own.
 */

const { Terminal } = headless;
const { SerializeAddon } = serialize;

/**
 * Lines kept behind the screen. The measured sweet spot: ~3 ms and ~55 KB per
 * capture, against 15 ms and 330 KB at 5000. A caller that wants less asks for
 * less at capture time; the mirror still holds this much.
 */
export const DEFAULT_SCROLLBACK = 1000;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** A screen, as `screen()` and the diagnostics read it. */
export interface ScreenState {
  /** The VISIBLE grid, newline-joined and right-trimmed. */
  readonly text: string;
  readonly cols: number;
  readonly rows: number;
  readonly cursor: { readonly x: number; readonly y: number };
  /** True while a full-screen app (vim, less) owns the display. */
  readonly altScreen: boolean;
}

/** What the running program said about itself. Only the fields that changed. */
export interface ObservedPatch {
  readonly title?: string;
  readonly cwd?: string;
}

export interface TerminalMirrorOptions {
  readonly cols?: number;
  readonly rows?: number;
  readonly scrollback?: number;
  /**
   * This machine's name, for the OSC 7 host check — a parameter and never an
   * `os.hostname()` call, because core does not touch the platform. Absent
   * means only a host-less OSC 7 is accepted.
   */
  readonly hostname?: string;
}

export class TerminalMirror {
  readonly #terminal: InstanceType<typeof Terminal>;
  readonly #serializer: InstanceType<typeof SerializeAddon>;
  readonly #scrollback: number;
  readonly #encoder = new TextEncoder();
  readonly #decoder = new TextDecoder();
  readonly #observed = new Set<(patch: ObservedPatch) => void>();
  readonly #hostname: string | undefined;
  #title = '';
  #cwd: string | undefined;
  #disposed = false;

  constructor(options: TerminalMirrorOptions = {}) {
    this.#scrollback = options.scrollback ?? DEFAULT_SCROLLBACK;
    this.#terminal = new Terminal({
      cols: options.cols ?? DEFAULT_COLS,
      rows: options.rows ?? DEFAULT_ROWS,
      scrollback: this.#scrollback,
      // The serialize addon reads cell attributes through the proposed API.
      allowProposedApi: true,
    });
    this.#serializer = new SerializeAddon();
    this.#terminal.loadAddon(this.#serializer);
    this.#hostname = options.hostname;

    /*
     * Both are deduped here rather than downstream: oh-my-zsh re-emits an
     * unchanged title and cwd on every prompt, and a frame not sent is cheaper
     * than six layers each deciding to ignore one.
     */
    this.#terminal.onTitleChange((title) => {
      if (title === this.#title) return;
      this.#title = title;
      this.#announce({ title });
    });

    this.#terminal.parser.registerOscHandler(7, (payload) => {
      const cwd = cwdFromOsc7(payload, this.#hostname);
      if (cwd !== undefined && cwd !== this.#cwd) {
        this.#cwd = cwd;
        this.#announce({ cwd });
      }
      // Handled either way: an OSC 7 we refuse is still an OSC 7, and reporting
      // it unhandled only invites xterm to log it once per prompt.
      return true;
    });
  }

  /** The running program named itself, or changed directory. */
  onObserved(listener: (patch: ObservedPatch) => void): Disposable {
    this.#observed.add(listener);
    return toDisposable(() => {
      this.#observed.delete(listener);
    });
  }

  get cols(): number {
    return this.#terminal.cols;
  }

  get rows(): number {
    return this.#terminal.rows;
  }

  /**
   * The same bytes the fanout delivers, in the same order.
   *
   * Decoded here with a STATEFUL decoder (`{ stream: true }`), so a multi-byte
   * sequence split across two pty chunks survives — the same hazard `host.ts`
   * avoids by never decoding on the way to the renderer. xterm's `write` accepts
   * a `Uint8Array` and would do this decode itself, but with a decoder we cannot
   * reach; keeping ours explicit is what makes the streaming behaviour testable.
   */
  feed(bytes: Uint8Array): void {
    if (this.#disposed || bytes.length === 0) return;
    this.#terminal.write(this.#decoder.decode(bytes, { stream: true }));
  }

  /**
   * The screen as of THIS point in the write queue, handed to `sink`.
   *
   * **Not a promise, and that is load-bearing.** The obvious version —
   *
   *     await new Promise((resolve) => terminal.write('', resolve));
   *     snapshot = serializer.serialize();
   *
   * — is wrong, and probe p4 caught it doing real damage. `await` resumes on a
   * microtask, while xterm's `_innerWrite` fires the callback and then KEEPS
   * PARSING synchronously. By the time the continuation ran, 223 later chunks
   * were already in the grid — and the caller was about to be sent those same
   * chunks as live bytes, so every attach landing inside a burst double-printed
   * it.
   *
   * Serializing INSIDE the callback pins the snapshot to the barrier's own
   * position in the queue, which is the property `PtyFanout` needs to keep its
   * "no gap, no duplicate" contract. Verified under both orderings (p5): a burst
   * already queued, and bytes spread across ticks.
   */
  capture(sink: (snapshot: Uint8Array) => void, scrollback = this.#scrollback): void {
    if (this.#disposed) return;
    this.#terminal.write('', () => {
      // Disposed while the barrier was in flight — a mirror torn down mid-capture
      // must not serialize a disposed terminal.
      if (this.#disposed) return;
      /**
       * `RIS` first, because a snapshot REPLACES a screen — it does not add to
       * one.
       *
       * The serializer emits a stream that reconstructs this terminal *from
       * scratch*: it assumes a fresh emulator and so writes no reset of its own.
       * Written on top of a screen that already has content it appends a whole
       * second copy — which is what a viewer saw when a reshape sent it a
       * repaint. Every resize stacked another screen, and on the display that
       * read as the last command having run again and again (`❯ ❯ echo …`, two
       * prompts on one line) rather than as one screen drawn twice, which is
       * why it was hunted as an input bug.
       *
       * Prefixed HERE rather than in each client, because there is one right
       * answer and three consumers — the renderer, the phone, and the smoke.
       */
      sink(this.#encoder.encode(`\u001bc${this.#serializer.serialize({ scrollback })}`));
    });
  }

  /** Ignores anything that is not a positive integer, as `SessionHost.resize` does. */
  resize(cols: number, rows: number): void {
    if (this.#disposed) return;
    if (!Number.isInteger(cols) || cols <= 0) return;
    if (!Number.isInteger(rows) || rows <= 0) return;
    if (this.#terminal.cols === cols && this.#terminal.rows === rows) return;
    this.#terminal.resize(cols, rows);
  }

  screen(): ScreenState {
    const buffer = this.#terminal.buffer.active;
    const lines: string[] = [];
    // The VISIBLE grid only: `screen()` answers "what is on the display", and a
    // caller that wants history takes a capture.
    for (let row = 0; row < this.#terminal.rows; row += 1) {
      lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '');
    }
    return {
      text: lines.join('\n'),
      cols: this.#terminal.cols,
      rows: this.#terminal.rows,
      cursor: { x: buffer.cursorX, y: buffer.cursorY },
      altScreen: buffer.type === 'alternate',
    };
  }

  #announce(patch: ObservedPatch): void {
    // A copy: a listener may unsubscribe from inside its own callback, which is
    // what `PtyFanout` already does one layer up.
    for (const listener of [...this.#observed]) listener(patch);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#terminal.dispose();
    this.#observed.clear();
  }
}
