# R0 — the attachment protocol: a host-authoritative terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the host the authority on what a session's screen *is*, so that an
attach hands over a correct screen rather than a recording of a stream — which is
what lets a phone be an ordinary client instead of a bespoke integration.

**Architecture:** Each live session gains a `TerminalMirror` — an
`@xterm/headless` instance fed the same bytes as the fanout, with
`@xterm/addon-serialize` producing a repaintable screen on demand. `PtyFanout`'s
existing contract is unchanged in *shape* — attach still replays, then goes live —
but what it replays becomes the serialized screen instead of the ring's last
256 KB. Because the snapshot travels as bytes on the existing data channel, the
renderer's write path needs no change at all. Two capabilities follow: resize
arbitration across multiple viewers, and background panes that hold no terminal.

**Tech Stack:** TypeScript (ESM), `@xterm/headless` 6.0.0, `@xterm/addon-serialize`
0.14.0, vitest, Electron 43.

**Design:** [`../specs/2026-08-09-v2-attachment-and-remote-design.md`](../specs/2026-08-09-v2-attachment-and-remote-design.md)
**Probe evidence:** [`../probes/2026-08-09-r0/`](../probes/2026-08-09-r0/) — read
p4/p5 before Task 1. They refuted the obvious version of the attach algorithm.

## Global Constraints

- **`env -u NODE_OPTIONS` on every Electron command.** An ambient `NODE_OPTIONS`
  makes Electron exit 9 before running a line of our code.
- **`v2/tooling/eslint/boundaries.js` IS the architecture diagram.** Widen it
  deliberately, with the reason in the rule's own comment.
- **Bytes, not strings, on the pty path.** The pty is opened `encoding: null` and
  chunks travel as `Uint8Array` to xterm, which owns the decoder. The *snapshot*
  is the one exception: `serialize()` returns a string, and it is encoded to
  UTF-8 exactly once, at the mirror's edge.
- Every version pin goes in `v2/pnpm-workspace.yaml`'s `catalog:`; packages
  depend on `"catalog:"`.
- Failures are typed `Result` values, never throws, on every core API.
- Node `>=25.2.1 <26`, pnpm `>=10.28.0`.
- Run from `v2/`: `pnpm typecheck`, `pnpm lint`, `pnpm -r test`.
- **`@xterm/headless` and `@xterm/addon-serialize` are CommonJS.** In a
  `"type": "module"` package they must be default-imported and destructured:
  `import headless from '@xterm/headless'; const { Terminal } = headless;`

---

### Task 1: `TerminalMirror` — the authority

**Files:**
- Create: `v2/packages/core/src/session/mirror.ts`
- Create: `v2/packages/core/src/session/mirror.test.ts`
- Modify: `v2/pnpm-workspace.yaml` (catalog entries)
- Modify: `v2/packages/core/package.json` (dependencies)
- Modify: `v2/tooling/eslint/boundaries.js` (the deliberate widening)

**Interfaces:**
- Produces:
  ```ts
  export interface ScreenState {
    readonly text: string;          // the visible grid, newline-joined, right-trimmed
    readonly cols: number;
    readonly rows: number;
    readonly cursor: { readonly x: number; readonly y: number };
    readonly altScreen: boolean;    // a full-screen app owns the display
  }
  export interface TerminalMirrorOptions {
    readonly cols?: number;         // default 80
    readonly rows?: number;         // default 24
    readonly scrollback?: number;   // default DEFAULT_SCROLLBACK
  }
  export const DEFAULT_SCROLLBACK = 1000;
  export class TerminalMirror {
    constructor(options?: TerminalMirrorOptions);
    readonly cols: number;
    readonly rows: number;
    feed(bytes: Uint8Array): void;
    /** Captures the screen as of THIS moment in the write queue. See the p4/p5 note. */
    capture(sink: (snapshot: Uint8Array) => void, scrollback?: number): void;
    resize(cols: number, rows: number): void;
    screen(): ScreenState;
    dispose(): void;
  }
  ```

- [ ] **Step 1: Pin the versions**

In `v2/pnpm-workspace.yaml`, under `catalog:`, after the `@xterm/addon-webgl`
line:

```yaml
  # The host-side terminal authority (R0). NOT the renderer's xterm: `headless`
  # is the same VT state machine with no DOM anywhere in its graph, which is what
  # makes it legal in core at all — see tooling/eslint/boundaries.js.
  '@xterm/headless': 6.0.0
  '@xterm/addon-serialize': 0.14.0
```

In `v2/packages/core/package.json`, add to `dependencies` (keys sorted):

```json
    "@xterm/addon-serialize": "catalog:",
    "@xterm/headless": "catalog:",
```

Update that file's `description` to name the mirror:

```json
  "description": "The kernel: session host, terminal mirror, layout, commands, events. Imports stdlib + node-pty + @xterm/headless + @shepherd/sdk only.",
```

Run: `cd v2 && pnpm install`

- [ ] **Step 2: Widen the boundary, with the reason in the rule**

In `v2/tooling/eslint/boundaries.js`, add above `const NODE_PTY`:

```js
// The renderer's xterm, which core may not have. `@xterm/headless` is deliberately
// NOT in this list — see `XTERM_HEADLESS` and the `boundary/core` rule.
const XTERM_VIEW = ['@xterm/xterm', '@xterm/xterm/*', '@xterm/addon-fit', '@xterm/addon-webgl'];
```

Replace the `deny(XTERM, …)` entry in `boundary/core` with:

```js
      deny(
        XTERM_VIEW,
        'the renderer draws: @xterm/xterm and its view addons are a renderer concern. ' +
          'core may import @xterm/headless + @xterm/addon-serialize, and only in session/ — see the comment above.',
      ),
```

