# Android client Phase 2 — per-pane PTY data channels + terminal view/input

**Date:** 2026-07-02
**Status:** Design (approved). Spans two codebases (`spike/seam1` host + `android/` app).
**Prereq context:** builds on [`2026-06-30-android-client-design.md`](2026-06-30-android-client-design.md)
(the overall Android-client design — read §4/§5/§6 first) and on shipped **Phase 1**
(host control channel + pairing + FCM push + Android monitor app, on `master` as `6c1f304`)
and **M0** (`shepherdd pty` helper + serve toggle, on `master`).

> **Resuming across sessions:** read the whole file, then the "Status / progress"
> section at the bottom. Host work lives in `spike/seam1`; the Android app in `android/`.

---

## 1. Goal

Close Phase 1's loop: the phone can already *see* the fleet and get *pushed* when an
agent needs you. Phase 2 lets you **tap in and respond** — open an agent, read its
live screen, and send input (answer an `AskUserQuestion`/permission/plan menu, submit
a new prompt, run a command). Input is **raw PTY bytes**, so no special "respond" API
is needed: the phone drives the same PTY Claude runs on.

**In scope (v1):** type into *existing* panes on the host. **Out of scope:** spawning
or structurally changing panes from the phone (deferred "remote structural control"),
smart Approve/Deny buttons (deferred convenience layer over the faithful terminal).

## 2. Decisions (the "why", so future sessions don't relitigate)

- **Data path = helper dials the app; the app buffers & brokers (Option A).** The
  `shepherdd pty` helper is spawned per pane *by libghostty* (via `remoteSurfaceCommand`)
  **only when `isServing` is true**, so it is dumb: it dials the app, streams its tee'd
  PTY output up, and writes input it receives down to the inner PTY. The **app** owns the
  per-pane replay ring, fan-out to multiple viewers, and nonce gating — all in testable
  Swift, not in the helper binary. The "output always crosses one IPC hop" cost only
  exists while you are *already* serving remotes (no serving ⇒ no helper ⇒ no tee ⇒ zero
  cost), which neutralizes the only downside of Option A vs. a helper-owns-the-buffer design.
- **Helper streams always (while serving); the app keeps a bounded per-pane ring.**
  Ring ≈ **256 KB/pane**, always filled. So a phone attaching to a *blocked* agent
  immediately gets recent screen state (the `AskUserQuestion` menu, prompt, etc.) with no
  attach-gating race. YAGNI on attach-gated buffering.
- **Data channel = a separate TCP connection per pane, nonce-authorized.** Not multiplexed
  over the control channel — that would head-of-line-block bulk PTY bytes behind control
  frames and fight the control connection's serial write queue. The `sessionNonce` the
  control handshake already mints (currently issued in `admit()` but **unused/unstored**)
  becomes the capability token: a data channel must present a nonce tied to a **live,
  approved control session**. This is the app-layer auth on top of Tailscale — a tailnet
  device still cannot attach to a stream without an approved pairing.
