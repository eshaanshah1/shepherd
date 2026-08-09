# Probe: host-authoritative terminal mirror (R0) — 2026-08-09

Run: `node p1.mjs`, `node --expose-gc p2.mjs`, `node p3.mjs`, `node p4.mjs`, `node p5.mjs`
(needs `@xterm/headless@6.0.0` + `@xterm/addon-serialize@0.14.0` in a scratch dir).

Committed because **p4 refuted the attach algorithm** the design was about to be
written around, and p3 overturned p2's own headline number. Both are the ADR 0021
habit: measure the thing before depending on it.

## What was asked, and what came back

### p1 — is a serialized screen a faithful repaint?

The whole design rests on replacing v1's byte ring with a serialized screen. Fed
six scenarios into terminal A, serialized, fed that into a fresh terminal B, and
compared every cell **including SGR attributes**, plus cursor position and buffer
type.

| scenario | grid identical | cursor | buffer type |
|---|---|---|---|
| SGR colour + bold | yes | yes | normal |
| 200 lines into scrollback | yes | yes | normal |
| **alt screen (vim-like, `?1049h`)** | **yes** | yes | **alternate → alternate** |
| wide chars, ZWJ emoji, combining marks | yes | yes | normal |
| cursor parked mid-grid | yes | yes | normal |
| 250-char wrapped line | yes | yes | normal |

**The alt-screen row is the point.** It is the case the v1 remote design lists as
its accepted limitation ("full-screen apps across a *cold* reconnect may need one
redraw — the known bounded-ring limitation we accept"). A serialized screen does
not have it. That limitation is deleted, not mitigated.

### p2/p3 — what does one emulator per session cost?

**p3 exists because p2's throughput figure was wrong.** p2 awaited every
`write()`. xterm's write is asynchronous and drains on an internal timer, so
awaiting each chunk measures **one timer tick per chunk** (~1.3 ms), not parsing —
it reported 0.8 MB/s, which is the event loop, not the emulator. A pty pushes
without waiting. p3 pushes everything and awaits only the last callback:

| | p2 (wrong) | p3 (correct) |
|---|---|---|
| plain text | 0.8 MB/s | **82 MB/s** |
| heavy SGR | 0.6 MB/s | **69 MB/s** |
| full-screen redraw | 3.2 MB/s | **108 MB/s** |
| 20 terminals fed concurrently | — | **104 MB/s aggregate** |

Absorbing one second of a chatty agent (200 KB/s, at the heavy-SGR rate) costs
**2.9 ms of CPU — 0.29% of one core**. Twenty concurrent sessions do not
degrade the per-terminal rate, which is what matters when they share the host's
one event loop.

`serialize()` is on the attach path, so it was measured separately:

| scrollback asked for | ms/call | snapshot size |
|---|---|---|
| 0 (visible screen only) | 0.41 | 2.6 KB |
| 1000 lines | 3.17 | 68 KB |
| 5000 lines | 15.0 | 330 KB |

Memory: **~2 MB per terminal** holding a full 5000-line scrollback (30 terminals,
60.8 MB heap delta).

**Reading:** 1000 lines is the default worth picking — 3 ms and 68 KB per attach,
against 15 ms and 330 KB for 5000. The knob is per-attach, so a phone on a slow
link can ask for less without the host holding less.

### p4 — the attach algorithm. **REFUTED.**

`PtyFanout`'s existing contract is "snapshot, register and replay are one step";
split them and you get a gap or a duplicate. A host-side emulator makes that
harder, because `serialize()` reflects only what has been **parsed**, and parsing
lags the feed.

The algorithm about to be written into the design was:

```js
const barrier = new Promise((resolve) => term.write('', resolve));
// ... live bytes arrive and are buffered ...
await barrier;
snapshot = serializer.serialize();
```

p4 fed 400 markers, attached, then fed 400 more **during the barrier window**,
and checked the reconstruction for gaps and duplicates. Result:

```
duplicatedMarkersInReplay: M577 … M799     (223 markers)
VERDICT: BARRIER ALGORITHM IS UNSOUND — redesign the attach path
```

**Why.** `await` resumes on a microtask. xterm's `_innerWrite` fires the
callback and then **keeps parsing synchronously**, so by the time the awaiting
continuation ran, every later chunk was already in the grid — and those same
chunks were also sitting in the buffer waiting to be delivered after the
snapshot. Every attach that landed inside a burst would double-print the burst.

This is precisely the failure mode `fanout.ts` warns about, in its new disguise:
the ring version has no single-threaded expression of the duplicate direction, so
it was never going to be caught by porting the old test.

### p5 — the repair, verified

Capture **synchronously inside the callback**, at the barrier's own position in
the write queue, rather than a microtask later:

```js
term.write('', () => { snapshot = serializer.serialize({ scrollback }); });
```

Checked under both orderings — the whole burst already queued in one synchronous
block (p4's worst case), and bytes spread across ticks (what a real pty does):

| ordering | snapshot ends exactly at the barrier | duplicates | gaps |
|---|---|---|---|
| burst already queued | yes | 0 | 0 |
| spread across ticks | yes | 0 | 0 |

**Consequence for the design:** `TerminalMirror.snapshot()` may not be an
`async` function that awaits a barrier. It takes a callback, or returns a promise
resolved with an already-captured value — but the `serialize()` call itself is
synchronous inside the write callback, and a test must assert the no-duplicate
property directly, because it is invisible to a test that attaches to an idle
session.

### p6 — does the mirror cost or save?

The fair objection to p3's numbers: the renderer keeps its own emulator under D1,
so the host mirror is a **duplicate parse**, not a replacement. p6 prices the
whole ledger instead of one term.

The claim under test is that a host-authoritative screen lets a **hidden pane
drop its terminal entirely** and re-materialize from a snapshot when shown —
which today is impossible, because a pane that stopped listening could never
catch up. 20 panes, one visible, each agent at a generous 200 KB/s:

| | current | proposed | delta |
|---|---|---|---|
| CPU | 14.6% of a core | 15.3% | **+5%** |
| renderer memory (in the page) | 40.7 MB | 2.0 MB | **−95%** |
| IPC to renderer | 4 MB/s | 0.2 MB/s | **−95%** |
| host memory | 5.1 MB | 10.5 MB | +5 MB |
| panes **rendering** | 20 | 1 | not measured — the largest term |
| cost to switch panes | — | one 55 KB snapshot | |

**CPU is a wash**, because the parse largely *moves* from renderer to host rather
than doubling — and the current architecture already pays that 14.6%. Everything
else improves by an order of magnitude.

Rendering could not be measured (it needs a DOM), and it is removed for 19 of 20
panes, so every figure above is a **lower bound** on the saving.

Two numbers this corrected from p2: a mirror at the design's 1000-line default
holds **0.52 MB**, not the 2 MB p2 measured at 5000 lines; and the snapshot is
55 KB rather than 68 KB at the same depth.

**Consequence for the plan:** "a background pane is snapshot-only" is not a
follow-on optimization. It is the task that makes this design pay for itself, and
it belongs in R0.

## Incidental finding

`@xterm/headless` and `@xterm/addon-serialize` are **CommonJS**, with no ESM
named exports:

```
SyntaxError: Named export 'Terminal' not found. The requested module
'@xterm/headless' is a CommonJS module...
```

Every package in v2 is `"type": "module"`, so the mirror must default-import and
destructure (`import headless from '@xterm/headless'; const { Terminal } = headless;`).
Worth knowing before it appears as a runtime failure in the main process.