And add this comment immediately above the `boundary/core` object:

```js
// Why core may import @xterm/headless (R0, 2026-08-09), when the rule for two
// milestones was "xterm is a renderer concern; core owns bytes, not views".
//
// That sentence rested on a claim about DOM, and it is still true of
// `@xterm/xterm`, which measures cells and builds elements. `@xterm/headless` is
// the same VT state machine with the renderer removed — no DOM anywhere in its
// import graph — so it is a parser, which is exactly the kind of thing a kernel
// that owns ptys should own.
//
// It is load-bearing rather than convenient: without a host-side screen, an
// attach can only replay a byte ring, so a viewer must have watched from the
// beginning to be correct. That is the whole reason v1's phone needed a bespoke
// integration and why its remote design lists a cold-reconnect redraw as an
// accepted limitation. Measured in docs/superpowers/probes/2026-08-09-r0.
//
// The widening is narrow on purpose: `@xterm/xterm` and the view addons stay
// denied everywhere in core, and the mirror lives in session/ next to the fanout
// it feeds.
```

- [ ] **Step 3: Write the failing test — fidelity, then the contract that p4 refuted**

Create `v2/packages/core/src/session/mirror.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TerminalMirror } from './mirror.ts';

const encode = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

/** Feed a snapshot into a second mirror and read its screen back. */
function repaint(snapshot: Uint8Array, cols = 80, rows = 24): Promise<string> {
  const replay = new TerminalMirror({ cols, rows });
  replay.feed(snapshot);
  return new Promise((resolve) => {
    replay.capture(() => {
      const text = replay.screen().text;
      replay.dispose();
      resolve(text);
    });
  });
}

const captured = (mirror: TerminalMirror, scrollback?: number) =>
  new Promise<Uint8Array>((resolve) => mirror.capture(resolve, scrollback));

describe('TerminalMirror', () => {
  it('reports the screen a stream produced', async () => {
    const mirror = new TerminalMirror();
    mirror.feed(encode('hello\r\nworld\r\n'));
    await captured(mirror);
    const screen = mirror.screen();
    expect(screen.text.split('\n')[0]).toBe('hello');
    expect(screen.text.split('\n')[1]).toBe('world');
    expect(screen.cols).toBe(80);
    expect(screen.altScreen).toBe(false);
    mirror.dispose();
  });

  it('round-trips a snapshot into an identical screen', async () => {
    const mirror = new TerminalMirror();
    mirror.feed(encode('\x1b[31;1mred bold\x1b[0m plain\r\nsecond line\r\n'));
    const snapshot = await captured(mirror);
    expect(await repaint(snapshot)).toBe(mirror.screen().text);
    mirror.dispose();
  });

  // The case a byte ring cannot do, and the reason this class exists.
  it('round-trips the ALT SCREEN, which a byte replay corrupts', async () => {
    const mirror = new TerminalMirror();
    mirror.feed(encode('shell scrollback here\r\n'));
    mirror.feed(encode('\x1b[?1049h\x1b[H\x1b[2J\x1b[1;1H~ \x1b[7mVIM\x1b[0m\x1b[5;3Hediting'));
    const snapshot = await captured(mirror);
    await captured(mirror);
    expect(mirror.screen().altScreen).toBe(true);
    expect(await repaint(snapshot)).toBe(mirror.screen().text);
    mirror.dispose();
  });

  it('reports the cursor where the stream left it', async () => {
    const mirror = new TerminalMirror();
    mirror.feed(encode('\x1b[2J\x1b[H\x1b[12;40Hx'));
    await captured(mirror);
    // 1-based CUP -> 0-based buffer coords; the `x` advanced the column by one.
    expect(mirror.screen().cursor).toEqual({ x: 40, y: 11 });
    mirror.dispose();
  });

  /**
   * THE contract. Probe p4 refuted `await barrier; serialize()`: `await` resumes
   * on a microtask, xterm keeps parsing synchronously past the callback, and the
   * snapshot then contains bytes the caller is ALSO about to be sent — 223 of
   * them, in the probe. A test that captures from an idle mirror cannot see this,
   * which is exactly how this class of bug has survived before.
   */
  it('captures exactly the bytes fed BEFORE the capture, under load', async () => {
    const mirror = new TerminalMirror({ scrollback: 2000 });
    for (let i = 0; i < 300; i += 1) mirror.feed(encode(`M${i}\r\n`));

    const snapshotPromise = captured(mirror, 2000);
    // Keep feeding while the capture is in flight — the whole point.
    for (let i = 300; i < 600; i += 1) mirror.feed(encode(`M${i}\r\n`));

    const text = decode(await snapshotPromise);
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

  it('ignores a resize that is not a positive integer', async () => {
    const mirror = new TerminalMirror({ cols: 80, rows: 24 });
    mirror.resize(0, -1);
    mirror.resize(1.5, 24);
    expect(mirror.cols).toBe(80);
    expect(mirror.rows).toBe(24);
    mirror.dispose();
  });

  it('drops capture callbacks after dispose rather than throwing', () => {
    const mirror = new TerminalMirror();
    mirror.feed(encode('x'));
    mirror.dispose();
    expect(() => mirror.feed(encode('y'))).not.toThrow();
    expect(() => mirror.capture(() => undefined)).not.toThrow();
  });
});
```

- [ ] **Step 4: Run it and watch it fail**

Run: `cd v2 && pnpm --filter @shepherd/core test -- mirror`
Expected: FAIL — `Failed to resolve import "./mirror.ts"`.

- [ ] **Step 5: Implement the mirror**