- **Viewer-not-resizer, confirmed in the wire.** `DataReady` carries the host pane's
  current `cols×rows`; the Android emulator sizes to that and pans/zooms. The phone
  **never** sends winsize; the helper ignores any resize from the data channel. Glancing
  from the phone never reflows the desktop view.
  > **SUPERSEDED for sub-project B (2026-07-02) — see §5.1 "Resize model".** Viewer-not-
  > resizer is fine for the host half + monitoring, but it makes *responding* to a wide
  > full-screen TUI (Claude's alt-screen menus/plan/`AskUserQuestion`) bad on a phone: a
  > TUI frame is a fixed `cols×rows` cell matrix that **cannot** be reflowed client-side,
  > so the phone is stuck pan/zooming a desktop-shaped grid. The client slice adopts
  > **winsize-follows-the-active-driver (desktop wins ties)** instead. Keep the host-side
  > mechanics here (`DataReady{cols,rows}`); §5.1 makes size dynamic + bidirectional.
- **Android terminal = Termux `terminal-emulator` + `terminal-view`, driven by the socket.**
  Bypass Termux's local-process `TerminalSession` (JNI/PTY-coupled); drive a `TerminalEmulator`
  directly — feed data-channel bytes via `append(...)`, route `TerminalView` key/text input
  to the socket. Apache-2.0.
- **Raw bytes after a one-frame handshake.** Both new links (helper↔app, phone↔app) open
  with a single length-prefixed hello frame, then are **raw duplex PTY bytes** — no per-frame
  tagging (each link is dedicated to one pane; direction disambiguates output vs. input).

## 3. Architecture

```
                         ┌─────────────────── macOS host (spike/seam1) ───────────────────┐
 phone (android/)        │                                                                  │
 ┌───────────────┐       │  RemoteServer                        shepherdd pty (per pane)    │
 │ TerminalView  │       │  ┌────────────────────────┐          ┌───────────────────────┐  │
 │  + TerminalEmu│◀──────┼─▶│ control conn (Phase 1)  │          │ pump: outer PTY ⇄ inner│  │
 │  DataChannel  │  TCP   │  │  nonce store           │          │        PTY (Claude)    │  │
 │  client       │(tailnet)  │ per-pane PtyBroker:    │◀────────▶│  Tee ─▶ dial PTY sock  │  │
 └───────────────┘       │  │   ring(256KB)          │  unix    │  input ◀── PTY sock    │  │
                         │  │   viewers[] (fan-out)  │  socket  └───────────────────────┘  │
                         │  └────────────────────────┘  ($SHEPHERD_PTY_SOCK)               │
                         └──────────────────────────────────────────────────────────────────┘
```

Two new seams, symmetric (one hello frame, then raw duplex):

1. **Helper ↔ app (unix socket, `$SHEPHERD_PTY_SOCK`):** the app listens on a dedicated
   unix-domain socket whose path is injected into each pane's PTY env alongside the existing
   `$SHEPHERD_SOCK`/`$SHEPHERD_TAB_ID`. This is **separate** from `$SHEPHERD_SOCK` (which
   carries newline-delimited JSON hook events for the state machine) — raw high-volume PTY
   bytes must not share that channel. The helper dials it on startup, sends `PtyHello{paneID, cols, rows}`,
   then: helper→app = tee'd output; app→helper = input to inject into the inner PTY master.
2. **Phone ↔ app (TCP over tailnet):** the phone opens a *second* socket (control channel
   stays up), sends `DataHello{sessionNonce, paneID}`; the app validates and replies
   `DataReady{cols, rows}` (or closes on reject); then phone→app = input, app→phone = output.

The **app is the broker in the middle**: per pane it holds a `PtyBroker` = the helper
connection + a 256 KB ring + the set of attached phone viewers. On phone attach it replays
the ring, then live-forwards; phone input is forwarded to the helper; helper output is
appended to the ring and fanned out to all viewers.

## 4. Host design (`spike/seam1`)

Mirrors the pure-model / AppKit-shell split, like the rest of the remote code.

### 4.1 Protocol (`RemoteProtocol.swift` — pure, `ShepherdModelTests`)
Add the data-channel handshake DTOs + framing. These use the **same** `[u32 BE len][json]`
frame codec as `ControlMessage`, but are their own small enum so the control and data
protocols stay independent:

```
enum DataMessage: Codable, Equatable {
    case dataHello(sessionNonce: String, paneID: String)   // phone → app
    case dataReady(cols: Int, rows: Int)                   // app → phone
    case dataRejected(reason: String)                      // app → phone, then close
    case ptyHello(paneID: String, cols: Int, rows: Int)    // helper → app
}
```

After the hello exchange, **no more `DataMessage` frames** flow on that link — it is raw
PTY bytes. (The hello is framed so a partial first read can't be misparsed; everything
after is unframed.)

### 4.2 Helper (`Helper/main.swift`)
Turn the M0 `Tee` no-op into a real tap:
- On startup, if `$SHEPHERD_PTY_SOCK` is set, dial it (unix socket), send
  `PtyHello{paneID = $SHEPHERD_TAB_ID, cols, rows}` (winsize read from the outer tty), and
  keep the fd.
- `Tee.output(buf,count)` writes those bytes to the socket (best-effort, non-blocking; drop
  on stall so a dead/slow app never blocks the local terminal — same `SO_SNDTIMEO`/drop
  discipline as `RemoteServer`).
- A reader on the socket writes any received bytes to the inner PTY **master** (`gMaster`),
  i.e. injected input. This runs off the main `pump` loop (a second thread, or add the socket
  fd to the `poll` set). Adding it to the existing `poll` set is cleanest — one loop, no locks.
- The socket is a *tap*, never load-bearing: if the app is down or the dial fails, the pane
  behaves exactly as M0 (local terminal unaffected).

**Winsize:** `PtyHello` carries the size at helper start. Live host-resize-while-a-phone-is-
attached is **not** propagated to the attached phone in v1 (it re-reads size on re-attach) —
documented limitation, avoids a resize control frame in the raw stream.

### 4.3 Broker + server (`RemoteServer.swift`, or a new `PtyBroker.swift` for the per-pane unit)
- **Nonce store:** on `admit()`, record `sessionNonce → (deviceID, control fd)` in a
  lock-guarded map; drop it in `closeConn`. A data channel's nonce must resolve to a live
  entry. (Today `makeNonce()`'s result is discarded — this is the missing half.)
- **`$SHEPHERD_PTY_SOCK` listener:** a unix-domain `AF_UNIX` listener (path under the app's
  container / `/tmp`, like the existing socket). Accept → read `PtyHello` → create/lookup the
  pane's `PtyBroker`, attach this fd as the helper side.
- **`PtyBroker` (per pane):** owns the helper fd, a 256 KB ring (append-with-eviction), and
  `viewers: [Int32]` (attached phone data-channel fds). Helper bytes → append to ring +
  write to each viewer. Phone bytes (from any viewer) → write to helper. Thread-per-connection
  blocking I/O with per-fd serial write queues (reusing `RemoteServer`'s existing discipline);
  **non-blocking I/O + per-viewer coalescing-by-paneID buffering stays deferred** to the
  multi-viewer hardening the Phase 1 design already flagged.
- **Data-channel accept path:** the TCP acceptor (same listener as control, distinguished by
  the first frame being a `DataHello` vs a `ControlMessage.hello`) validates the nonce +
  that the pane has a live `PtyBroker`, replies `DataReady{cols,rows}` (from the broker's
  `PtyHello`), registers the fd as a viewer, and **replays the ring** before live bytes.
- **Teardown:** pane close → helper exits → helper fd EOF → broker evicts, closes all viewers.
  Control session close → invalidate its nonce; existing viewers on that nonce are closed
  (a data channel never outlives its control session).

### 4.4 Wiring (`GhosttyTerminal.swift` / `AgentStore.swift`)
Inject `$SHEPHERD_PTY_SOCK` into the pane PTY env next to the existing vars (only meaningful
when serving; harmless otherwise). `AgentStore` owns the broker registry keyed by paneID and
starts the PTY-socket listener alongside the control server when `shepherd.remote.serving` is on.

## 5. Android design (`android/`)

### 5.1 Resize model (supersedes "viewer-not-resizer" for the client slice)

**The constraint:** a pane is one PTY with one winsize; Claude renders to that size and
**every viewer sees the same grid** — there is no per-viewer size. A full-screen TUI frame
(alt-screen: absolute-positioned cells, no line concept) **cannot be reflowed client-side**,
so the phone can only font-scale + pan a desktop-shaped grid — bad for *responding* to a wide
TUI, which is Phase 2's whole point. (Claude's conversation transcript is main-screen scrollback
and reads OK narrow; the alt-screen overlays — menus / plan / `AskUserQuestion` — are the hard case.)

**The model (refined 2026-07-03): the desktop owns every pane, always. The phone owns
exactly ONE pane — the single pane its app currently has actively open — and nothing
else.** Ownership is no longer tied to desktop focus/visibility/lid at all (that coupling was
the churn that shrank on-screen panes when you clicked a sibling on the Mac). The signal is the
phone's own action: opening a pane's terminal opens a data channel, which makes that pane the
sole phone-owned pane; leaving it (closing the channel) releases it back to desktop.
- Phone opens (taps into) pane X → X becomes phone-owned and takes the phone's size (~40 cols);
  the host resizes that one PTY, Claude repaints native+readable. Every other pane stays
  desktop-sized regardless of what you do on the Mac.
- **Tie-break — desktop wins:** if the desktop is *showing X right now* (visible tab, lid open)
  at the moment the phone opens it, the desktop keeps it desktop-sized and the phone's size is NOT
  applied. This is a point-in-time check at the phone's request (`desktopOwnsSize`, via `Tab.isShowing`
  + presence), NOT a continuous arbiter — desktop focus/tab/zoom changes never trigger a resize on
  their own (that was the rejected churn).
- The phone opens a different pane Y while still holding X → X snaps back to desktop first, then
  Y takes the phone size. Enforced host-side in `RemoteServer` via `activePhonePaneID`
  (`makeActivePhonePane`/`resignActivePhonePane`) so at most one pane is ever phone-owned.
- Phone leaves the pane (data channel detaches) → the host snaps it back to the desktop grid.
- Desktop focus / tab switch / zoom / lid open-close **never** resize a PTY — a desktop pane's
  size is driven purely by its own surface layout (outer→inner `SIGWINCH`); the only exception is
  the one pane the phone has open (and the desktop isn't showing). A live phone rotation/keyboard
  resize (`ControlMessage.resize`) applies **only** to that active, desktop-not-showing pane.

**Protocol delta from §4:** make size dynamic + bidirectional. Add `Resize{cols,rows}` (phone→app)
on the data channel; the host arbiter applies it to the PTY **only when it holds the size** per the
rule above (else ignores it, matching today's helper behavior). `DataReady{cols,rows}` stays as the
initial size. A repaint on ownership flip is a clean re-render (Claude redraws from state — no data
loss). This is the ONLY change to the host contract, and it also serves the future Shepherd-as-client
(Mac↔Mac) case, where two real terminals share one session under the same arbiter.

- **`transport/`** — add a `DataChannel` (peer to the existing `RemoteConnection` control
  client): opens a second TCP socket to `host:port`, sends `DataHello{sessionNonce, paneID}`
  (nonce obtained from the live control session's `accepted`), awaits `DataReady{cols,rows}`,
  then exposes an output byte `Flow`/callback + an `input(bytes)` sink. Backoff/reconnect like
  the control client.
- **`protocol/`** — add the Kotlin `DataMessage` codec, byte-pinned to the Swift shapes (same
  approach Phase 1 used: `[u32 BE len][json]`, nil fields omitted). Add a golden-vector test.
- **`terminal/` (new)** — wrap Termux `terminal-emulator` + `terminal-view`. A
  `RemoteTerminalSession` drives a `TerminalEmulator` sized to `DataReady` cols×rows; feeds
  `DataChannel` output bytes via `emulator.append(bytes, len)`; routes `TerminalView` key/text
  input to `DataChannel.input(...)`. Sends `Resize{cols,rows}` per the §5.1 active-driver model
  (applied host-side only when the phone holds the size); pan/zoom is the fallback when the desktop
  owns the size.
- **`ui/`** — an **Agent screen**: the `TerminalView` (host-sized) + an **extra-keys row**
  (Esc / Ctrl / Tab / arrows / Enter) + a text field. Reached by tapping an agent in the Fleet
  screen or a notification deep-link. Smart Approve/Deny buttons deferred.
- **Termux dependency:** vendor `terminal-emulator` + `terminal-view` (Apache-2.0) as Gradle
  modules or a maven dep; confirm license notice in the app.

## 6. Security

Reaffirms §6 of the parent design, plus the data-channel specifics:
- **Tailscale-only reach** (host binds the `100.x` interface, refuses if Tailscale down) —
  WireGuard E2E, so terminal contents never transit a third party or Tailscale itself. (This
  is the concern raised while scoping Phase 2: the stream is safe on the wire; only the two
  endpoints hold plaintext.)
- **Nonce capability gate:** a data channel must present a `sessionNonce` bound to a live,
  approved control session; nonces die with their control session. A paired-but-not-approved
  or a non-paired tailnet device cannot open a data channel. Defense-in-depth over Tailscale.
- **No new content in FCM:** unchanged — pushes stay data-only wake signals; content is pulled
  over the tailnet post-wake.
- **Revocation:** revoking a device (Phase 1) drops its secret/token and closes its control
  session → its nonce dies → its data channels close.

## 7. Testing (honors *don't-kill-live-Shepherd* — compile + unit/loopback only)

- **Pure (`ShepherdModelTests`):** `DataMessage` frame codec round-trip; `PtyBroker` ring
  append/evict/replay logic (extract the ring as a pure type); nonce store add/lookup/invalidate.
- **Host loopback E2E (`ShepherdRemoteTests`):** over `127.0.0.1` + an `AF_UNIX` pair —
  pair → approve → get nonce; open a fake "helper" on the PTY socket sending bytes → open a
  data channel with the nonce → assert `DataReady` + ring replay + live fan-out; assert a
  **bad/expired nonce** and an **unknown pane** are rejected; assert phone input reaches the
  fake helper; assert control-close invalidates the nonce.
- **Helper (`HelperTests`/`ShepherddPtyTests`):** the tap dials + forwards + injects; with no
  `$SHEPHERD_PTY_SOCK` or a dead socket, the local pump is byte-identical to M0.
- **Android:** `DataMessage` golden-vector parity; feed a byte fixture into the emulator →
  assert screen model; send input → assert wire bytes; instrumented render of the Agent screen.
- **Manual/device (deferred user checklist):** host on the Mac + phone on the tailnet — attach
  to a blocked agent, see the screen, answer an `AskUserQuestion`, submit a new prompt.

## 8. Known limitations (v1)

- Only panes **created while serving is on** get the helper, so only those are remotely
  viewable. Fine for the dark-shipped v1 (serving toggled at launch + reconciled).
- Live **host-side resize** while a phone is attached is not propagated until re-attach.
- Thread-per-connection blocking I/O; multi-viewer non-blocking + coalescing hardening deferred.

## 9. Deferred (post-Phase-2)

- Smart Approve/Deny/answer buttons driven by the hook `reason`.
- Remote structural control (spawn/split/close panes from the phone).
- Live resize propagation; non-blocking I/O + per-viewer coalescing.
- Shepherd-as-client (Mac↔Mac) and iOS client — reuse this host server + protocol.

---

## Status / progress (update each session)

- **2026-07-02 (design):** this doc. Branch `android-phase2-data-channels` (off `master` `6c1f304`).
  Data path = Option A (helper dials app; app buffers/brokers), approved. Next: writing-plans.
- **2026-07-02 (host half IMPLEMENTED, dark-shipped):** the whole host sub-project (§4) is built
  + reviewed via subagent-driven-development (all opus). Plan
  `docs/superpowers/plans/2026-07-02-android-phase2-host-data-channels.md`; SDD ledger
  `.superpowers/sdd/phase2-progress.md`. Shipped (Swift, `spike/seam1/`): `DataMessage`/`DataFrameCodec`/
  `DataFrameDecoder` in `RemoteProtocol.swift`; `PtyRing`/`PtyBroker`/`PtyHub` in `PtyBroker.swift`;
  `sessionNonce` store + first-frame-sniff data-channel accept path (`serveDataChannel`, nonce-gated,
  ring replay + viewer fan-out + input) in `RemoteServer.swift`; the `shepherdd pty` **tap** (dials
  `$SHEPHERD_PTY_SOCK`, streams output, injects input, non-load-bearing) in `Helper/main.swift`;
  `AgentStore` wiring (`ptySocketPath`, `PtyHub` start/stop, `lookupBroker`) + `$SHEPHERD_PTY_SOCK`
  env in `GhosttyTerminal.swift`. Tests: ModelTests 85/85, RemoteTests 11/11 (loopback E2E: pair →
  nonce → helper attach → data channel → replay + fan-out + input; bad-nonce reject; nonce lifecycle),
  HelperTests 10/10 (incl. tap-death survival); app builds. **Two implementation-surfaced findings
  fixed:** (1) the plan's `DataFrameDecoder.leftover` sniff was flaky on coalesced hello+raw reads →
  replaced with a read-exactly-one-frame sniff; (2) the tap busy-spun on mid-session socket EOF →
  retire the poll slot + `O_NONBLOCK` tap. **Dark-shipped:** `lookupBroker` is live only when serving
  is on + a helper exists (panes created while serving). **Remaining:** whole-branch review, then the
  **Android terminal plan (sub-project B, §5)** — the Kotlin `DataChannel` + Termux terminal view/input.
  Deferred/benign (final-review triage): PtyBroker per-viewer close-guard (vs broker-level), PtyHub
  broker reconnect-reuse, `listenFD` start/stop lock, hand-built `ptyHello` JSON escaping.
- **2026-07-02 (sub-project B kickoff — the two open §5 questions resolved):** branch
  `android-phase2-client-terminal` (off `master`). Scope = **full sub-project B** (all of §5) in
  one slice, verified on a real adb-connected phone at the end. **Termux dependency = official
  JitPack artifact**, not source-vendor: `com.termux:terminal-view:<v0.118.x>` via
  `maven { url "https://jitpack.io" }` (Termux publishes these for termux-app ≥ 0.116;
  `terminal-emulator` resolves transitively), Apache-2.0 NOTICE added. **Fallback:** if Gradle
  resolution proves flaky, vendor the two library modules' source — so the plan's step 1 verifies
  resolution before anything is built on it. Android component breakdown (mirrors Phase 1's
  `protocol/`/`transport/`/`ui/` layout): (1) `protocol/DataMessage.kt` codec byte-pinned to the
  Swift `DataMessage` + `Resize`, golden-vector test; (2) `transport/DataChannel.kt` — second TCP
  socket, `DataHello`→`DataReady`, output `Flow<ByteArray>` + `input()` + `resize()`, backoff like
  the control client; (3) `terminal/RemoteTerminalSession.kt` — drives a Termux `TerminalEmulator`
  (sized to `DataReady`) + `TerminalView`, feeds output via `append`, routes key/text to
  `DataChannel.input`, sends `Resize` per §5.1 (phone always sends its size; host arbitrates);
  (4) `ui/AgentScreen.kt` + `AgentViewModel.kt` — `TerminalView` via `AndroidView` + extra-keys row
  (Esc/Ctrl/Tab/arrows/Enter) + text field, reached from a Fleet tap or notification deep-link.
- **2026-07-02 (resize mechanism decided — refines §5.1's "resize on the data channel"):** tracing
  the shipped host path showed both output hot-paths (helper→app→phone) and the 256 KB replay ring
  are pure raw, and only the helper owns Claude's inner PTY (`gMaster` via `forkpty`; a SIGWINCH
  handler already mirrors the *outer* desktop size onto the inner PTY). To carry phone-driven resize
  with the least surgery on reviewed host code:
  - **Initial size folds into the attach handshake.** `DataHello` gains `cols, rows`
    (`dataHello(sessionNonce, paneID, cols, rows)` — additive) so the phone declares its size *as it
    attaches*; the app arbitrates, applies it to the helper, and echoes the applied size in
    `DataReady{cols,rows}` before ring-replay + streaming. "Phone opens the chat → machine resizes →
    streaming begins," in one round-trip.
  - **Live resize while attached rides the CONTROL channel, not the data channel.** New additive
    `ControlMessage.resize(paneID, cols, rows)` (phone → app) for size changes *after* attach (phone
    rotation, soft-keyboard show/hide). The phone already holds a live, authenticated control
    connection, so the raw data-channel output path and the ring stay **untouched** (no per-chunk
    framing on the hot path). This supersedes §5.1's "Add `Resize` on the data channel" — same model,
    cleaner placement.
  - **Host is the arbiter** (as §5.1 requires), and **snap-back is mandatory**: the phone owns the size
    for exactly the one pane it currently has open (`RemoteServer.activePhonePaneID`; see the 2026-07-03
    refinement in §5.1). On phone **detach** (or the phone opening a different pane), the host pushes the
    desktop size back to the helper — otherwise Claude is left rendering ~40-col content in the full
    desktop pane. Desktop's own resize keeps flowing through the helper's existing outer→inner SIGWINCH
    path; desktop focus/tab/zoom/lid never change a PTY size — only the phone's one open pane does.
  - **One shipped-code protocol change (unavoidable):** the **app→helper** link (today raw injected
    input) gains minimal typed framing — `[u32 len][1-byte type][payload]`, type `0x00` = input bytes
    (write to `gMaster`), type `0x01` = resize (`cols,rows`) → `sh_set_winsize(gMaster)`. Low-volume
    direction only; **helper→app output stays raw and the ring is unchanged.** Updates the shipped
    loopback/helper tests that assert raw app→helper input.
  - **Android stays simple:** `DataChannel` is pure raw duplex after `DataReady`; it declares the
    initial size in `DataHello`, and live size changes go over the existing `RemoteConnection` as
    `ControlMessage.Resize`. `RemoteTerminalSession` computes `cols×rows` from the `TerminalView`
    size and emits it (debounced).
  Next: writing-plans.
- **2026-07-02 (UX refinement — desktop-owned pane shows a placeholder, not a panned grid):**
  > **SUPERSEDED 2026-07-03 by the §5.1 single-active-pane model.** The phone now always owns any pane
  > it opens (never gets a "desktop owns this" verdict for a pane it actively opened), so this placeholder
  > case can't arise and was never wired host-side (`DataReady` has no ownership flag). Kept for history.

  decided during implementation. When the **desktop owns the size** (desktop pane focused/visible),
  the phone must NOT render a desktop-sized grid with pan/zoom (fiddly UI, poor UX). Instead the phone
  shows a static **"Pane open on desktop"** placeholder and does not render the terminal. This
  **replaces §5.1's pan/zoom fallback** (which is deleted — no pan/zoom is built). Mechanism, riding
  the arbiter that already computes ownership:
  - `DataReady` gains an **ownership flag** (`ownedByDesktop: Bool` / `phoneOwns`); the app **pushes a
    small ownership-changed update** to the attached phone when the arbiter flips (a new tiny data- or
    control-channel message).
  - The app **remembers each attached viewer's last-requested size**; when ownership flips **to** the
    phone (desktop unfocuses/detaches elsewhere), it applies that remembered size to the helper and
    signals the phone, which swaps the placeholder for the **live, phone-width, reflowed** terminal —
    hands-free. This also closes the earlier gap (leaving the desk did not auto-reflow the phone).
  - Common case is unaffected: a push arrives when you're away (lid shut → desktop unfocused → phone
    owns) → phone shows the live reflowed terminal immediately.
  - **Scope:** additive to H5's arbiter (emit + remember size) + a small Android placeholder state on
    the Agent screen; A4 drops the pan/zoom path. Implemented as a focused follow-up AFTER the baseline
    lanes land, before the unified whole-branch review.
