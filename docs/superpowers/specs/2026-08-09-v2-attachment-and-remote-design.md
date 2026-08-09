# v2: the attachment protocol, the session daemon, and remote — design

**Date:** 2026-08-09
**Status:** Approved design; R0 planned, R1–R3 to be planned at their gates.
**Supersedes for this area:** the `Lean:` in
[`ade-minimal-core-sketch.md`](2026-08-06-ade-minimal-core-sketch.md) §7.7
("bytes now, protocol shaped so screen-state can slot in behind it; daemon
decided by whether headless tasks are v2.0 or v2.1"). Both halves are now
decided the other way, deliberately, and this document says why.
**Probe evidence:** [`../probes/2026-08-09-r0/`](../probes/2026-08-09-r0/) —
committed, because one of its findings refuted the attach algorithm this design
was going to be written around.

---

## 1. The ask, and what it actually changes

> "You might have to do that thing where we completely separate the UI from the
> pty… That would mean the phone is just another client for the same pty, and
> not some special integration."

That sentence is a **protocol** requirement, not a feature request. v1 built
remote as a *second way to see a terminal*: `shepherdd pty` teed bytes to a
network socket, `shepherdd attach` piped them back, and the phone got its own
control channel, its own message vocabulary, and its own place in the
architecture. Three things then had to agree about what a pane was, and they
drifted — which is the whole reason `applyRemoteCommand` exists alongside
`controlRoute` and `ShortcutActions` (review §Bad-2).

v2 already has the hard half. `SessionHost` owns ptys, `PtyFanout` already fans
one session's bytes to N sinks, and `host.ts`'s own doc comment already states
the rule: *"A session outlives its view. Nothing here is created or destroyed by
a window, a pane, or a React unmount."* A phone is a sink. The gap is not
plumbing.

The gap is that **the bytes are not a viewable thing on their own.** A sink gets
a 256 KB ring replay, which is a recording of a stream, not a description of a
screen — so a viewer must have watched from the beginning to be correct. Every
consequence follows from that one fact: the cold-reconnect redraw v1 accepted as
a limitation, the absence of a `screen()` extension API, and the reason the phone
needed a bespoke integration in the first place.

So the change is: **the host holds the authoritative terminal state, and an
attachment is a self-describing thing.** Once an attach hands over a correct
screen, "the phone is another client" stops being an integration and becomes a
tautology.

## 2. Three decisions (2026-08-09)

### D1 — Host-authoritative emulator; clients keep their own renderers

§7.7b framed this as A-or-B: raw bytes with per-viewer emulation, or "a headless
VT emulator in the host with grid-state diffs to viewers (mosh-style)". The
literal B is **not** chosen, and the reason is that its cost lands somewhere it
buys nothing.

Grid-state diffs make clients dumb cell renderers. xterm.js cannot consume cell
state, so B means writing a grid renderer for the Mac UI and throwing away
xterm's selection, search, link detection and ligature handling — and writing a
second one for the phone, which already has a working emulator. What it buys is
thin clients. We do not have a thin-client problem; we have a
*correct-screen-on-attach* problem.

**Chosen: the host runs `@xterm/headless` per session as the authority; an
attachment is `[serialized screen][live bytes…]`; clients keep their own
emulators.** Same protocol for the renderer and the phone. This is B's
*authority* without B's *renderer rewrite* — and it is strictly better than A on
the property that motivated the ask.

Measured, not assumed ([probe](../probes/2026-08-09-r0/) p1/p3):

- A serialized screen round-trips **cell-identical including the alt screen**.
  That deletes v1's accepted limitation ("full-screen apps across a cold
  reconnect may need one redraw"), rather than mitigating it.
- 69–108 MB/s per emulator; 104 MB/s aggregate across 20 fed concurrently.
  A chatty agent costs **0.29% of one core**. ~2 MB per terminal at a 5000-line
  scrollback.
- `serialize()` at 1000 lines: 3.2 ms, 68 KB. That is the default; the depth is a
  **per-attach** parameter, so a phone on a slow link asks for less without the
  host keeping less.

The `screen()` API §4.1 defers to post-M4 falls out for free: it is a read of the
mirror, and it stops being "B-lite, on-demand" and becomes the thing that is
already running.

**And it pays for itself, which was not obvious.** The fair objection is that the
renderer keeps its own emulator, so the mirror is a *duplicate* parse. p6 prices
the whole ledger at 20 panes with one visible, and the duplicate-parse worry
turns out to be the smallest term:

| | current | proposed | delta |
|---|---|---|---|
| CPU | 14.6% of a core | 15.3% | **+5%** |
| renderer memory (in the page) | 40.7 MB | 2.0 MB | **−95%** |
| IPC to renderer | 4 MB/s | 0.2 MB/s | **−95%** |
| host memory | 5.1 MB | 10.5 MB | +5 MB |
| panes **rendering** | 20 | 1 | not measured — the largest term |

CPU is a wash because the parse largely *moves* rather than doubles. The rest is
an order of magnitude, and it comes from a capability today's architecture cannot
have: **a hidden pane can drop its terminal and re-materialize from a 55 KB
snapshot**, because the host can now describe a screen rather than only replay a
stream. Today every mounted pane must keep parsing forever, since one that
stopped listening could never catch up — which is exactly what `channels.ts`
means by "the renderer then spends its frame budget in IPC deserialization rather
than in xterm".

So "a background pane is snapshot-only" is **not** a follow-on optimization. It
is the task that turns this design from a tax into a win, and it is in R0.

### D2 — Sessions move to a daemon now

§7.7a left this to "whether headless tasks are v2.0 or v2.1". Decided: **now**,
because remote is what makes it load-bearing rather than nice.

With sessions in Electron's main process, every UI restart kills every running
agent — and once a phone is attached, a Mac-side restart also drops the phone,
which turns "I updated the app" into "my remote session died". The daemon is also
what makes D1's protocol honest: the moment the renderer reaches sessions over a
socket instead of an in-process object, "the phone is just another client" is
enforced by the architecture rather than promised by it. A protocol with exactly
one in-process consumer is a protocol nobody has tested.

The daemon is **the Electron binary re-executed with `ELECTRON_RUN_AS_NODE=1`**,
not a separate Node. That keeps one runtime, one node-pty build against one ABI
(ADR 0021's whole point), and `node:sqlite` where it already is.

### D3 — Port v1's protocol shape onto v2's nouns

The Android app already implements framed TLS, pairing with approve, cert
pinning, backoff reconnect, and a JSON message vocabulary. That is real,
debugged work and it is not thrown away.

What is **not** carried over is v1's nouns. `ControlMessage` speaks
`WorkspaceTree`/`RemoteTab`/`RemotePane` because v1's model had workspaces and
tabs; v2's core has neither — it has a layout tree, sessions, commands and
events, and extensions own everything above that. Byte-pinning the old messages
would drag v1's model into v2's kernel, which is the one thing the whole rewrite
exists to avoid.

So: **keep the transport and handshake design, re-map the message payloads onto
v2's nouns, version the protocol explicitly.** The Android delta is real but
bounded, and it lands mostly in `protocol/` and `transport/`.

## 3. The shape

```
                    ┌──────────────────────── shepherdd (daemon) ────────────┐
                    │                                                        │
   pty ────────────►│  SessionHost ──► PtyFanout ──► TerminalMirror          │
                    │                      │         (@xterm/headless,       │
                    │                      │          the authority)         │
                    │                      ▼                                 │
                    │              ┌── Attachment ──┐                        │
                    │              │ [screen][live] │                        │
                    └──────────────┴────────┬───────┴────────────────────────┘
                                            │  ONE protocol, N transports
                        ┌───────────────────┼───────────────────┐
                        ▼                   ▼                   ▼
                  unix socket           TLS + pairing      (extension-supplied
                        │                   │               endpoints: LAN,
                        ▼                   ▼               tailnet)
                Electron main         Android client
                        │
                        ▼
                  renderer (xterm.js)
```

The two boxes at the bottom are peers. Neither is "the real one".

### Resize: the honest part

One pty has one size. No architecture changes that — mosh does not, tmux does
not, and D1 does not. What changes is that the arbitration becomes **explicit and
testable** instead of implicit in whoever called `resize` last.

An attachment declares a viewport or declares itself a **viewer** (no opinion).
The host picks by a pure decision function, ported from v1's arbitration
finding and kept in one place:

- Attachments that declare no viewport never influence the size. (v1's
  "viewer-not-resizer", which was already right.)
- Among those that do, **the smallest wins** — a size larger than a viewer's
  window means content it cannot see, and clipping the phone is worse than
  letterboxing the Mac. This is tmux's answer and it is the correct one for the
  multi-viewer case v1 dodged by allowing only one.
- A sole attachment is trivially the smallest, so the local-only case is
  unchanged in behaviour.

## 4. Milestones

Each ships and is testable alone. Only R0 is planned in detail; the rest get
their plan at their gate, because R0's live run will teach things the way every
prior milestone's did.

| | What | Gate |
|---|---|---|
| **R0** | `TerminalMirror` + the attachment protocol, in-process. Renderer switched onto it. `screen()` exposed. Resize arbitration. | A cold attach to a running `vim` repaints correctly, with no gap and no duplicate under load. |
| **R1** | `packages/daemon`. Sessions leave the main process; Electron becomes a client over a unix socket. | Quit and relaunch the app; the agents are still running and the panes reattach. |
| **R2** | `packages/remote`. Framed protocol, pairing + approve, device store, TLS + pinning, transport-agnostic `Endpoint`. Loopback E2E. | Two v2 instances over loopback: pair, attach, type, drop, reconnect, repaint. |
| **R3** | Android onto the v2 protocol; `remote-lan` / `remote-tailscale` as extensions. | The phone drives a real agent on the Mac. |

**Why R1 before R2:** remote does not strictly need the daemon, but building
remote first would mean building it against an in-process host and then moving
it — and the daemon is the thing that proves the protocol has no privileged
consumer. Doing it second means writing the transport twice.

## 5. What core is allowed to grow

`boundaries.js` denies `@xterm/*` in core with "xterm is a renderer concern; core
owns bytes, not views." D1 makes that sentence false in one specific way, so the
rule is widened **deliberately and narrowly** (the handoff's instruction: widen
with the reason in the rule's own comment):

- `@xterm/headless` and `@xterm/addon-serialize` become importable in
  `packages/core/src/session/` **only**. They are a VT state machine, not a view —
  headless has no DOM in its graph, which is the property that made the original
  rule right and keeps it right for `@xterm/xterm`.
- `@xterm/xterm` stays denied in core, everywhere. The renderer draws.

Both are CommonJS ([probe](../probes/2026-08-09-r0/), incidental finding), so the
import is a default-import-and-destructure in a `"type": "module"` package.

## 6. The one contract that is easy to get wrong

`fanout.ts` already documents it: *snapshot, register and replay are one step* —
split them and you get a gap (register after replaying) or a duplicate (snapshot
after registering). A host emulator makes it harder, because `serialize()`
reflects only what has been **parsed**, and parsing lags the feed.

Probe p4 **refuted** the obvious algorithm:

```js
const barrier = new Promise((resolve) => term.write('', resolve));
await barrier;
snapshot = serializer.serialize();     // ← 223 chunks too late
```

`await` resumes on a microtask; xterm's `_innerWrite` fires the callback and
keeps parsing **synchronously**. Every attach landing inside a burst
double-prints the burst.

The repair (p5, verified under both orderings) is to capture **synchronously
inside the write callback**, at the barrier's own position in the queue:

```js
term.write('', () => { snapshot = serializer.serialize({ scrollback }); });
```

So `TerminalMirror.snapshot()` **may not be an `async` function that awaits a
barrier**, and the no-duplicate property must be asserted directly — a test that
attaches to an idle session cannot see it, which is exactly how this class of bug
has survived before (M3's three gates that passed without checking anything).

## 7. Deferred, on purpose

- **Grid-diff streaming (literal §7.7b).** The mirror is the thing that would
  produce the diffs; if a client ever wants them, it is a new frame type on an
  existing protocol, not a redesign. D1 buys that option rather than spending it.
- **Predictive echo.** Approach-3 territory in v1's design, and still is.
- **Multi-viewer co-presence beyond shared sight.** Two people typing into one
  pty is a pty problem, not a protocol one.
- **Structural mutation from the phone.** v2 makes this nearly free — every
  mutation is already a command with an attributed `Caller`, and
  `caller.kind === 'device'` already exists in the type. It is deferred because it
  is an authorization question (which commands may a device invoke?), not a
  transport one, and it should be answered once with the grants model rather than
  twice.