Create `v2/packages/core/src/session/mirror.ts`:

```ts
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';

/**
 * The host's authoritative view of what a session's screen IS.
 *
 * `PtyRing` recorded the last 256 KB a session produced, which is a recording of
 * a *stream*: correct only for a viewer that watched from the beginning. This is
 * the *screen* — a real VT state machine fed the same bytes — so a viewer that
 * arrives an hour late gets a correct repaint, including the alt screen, which a
 * byte replay corrupts (v1's remote design lists that as an accepted limitation;
 * it is deleted rather than mitigated).
 *
 * Two things about this file are measured rather than reasoned
 * (`docs/superpowers/probes/2026-08-09-r0`):
 *
 *   1. **Both packages are CommonJS.** Every package here is `"type": "module"`,
 *      so a named import fails at runtime with "Named export 'Terminal' not
 *      found" — in the main process, at session creation. Hence the
 *      default-import-and-destructure below.
 *
 *   2. **`capture` takes a callback and is NOT async.** See its own comment; the
 *      obvious promise-shaped version is wrong in a way no idle-session test can
 *      see.
 */

const { Terminal } = headless;
const { SerializeAddon } = serialize;

export const DEFAULT_SCROLLBACK = 1000;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** A screen, as an extension's `screen()` and the diagnostics read it. */
export interface ScreenState {
  readonly text: string;
  readonly cols: number;
  readonly rows: number;
  readonly cursor: { readonly x: number; readonly y: number };
  /** True while a full-screen app (vim, less) owns the display. */
  readonly altScreen: boolean;
}

export interface TerminalMirrorOptions {
  readonly cols?: number;
  readonly rows?: number;
  /**
   * Lines kept behind the screen. 1000 is the measured sweet spot: 3 ms and
   * ~55 KB per capture, against 15 ms and 330 KB at 5000. A caller that wants
   * less asks for less at capture time; the mirror still holds this much.
   */
  readonly scrollback?: number;
}

export class TerminalMirror {
  readonly #terminal: InstanceType<typeof Terminal>;
  readonly #serializer: InstanceType<typeof SerializeAddon>;
  readonly #scrollback: number;
  readonly #encoder = new TextEncoder();
  readonly #decoder = new TextDecoder();
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
   * Decoded here rather than passed through: xterm's `write` accepts a string or
   * a `Uint8Array`, and handing it bytes makes it do exactly this decode with a
   * stateful decoder of its own. Ours is stateful too (`{ stream: true }`), so a
   * multi-byte sequence split across two pty chunks survives — the same rule
   * `host.ts` keeps by never decoding on the way to the renderer.
   */
  feed(bytes: Uint8Array): void {
    if (this.#disposed || bytes.length === 0) return;
    this.#terminal.write(this.#decoder.decode(bytes, { stream: true }));
  }

  /**
   * The screen as of THIS point in the write queue, handed to `sink`.
   *
   * **Not a promise, and this is load-bearing.** The obvious version —
   *
   *     await new Promise((r) => terminal.write('', r));
   *     snapshot = serializer.serialize();
   *
   * — is wrong, and probe p4 caught it doing real damage: `await` resumes on a
   * microtask, while xterm's `_innerWrite` fires the callback and then KEEPS
   * PARSING synchronously. By the time the continuation ran, 223 later chunks
   * were already in the grid — and the caller was about to be sent those same
   * chunks as live bytes, so every attach landing inside a burst double-printed
   * it.
   *
   * Serializing INSIDE the callback pins the snapshot to the barrier's own
   * position in the queue, which is the property `PtyFanout` needs to keep its
   * "no gap, no duplicate" contract. Verified under both orderings (p5).
   */
  capture(sink: (snapshot: Uint8Array) => void, scrollback = this.#scrollback): void {
    if (this.#disposed) return;
    this.#terminal.write('', () => {
      if (this.#disposed) return;
      sink(this.#encoder.encode(this.#serializer.serialize({ scrollback })));
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

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#terminal.dispose();
  }
}
```

Note: the `　` character above is a typo guard — if `pnpm lint` reports an
unexpected token on the `allowProposedApi` line, replace that stray full-width
space with a normal one.

- [ ] **Step 6: Run the tests**

Run: `cd v2 && pnpm --filter @shepherd/core test -- mirror`
Expected: PASS, 8 tests.

Then: `cd v2 && pnpm typecheck && pnpm lint`
Expected: clean. If `typecheck` complains about the CJS default imports, add
`"allowSyntheticDefaultImports": true` — do NOT switch to a namespace import,
which resolves to the module object and not the export.

- [ ] **Step 7: Prove the boundary rule actually fires**

Mutation test — M3's lesson was that three gates passed while checking nothing.
Temporarily add `import { Terminal } from '@xterm/xterm';` to `mirror.ts`.

Run: `cd v2 && pnpm lint`
Expected: FAIL naming `boundary/core`. Remove the line and re-run; expected clean.

- [ ] **Step 8: Commit**

```bash
git add v2/pnpm-workspace.yaml v2/packages/core/package.json v2/pnpm-lock.yaml \
        v2/tooling/eslint/boundaries.js v2/packages/core/src/session/mirror.ts \
        v2/packages/core/src/session/mirror.test.ts
git commit -m "feat(v2): the host knows what a session's screen IS, not just what it printed"
```

---

### Task 2: `PtyFanout` replays the screen, not the ring

**Files:**
- Modify: `v2/packages/core/src/session/fanout.ts`
- Modify: `v2/packages/core/src/session/fanout.test.ts` (or `ring.test.ts`, whichever holds the fanout cases)

**Interfaces:**
- Consumes: `TerminalMirror`, `DEFAULT_SCROLLBACK` from Task 1.
- Produces: `PtyFanout` with an unchanged public shape —
  `feed(bytes)`, `attach(sink): Disposable`, `snapshot(): Uint8Array`,
  `clear()`, `viewerCount` — plus `resize(cols, rows)` and `screen(): ScreenState`.
  `attach` keeps returning synchronously; the replay now arrives on a later tick.

- [ ] **Step 1: Write the failing tests**

Add to the fanout's test file:

```ts
it('replays a repaintable SCREEN to a late attacher, not the raw stream', async () => {
  const fanout = new PtyFanout(new TerminalMirror());
  fanout.feed(new TextEncoder().encode('\x1b[?1049h\x1b[H\x1b[2J\x1b[3;5HVIM'));

  const seen: string[] = [];
  fanout.attach((bytes) => seen.push(new TextDecoder().decode(bytes)));
  await new Promise((r) => setTimeout(r, 0));

  // A raw-stream replay would carry `?1049h` and nothing else useful; a screen
  // carries the drawn content, positioned.
  expect(seen.join('')).toContain('VIM');
});

it('delivers no gap and no duplicate when bytes arrive DURING an attach', async () => {
  const fanout = new PtyFanout(new TerminalMirror({ scrollback: 2000 }));
  const encode = (s: string) => new TextEncoder().encode(s);
  for (let i = 0; i < 200; i += 1) fanout.feed(encode(`M${i}\r\n`));

  const seen: string[] = [];
  fanout.attach((bytes) => seen.push(new TextDecoder().decode(bytes)));
  // The window the whole contract is about.
  for (let i = 200; i < 400; i += 1) fanout.feed(encode(`M${i}\r\n`));
  await new Promise((r) => setTimeout(r, 0));

  const text = seen.join('');
  for (let i = 200; i < 400; i += 1) {
    const hits = text.match(new RegExp(`M${i}(?![0-9])`, 'g')) ?? [];
    expect(hits, `M${i} appeared ${hits.length} times`).toHaveLength(1);
  }
});

it('does not deliver to a sink disposed before its replay arrives', async () => {
  const fanout = new PtyFanout(new TerminalMirror());
  fanout.feed(new TextEncoder().encode('hello\r\n'));
  const seen: Uint8Array[] = [];
  fanout.attach((bytes) => seen.push(bytes)).dispose();
  await new Promise((r) => setTimeout(r, 0));
  expect(seen).toHaveLength(0);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd v2 && pnpm --filter @shepherd/core test -- fanout`
Expected: FAIL — `PtyFanout` still takes a `PtyRing`.

- [ ] **Step 3: Implement**

Rewrite `fanout.ts`'s class body, keeping the existing file-level comment and
extending it:

```ts
import { toDisposable, type Disposable } from '@shepherd/sdk';
import { TerminalMirror, type ScreenState } from './mirror.ts';

/** Where a session's bytes go. One per attached view (a window, a phone, a tap). */
export type PtySink = (bytes: Uint8Array) => void;

/**
 * A session's output, kept as a SCREEN and fanned out.
 *
 * The contract worth naming — v1's PtyBroker held a lock across it and explained
 * it only in a comment — is that **snapshot, register and replay are one step**.
 * Split them and you get one of two bugs, neither of which shows up in a test
 * that attaches to an idle session:
 *
 *   - register after replaying  -> bytes written *during* the replay reach
 *                                  nobody. A gap, mid-screen.
 *   - snapshot after registering -> those same bytes arrive twice.
 *
 * R0 made that harder in a way the ring version could not express. The mirror
 * captures asynchronously (parsing lags the feed), so "one step" can no longer be
 * one synchronous block: a sink is registered in a BUFFERING state, the capture
 * is requested, and the buffer is flushed behind the snapshot when it lands. The
 * duplicate direction — which had no single-threaded expression against a ring,
 * and so was guarded only by an assertion that the replay appeared once — is now
 * a real, reachable bug, and `mirror.ts`'s `capture` comment is what prevents it.
 */
export class PtyFanout {
  readonly #mirror: TerminalMirror;
  readonly #sinks = new Set<PtySink>();
  /** Sinks awaiting their snapshot, and the live bytes that arrived meanwhile. */
  readonly #pending = new Map<PtySink, Uint8Array[]>();

  constructor(mirror: TerminalMirror = new TerminalMirror()) {
    this.#mirror = mirror;
  }

  get viewerCount(): number {
    return this.#sinks.size + this.#pending.size;
  }

  feed(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.#mirror.feed(bytes);
    // Iterate a copy: a sink is allowed to dispose itself (or attach another)
    // from inside its own callback.
    for (const sink of [...this.#sinks]) deliver(sink, bytes);
    // A sink still waiting for its snapshot must not miss these, and must not
    // receive them twice — they are after the capture point by construction.
    for (const buffered of this.#pending.values()) buffered.push(bytes);
  }

  /**
   * Registers `sink`, then replays the screen to it and goes live.
   *
   * Returns synchronously — the caller gets its `Disposable` in the same tick,
   * as it always did — but the first bytes now arrive on a later one. Disposing
   * before the snapshot lands cancels it; a viewer that has gone away must not
   * be handed 55 KB of screen.
   */
  attach(sink: PtySink): Disposable {
    const buffered: Uint8Array[] = [];
    this.#pending.set(sink, buffered);

    this.#mirror.capture((snapshot) => {
      // Disposed while the capture was in flight.
      if (!this.#pending.has(sink)) return;
      this.#pending.delete(sink);
      this.#sinks.add(sink);
      if (snapshot.length > 0) deliver(sink, snapshot);
      for (const bytes of buffered) deliver(sink, bytes);
    });

    return toDisposable(() => {
      this.#pending.delete(sink);
      this.#sinks.delete(sink);
    });
  }

  /** The screen as bytes, for a caller that wants it without attaching. */
  snapshot(sink: (bytes: Uint8Array) => void): void {
    this.#mirror.capture(sink);
  }

  screen(): ScreenState {
    return this.#mirror.screen();
  }

  resize(cols: number, rows: number): void {
    this.#mirror.resize(cols, rows);
  }

  clear(): void {
    this.#sinks.clear();
    this.#pending.clear();
    this.#mirror.dispose();
  }
}

/**
 * A viewer that throws must not cost the others their bytes, and must not stop
 * the mirror recording them — a dead IPC channel is the normal way this happens,
 * and it is the session's job to keep running when a window goes away.
 */
function deliver(sink: PtySink, bytes: Uint8Array): void {
  try {
    sink(bytes);
  } catch {
    // Swallowed on purpose. Logging belongs to whoever owns the sink.
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd v2 && pnpm --filter @shepherd/core test -- fanout`
Expected: PASS. Existing fanout tests that constructed `new PtyFanout(new PtyRing(...))`
need their argument swapped for a `TerminalMirror`; tests asserting *raw byte*
replay need rewriting to assert screen content — that change in expectation IS
the milestone, so update them rather than preserving them.

- [ ] **Step 5: Commit**

```bash
git add v2/packages/core/src/session/fanout.ts v2/packages/core/src/session/fanout.test.ts
git commit -m "feat(v2): an attaching viewer is handed a screen, not the last 256 KB"
```

---

### Task 3: `SessionHost` owns a mirror per session; the ring retires

**Files:**
- Modify: `v2/packages/core/src/session/host.ts`
- Modify: `v2/packages/core/src/session/index.ts`
- Delete: `v2/packages/core/src/session/ring.ts`, `v2/packages/core/src/session/ring.test.ts`
- Modify: `v2/packages/core/src/session/host.test.ts`

**Interfaces:**
- Consumes: `PtyFanout` (Task 2), `TerminalMirror` / `DEFAULT_SCROLLBACK` (Task 1).
- Produces: on `SessionHost` —
  `screen(id: SessionID): ScreenState | undefined`,
  `snapshot(id: SessionID, sink: (bytes: Uint8Array) => void): Result<void, SessionError>`.
  `SessionSpec.ringBytes` is replaced by `SessionSpec.scrollback`;
  `DEFAULT_RING_BYTES` is replaced by `DEFAULT_SCROLLBACK`.

- [ ] **Step 1: Write the failing tests**

Add to `host.test.ts`:

```ts
it('answers with the screen of a live session', async () => {
  const host = new SessionHost();
  const created = host.create({ cwd: process.cwd(), command: '/bin/echo', args: ['marker'] });
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  await new Promise((r) => setTimeout(r, 150));
  expect(host.screen(created.value.id)?.text ?? '').toContain('marker');
  host.dispose();
});

it('has no screen for a session that never existed', () => {
  const host = new SessionHost();
  expect(host.screen('nope' as SessionID)).toBeUndefined();
  host.dispose();
});

it('keeps the mirror the same size as the pty', () => {
  const host = new SessionHost();
  const created = host.create({ cwd: process.cwd(), command: '/bin/cat', cols: 80, rows: 24 });
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  expect(host.resize(created.value.id, 100, 30).ok).toBe(true);
  expect(host.screen(created.value.id)?.cols).toBe(100);
  expect(host.screen(created.value.id)?.rows).toBe(30);
  host.dispose();
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd v2 && pnpm --filter @shepherd/core test -- host`
Expected: FAIL — `host.screen is not a function`.

- [ ] **Step 3: Implement**

In `host.ts`:

1. Replace the `PtyRing` import with
   `import { TerminalMirror, DEFAULT_SCROLLBACK, type ScreenState } from './mirror.ts';`
2. Delete `export const DEFAULT_RING_BYTES = 256 * 1024;` and export
   `DEFAULT_SCROLLBACK` from `./mirror.ts` instead (re-export in `index.ts`).
3. In `SessionSpec` and `ResolvedSpec`, replace `ringBytes?: number` with:

```ts
  /**
   * Lines the host keeps behind the screen, per session. The host holds a real
   * VT emulator per session (see `mirror.ts`), so this is scrollback DEPTH, not
   * a byte budget — the v1 `ringBytes` it replaces was a recording length.
   */
  readonly scrollback?: number;
```

4. In `resolveSpec`, replace the `ringBytes` line with
   `scrollback: spec.scrollback ?? defaultScrollback,` and rename the parameter
   `defaultRingBytes` → `defaultScrollback` (default `DEFAULT_SCROLLBACK`).
5. In `SessionHostOptions`, rename `defaultRingBytes` → `defaultScrollback`, and
   the private field with it.
6. In `create`, build the fanout as:

```ts
      fanout: new PtyFanout(
        new TerminalMirror({
          cols: resolved.cols,
          rows: resolved.rows,
          scrollback: resolved.scrollback,
        }),
      ),
```

7. In `resize`, after `record.pty.resize(cols, rows);`, add:

```ts
    // The mirror is the authority on the screen, so it must be resized with the
    // pty and not merely told about it later — a program redrawing into the new
    // size would otherwise be parsed against the old one.
    record.fanout.resize(cols, rows);
```

8. Replace the existing `snapshot` method and add `screen`:

```ts
  /**
   * The screen as bytes, for a caller that wants it without attaching.
   *
   * Callback-shaped rather than a return value: the mirror captures at a point
   * in its write queue, and a synchronous getter would have to serialize a state
   * that may still be parsing. `mirror.ts`'s `capture` comment has the measured
   * reason this matters.
   */
  snapshot(id: SessionID, sink: (bytes: Uint8Array) => void): Result<void, SessionError> {
    const record = this.#sessions.get(id);
    if (!record) return err(unknownSession(id));
    record.fanout.snapshot(sink);
    return ok(undefined);
  }

  /** What is on this session's display right now. §4.1's `screen()`, in core. */
  screen(id: SessionID): ScreenState | undefined {
    return this.#sessions.get(id)?.fanout.screen();
  }
```

9. Delete `ring.ts` and `ring.test.ts`.

**On deleting `ring.test.ts`:** it held a 50 MB throughput test guarding an O(1)
append, and that property no longer exists to guard — the mirror replaced it, and
its cost is measured in the probe. Do not port the test to the mirror; port the
*intent* in Task 6's live run instead.

In `index.ts`, drop the `PtyRing` export and add:

```ts
export {
  TerminalMirror,
  DEFAULT_SCROLLBACK,
  type ScreenState,
  type TerminalMirrorOptions,
} from './mirror.ts';
```

- [ ] **Step 4: Run the full core suite**

Run: `cd v2 && pnpm --filter @shepherd/core test`
Expected: PASS. Fix any call site still naming `ringBytes` / `DEFAULT_RING_BYTES`.

Run: `cd v2 && pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add -A v2/packages/core/src/session v2/packages/core/src/index.ts
git commit -m "feat(v2): a session owns its screen; the byte ring retires"
```

---

### Task 4: Resize arbitration — a viewer is not a resizer

**Files:**
- Create: `v2/packages/core/src/session/viewport.ts`
- Create: `v2/packages/core/src/session/viewport.test.ts`
- Modify: `v2/packages/core/src/session/host.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Viewport { readonly cols: number; readonly rows: number }
  /** Undefined = nobody has an opinion; leave the pty's size alone. */
  export function arbitrate(viewports: readonly (Viewport | undefined)[]): Viewport | undefined;
  ```
  On `SessionHost`: `setViewport(id: SessionID, viewerId: string, viewport: Viewport | undefined): Result<void, SessionError>`.

- [ ] **Step 1: Write the failing test**

Create `v2/packages/core/src/session/viewport.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { arbitrate } from './viewport.ts';

describe('arbitrate', () => {
  it('leaves the size alone when nobody has an opinion', () => {
    expect(arbitrate([])).toBeUndefined();
    expect(arbitrate([undefined, undefined])).toBeUndefined();
  });

  it('takes the sole opinion', () => {
    expect(arbitrate([{ cols: 100, rows: 30 }])).toEqual({ cols: 100, rows: 30 });
  });

  it('ignores viewers with no opinion', () => {
    expect(arbitrate([undefined, { cols: 100, rows: 30 }, undefined])).toEqual({ cols: 100, rows: 30 });
  });

  // tmux's answer, and the right one: a size larger than a viewer's window is
  // content that viewer cannot see. Letterboxing the Mac beats clipping the phone.
  it('takes the smallest of each dimension independently', () => {
    expect(arbitrate([{ cols: 200, rows: 50 }, { cols: 60, rows: 80 }])).toEqual({ cols: 60, rows: 50 });
  });

  it('never returns a non-positive dimension', () => {
    expect(arbitrate([{ cols: 0, rows: 24 }, { cols: 80, rows: 24 }])).toEqual({ cols: 80, rows: 24 });
    expect(arbitrate([{ cols: 0, rows: 0 }])).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd v2 && pnpm --filter @shepherd/core test -- viewport`
Expected: FAIL — cannot resolve `./viewport.ts`.

- [ ] **Step 3: Implement**

Create `v2/packages/core/src/session/viewport.ts`:

```ts
/**
 * One pty has one size. No architecture changes that — mosh does not, tmux does
 * not, and neither does R0. What R0 changes is that the arbitration becomes an
 * explicit, testable decision rather than "whoever called resize last wins".
 *
 * v1 dodged this by allowing a single active viewer ("last attach takes over").
 * Once the phone and the Mac can watch one session at once, that is not
 * available, so:
 *
 *   - A viewer with no opinion never influences the size. That is v1's
 *     "viewer-not-resizer", which was already right — an extension tapping the
 *     stream, or a phone showing a read-only pane, must not reshape the pty
 *     under the person typing into it.
 *   - Among those with an opinion, the SMALLEST of each dimension wins: a size
 *     larger than a viewer's window is content that viewer cannot see, and
 *     letterboxing the big screen beats clipping the small one.
 *   - A sole viewer is trivially the smallest, so the local-only case behaves
 *     exactly as it did before this file existed.
 */

export interface Viewport {
  readonly cols: number;
  readonly rows: number;
}

export function arbitrate(viewports: readonly (Viewport | undefined)[]): Viewport | undefined {
  let cols = Number.POSITIVE_INFINITY;
  let rows = Number.POSITIVE_INFINITY;
  for (const viewport of viewports) {
    if (viewport === undefined) continue;
    // A zero or negative dimension is a view that has not been measured yet
    // (xterm's `fit()` answers null for an element with no box). It is an
    // absence of an opinion, not an opinion that the pty should be 0 wide.
    if (viewport.cols > 0) cols = Math.min(cols, viewport.cols);
    if (viewport.rows > 0) rows = Math.min(rows, viewport.rows);
  }
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return undefined;
  return { cols, rows };
}
```

- [ ] **Step 4: Run it**

Run: `cd v2 && pnpm --filter @shepherd/core test -- viewport`
Expected: PASS, 5 tests.

- [ ] **Step 5: Wire it into the host**

In `host.ts`, add to `SessionRecord`:

```ts
  /** viewerId -> the size that viewer wants, or undefined for "no opinion". */
  readonly viewports: Map<string, Viewport>;
```

initialised to `new Map()` in `create`. Add the method:

```ts
  /**
   * Declares what `viewerId` can display, and re-arbitrates. Passing `undefined`
   * withdraws the opinion — which is what a detaching viewer does, so a phone
   * that goes away stops constraining the Mac.
   */
  setViewport(id: SessionID, viewerId: string, viewport: Viewport | undefined): Result<void, SessionError> {
    const record = this.#sessions.get(id);
    if (!record) return err(unknownSession(id));
    if (viewport === undefined) record.viewports.delete(viewerId);
    else record.viewports.set(viewerId, viewport);

    const decided = arbitrate([...record.viewports.values()]);
    // Nobody has an opinion: leave the pty as it is rather than snapping it to a
    // default, which would reflow a running program for no reason.
    if (decided === undefined) return ok(undefined);
    return this.resize(id, decided.cols, decided.rows);
  }
```

and add `viewerId` cleanup — in `#reap`, `record.viewports.clear()`.

Export `arbitrate` and `Viewport` from `index.ts`.

- [ ] **Step 6: Test the wiring**

Add to `host.test.ts`:

```ts
it('sizes the pty to the smallest attached viewport', () => {
  const host = new SessionHost();
  const created = host.create({ cwd: process.cwd(), command: '/bin/cat', cols: 80, rows: 24 });
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  const id = created.value.id;

  host.setViewport(id, 'mac', { cols: 200, rows: 50 });
  expect(host.get(id)?.cols).toBe(200);

  host.setViewport(id, 'phone', { cols: 60, rows: 20 });
  expect(host.get(id)).toMatchObject({ cols: 60, rows: 20 });

  // The phone goes away; the Mac stops being letterboxed.
  host.setViewport(id, 'phone', undefined);
  expect(host.get(id)).toMatchObject({ cols: 200, rows: 50 });
  host.dispose();
});
```

Run: `cd v2 && pnpm --filter @shepherd/core test -- host`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add v2/packages/core/src/session
git commit -m "feat(v2): two viewers of one pty agree on a size, by a rule rather than by luck"
```

---

### Task 5: A background pane holds no terminal

**Files:**
- Modify: `v2/packages/app/src/renderer/pane-sessions.ts`
- Modify: `v2/packages/app/src/renderer/pane-sessions.test.ts`
- Modify: `v2/packages/app/src/renderer/split-view.tsx` (or wherever inactive roots are hidden)

**Interfaces:**
- Consumes: nothing new from core — the snapshot already arrives as bytes on
  `session:data`, so this task is entirely renderer-side.
- Produces: `PaneTerminals.suspend(paneId: PaneID): void` and
  `PaneDiagnostics.suspended: boolean`.

**Why this is in R0 and not a follow-on:** it is what makes the mirror pay for
itself. Probe p6: renderer memory 40.7 MB → 2.0 MB and IPC 4 MB/s → 0.2 MB/s at
20 panes with one visible, with CPU a wash. `pane-sessions.ts`'s own comment
names the constraint that blocked it — *"a design that disposed the terminal
would … rely on main's 256 KB replay ring to redraw it: fine for a short session,
and for a long one it silently loses everything older than the ring."* The mirror
removes exactly that.

**Scope, precisely:** this applies to panes in a **non-active root**, which the
app keeps mounted and hides with `display: none` (see `LayoutSnapshots` in
`channels.ts`). It does NOT apply to `detach`, which is React reparenting a
*visible* pane during a split or close — that must stay a bare `appendChild`,
and the existing comment explaining why stays true.

- [ ] **Step 1: Write the failing test**

Add to `pane-sessions.test.ts`:

```ts
it('suspend drops the terminal and stops the stream, and never kills', async () => {
  const harness = makeHarness();               // the file's existing helper
  harness.registry.attach(pane, host);
  await harness.registry.settled();

  harness.registry.suspend(pane.id);
  await harness.registry.settled();

  expect(harness.registry.inspect(pane.id)?.suspended).toBe(true);
  expect(harness.registry.inspect(pane.id)?.streaming).toBe(false);
  expect(harness.session.detached).toContain(harness.registry.inspect(pane.id)?.sessionId);
  // The rule the whole registry exists for.
  expect(harness.session.killed).toEqual([]);
});

it('re-attaching a suspended pane rebuilds it from the snapshot', async () => {
  const harness = makeHarness();
  harness.registry.attach(pane, host);
  await harness.registry.settled();
  const sessionId = harness.registry.inspect(pane.id)?.sessionId;

  harness.registry.suspend(pane.id);
  await harness.registry.settled();
  harness.registry.attach(pane, host);
  await harness.registry.settled();

  expect(harness.registry.inspect(pane.id)?.suspended).toBe(false);
  expect(harness.registry.inspect(pane.id)?.streaming).toBe(true);
  // Adopted, not recreated: a suspended pane must not spawn a second pty.
  expect(harness.registry.inspect(pane.id)?.sessionId).toBe(sessionId);
  expect(harness.session.created).toHaveLength(1);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd v2 && pnpm --filter @shepherd/app test -- pane-sessions`
Expected: FAIL — `registry.suspend is not a function`.

- [ ] **Step 3: Implement**

Add `suspended: boolean` to `Entry` (initialised `false`), add `suspended` to
`PaneDiagnostics`, declare `suspend` on `PaneTerminals`, and implement:

```ts
  /**
   * The pane is mounted but not visible — it lives in a root the window is not
   * showing. Drop its terminal and stop its stream; keep its session, its id and
   * its place in the registry.
   *
   * This is NOT `detach`. `detach` is React reparenting a pane you can still see
   * (splitting, closing a sibling), and it must stay a bare unparent — see the
   * class comment. This is the case that used to be impossible: before the host
   * held a screen, a pane that stopped listening could never catch up, so every
   * mounted pane parsed and rendered forever. Measured at 20 panes with one
   * visible: renderer memory 40.7 MB -> 2.0 MB, IPC 4 MB/s -> 0.2 MB/s
   * (docs/superpowers/probes/2026-08-09-r0, p6).
   */
  suspend(paneId: PaneID): void {
    const entry = this.#entries.get(paneId);
    if (entry === undefined || entry.closed || entry.suspended) return;
    entry.suspended = true;
    entry.wantStream = false;
    this.#teardownView(entry);
    this.#sync(entry, 'suspend');
  }
```

In `attach`, clear the flag before the terminal is rebuilt:

```ts
    // Waking a suspended pane. `sessionId` is deliberately left alone: the
    // session outlived the view, and `#sync` will re-attach and be handed the
    // screen it missed.
    entry.suspended = false;
```

In `inspect`, add `suspended: entry.suspended`.

- [ ] **Step 4: Run the tests**

Run: `cd v2 && pnpm --filter @shepherd/app test -- pane-sessions`
Expected: PASS.

- [ ] **Step 5: Call it from the view**

In the component that mounts every root and hides inactive ones, call
`terminals.suspend(paneId)` for each pane of a root that has just become
inactive, and rely on the existing `attach` when it becomes active again.

Run: `cd v2 && pnpm --filter @shepherd/app test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add v2/packages/app/src/renderer
git commit -m "feat(v2): a pane you cannot see costs a session id and nothing else"
```

---

### Task 6: The live run

**Files:**
- Create: `v2/packages/app/src/main/smoke-mirror.ts`
- Create: `v2/tooling/scripts/smoke-mirror.mjs`
- Modify: `v2/packages/app/src/main/smoke-registry.ts`
- Modify: `v2/package.json` (add `smoke:mirror`)

**Interfaces:**
- Consumes: everything above, through the real IPC in a real Electron process.

**Why:** every prior milestone's first live run found something no unit test did —
the CLI's wrong route, the composer's hardcoded repo name, three findings from the
view mechanism. The unit tests above drive a mirror; this drives a *pty running
vim*, which is the case the whole design is for.

- [ ] **Step 1: Write the smoke**

Model it on `smoke-terminal.ts`. It must:

1. Create a session running the login shell.
2. Write `vim` (or `less` on a generated file if vim is absent — check with
   `which`) and wait for the alt screen: poll `host.screen(id)?.altScreen === true`,
   with a deadline, rather than sleeping a fixed time.
3. Type recognisable content into it.
4. **Attach a second, cold viewer** and collect its bytes.
5. Feed those bytes into a fresh `TerminalMirror` and assert its `screen().text`
   contains the typed content **and** that `altScreen` is true — i.e. the cold
   viewer got the vim screen, not a stream of escape codes it could not
   reconstruct.
6. Assert no byte sequence is delivered twice: while the cold viewer is
   attaching, keep writing markers, and assert each appears exactly once in the
   concatenated delivery (the Task 2 property, now through real IPC and a real pty).
7. Quit vim cleanly and assert `altScreen` returns to false.

- [ ] **Step 2: Register and script it**

Add the entry to `smoke-registry.ts` alongside the others, create
`tooling/scripts/smoke-mirror.mjs` mirroring `smoke-terminal.mjs`, and add to the
root `package.json`:

```json
    "smoke:mirror": "node tooling/scripts/smoke-mirror.mjs",
```

- [ ] **Step 3: Run it**

Run: `cd v2 && env -u NODE_OPTIONS pnpm smoke:mirror`
Expected: PASS.

**Expect this step to fail the first time and to teach you something.** Record
what it was in the commit message — that is the habit that has caught a real bug
in every milestone so far.

- [ ] **Step 4: Run every gate**

Run: `cd v2 && pnpm typecheck && pnpm lint && pnpm -r test`
Then all nine smokes: `smoke`, `smoke:session`, `smoke:terminal`,
`smoke:isolation`, `smoke:single-instance`, `smoke:m1`, `smoke:m2`, `smoke:m3`,
`smoke:mirror` — each with `env -u NODE_OPTIONS`.
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add v2/packages/app/src/main/smoke-mirror.ts v2/tooling/scripts/smoke-mirror.mjs \
        v2/packages/app/src/main/smoke-registry.ts v2/package.json
git commit -m "test(v2): a cold viewer attaching to a running vim gets vim"
```

---

## Done when

- A viewer attaching to a session running a full-screen app repaints correctly,
  with no gap and no duplicate under load — asserted in a unit test and in a live
  Electron run against a real pty.
- `SessionHost.screen()` exists, which is §4.1's third tier arriving two
  milestones early and for free.
- Two viewers of one session agree on a size by `arbitrate`, not by luck.
- A pane in a hidden root holds no terminal and receives no bytes.
- `pnpm typecheck`, `pnpm lint`, `pnpm -r test` and all nine smokes are green.

## What R1 inherits

`PtyFanout.attach` is now the whole client contract: register, receive a screen,
receive live bytes. Nothing in it is in-process — the snapshot is bytes and the
stream is bytes. R1 moves `SessionHost` behind a unix socket and Electron becomes
the first remote client of it; R2 gives the same contract a TLS transport and a
pairing handshake, and the phone becomes the second.
