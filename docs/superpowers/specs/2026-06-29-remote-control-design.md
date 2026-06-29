# Remote control — design

**Date:** 2026-06-29
**Status:** Approved design; ready for implementation planning.
**Topic:** Drive a Shepherd workspace running on one machine ("host") from another
Shepherd instance ("client") over Tailscale, as if you were sitting at it locally —
full terminal fidelity, live agent-state, notifications.

This is the "big-ticket future: full remote control" from [`SPEC.md`](../../../SPEC.md) §6,
now scoped into a buildable v1.

---

## 1. Motivation

Shepherd treats Claude Code sessions as first-class tracked agents. The natural
next want: leave a machine running agents at your desk, then **reach those exact
workspaces from a laptop elsewhere** and drive them — type, scroll, copy, watch
state, get notifications — with the commands still executing on the host. Not a
fresh session on the laptop; the *same* live workspace, projected.

## 2. Requirements (decided)

- **Single active viewer, but resilient.** No real-time co-presence requirement
  (we will not stream a concurrently-mirrored grid). But: **instant screen replay
  on attach** (you see what's already there) and **flawless reconnect**.
- **Drive existing terminals only (v1).** Type / scroll / copy-paste / see live
  agent-state in the sidebar / receive notifications, into the panes & tabs that
  already exist on the host. **No** remote structural mutation (create/close tabs,
  split/zoom/reorder panes) in v1 — that is a clean follow-on.
- **Full tty fidelity.** A remote pane must behave byte-identically to a local one
  (real vim, real REPLs, colors, alt-screen). This is the deliberate choice that
  separates Shepherd's remote from agent-companion products (see §4) — we stream
  the raw PTY, we do not project a structured agent view.
- **Auth: pairing token + one-time approve.** Tailscale already provides
  WireGuard encryption + per-device identity; on top, first attach needs the
  host's short-lived pairing code **and** an interactive "allow this device?"
  approval on the host. Approved devices are remembered.
- **Transport: Tailscale** (v1), but the protocol is **transport-agnostic** behind
  an endpoint abstraction (see §6) so LAN / SSH-forward can be added later without
  protocol change.
- **No background daemon (v1).** The host's Shepherd app must be running to serve;
  PTYs live inside the host app's surfaces. Attaching mirrors the host's *existing
  live* workspace, never spawns fresh sessions.

## 3. Architecture decision

**Chosen: Approach 1 — helper-owned PTY + byte relay ("shepherd-mux").**

The decisive constraint, found by inspecting the vendored libghostty header
(`vendor/GhosttyKit.xcframework/.../ghostty.h`): the public API exposes
`ghostty_surface_text` (inject input) and `ghostty_surface_read_text` /
`read_selection` (extract **plain** grid text) — but **no live PTY byte-stream tap
and no full-fidelity grid serialization**. We therefore cannot tee the colored
output stream out of an already-running libghostty surface without patching
libghostty.

So we insert our **own** thin PTY layer using the surface-config `command` field
that already exists (`ghostty.h:447`). libghostty renders a process; we make that
process our helper, which owns the real PTY and can tee it.

### Rejected alternatives

- **Approach 2 — patch libghostty** to tap the live PTY + serialize the grid.
  Cleanest end-state (zero idle overhead, share any already-running workspace
  on demand, high-fidelity replay), but **forks libghostty** — a patch that must
  survive every version bump the build script pulls, reversing the project's
  "no libghostty internals" discipline. Kept in pocket as the **v2** if per-pane
  overhead or the "share-already-running-workspace" limitation bites.
- **Approach 3 — server-authoritative grid mirror** (mosh/tmux-internal style):
  host runs the authoritative emulator, streams cell-diffs, client renders them.
  Best resilience + the only path to true co-presence + predictive echo, but a
  from-scratch SSP-like protocol and renderer — massive overkill for the
  single-viewer requirement. The someday-co-presence bet.

## 4. Prior art: t3code (`pingdotgg/t3code`)

t3code ships remote functionality but takes the opposite path, and the contrast
sharpened this design:

- t3code is **already client/server** — desktop/mobile/web are thin clients of a
  "T3 server" (`ExecutionEnvironment`) reached over an **HTTP/WebSocket contract**.
  Remoteness is "reach that same server from elsewhere" via an `AccessEndpoint`
  (direct `wss`, tunneled `wss`, desktop-managed SSH forward), with a **cloud
  relay + JWTs** for rendezvous.
- What crosses the wire is **structured agent-awareness / orchestration events**
  (`AgentAwarenessRelay`: `thread.message-sent`, agent-activity state). The
  `PtyAdapter`s are **server-local**; **the remote link carries no raw PTY**.
  "Replacing the WebSocket boundary with a custom transport" is an explicit
  non-goal for them. Their remote primitive is the *agent*, not the *terminal*.

**Why we diverge:** t3code can be cheap because the server boundary already
exists. Shepherd is a monolithic native app — libghostty owns the PTY in-process;
there is no server to reach. And our requirement is full tty fidelity, which
t3code deliberately doesn't provide. So we choose the heavier raw-PTY path on
purpose.

**What we adopt from t3code:**
1. **Endpoint abstraction** (§6) — Tailscale is just the v1 endpoint type behind a
   `KnownHost`/`AccessEndpoint` model; not baked into the protocol.
2. **Validation of the control channel** — projecting agent state as structured
   events to remote clients is exactly their `AgentAwarenessRelay` pattern; ours
   forwards `AgentStore` transitions over Tailscale instead of a hosted relay.
   Because Tailscale already gives NAT-traversal + identity + encryption, we
   correctly **skip the cloud-relay + JWT-issuer infra** they need for a
   multi-user hosted product.
3. **Phasing** — the control/awareness channel is independently valuable and far
   cheaper than the pty hot path, so it ships first (§10, M1).

## 5. Components

Shepherd stays a single peer app; remoting adds two **roles** an instance can play
at once (your desktop can serve while also being a client of some other box).

### `shepherdd` — bundled helper binary

Ships inside `Shepherd.app/Contents/MacOS/`. Two subcommands, each used as a
libghostty surface `command`:

- **`shepherdd pty -- <program…>`** (host side). Allocates the real PTY,
  fork-execs the actual program (login shell / `claude`) into it, copies bytes
  bidirectionally between that inner PTY and its own stdio (which libghostty
  drives). When the in-app server signals "a client attached," it **also** tees
  output to a replay ring-buffer + the network and accepts injected input. It is
  the PTY's true owner and the **winsize arbiter**.
- **`shepherdd attach <host> <pane-id>`** (client side). Opens one connection for
  one pane, presents the capability/token, then is a **dumb bidirectional pipe**
  between that socket and its stdio (which the client's libghostty drives). No mux
  logic in the subprocess → lowest latency, independent per-pane reconnect.

(The two subcommands may share one binary.)

### In-app pieces (new Swift files; pure-model / AppKit-shell split)

- **`RemoteServer.swift`** (host role): listens on the resolved endpoint, runs
  pairing/approval, holds the **control channel** per attached client, brokers
  per-pane **data connections** to the right `shepherdd pty` helper, and
  subscribes to `AgentStore` transitions to forward them.
- **`RemoteClient.swift`** (client role): connects to a `KnownHost`, performs the
  handshake, receives the workspace tree → builds a **mirror workspace** in
  `AgentStore` (flagged `remote`), spawns each mirror pane's surface with
  `command = shepherdd attach …`, and feeds forwarded state events into
  `AgentStore.apply` exactly like the local socket does.
- **`RemoteProtocol.swift`** (**pure model**, no AppKit → `ShepherdModelTests`):
  the framed wire protocol (message enums, encode/decode, structure/state DTOs),
  the pairing handshake state machine, capability-nonce gating, the **winsize
  arbitration decision function**, and the reconnect-backoff schedule.

**Reuse insight:** a mirror pane is just a `Pane` in a normal `Workspace` with a
`remote` marker and its surface pointed at `shepherdd attach`. Everything
downstream — sidebar dots, `Tab.attentionState()`, dock badge, `⌘⇧A`,
notifications, cross-workspace aggregation — works **unchanged**, because it's all
keyed on per-pane `AgentState` in the store, which already aggregates across all
workspaces ([ADR 0013](../../../.claude/adr/0013-workspaces.md)).

## 6. Endpoint abstraction (from t3code)

- **`KnownHost`** — a client-side saved entry for a host the client can reach
  (device id once known + display name). Local to the device; persisted.
- **`AccessEndpoint`** — one concrete way to reach a `KnownHost`. v1 ships exactly
  one endpoint *type*: **Tailscale** (`host:port` on the tailnet, MagicDNS name or
  100.x). Loopback TCP is also a valid endpoint type — used by the test suite so
  E2E needs no tailnet. LAN / SSH-forward are future endpoint types requiring no
  protocol change.

The protocol speaks bytes over a framed stream; it does not know or care that the
stream is a Tailscale TCP connection.

## 7. Wire protocol & data flow

**Connections.** Per attached client: **one control connection** + **one data
connection per pane**. Each is a framed TCP stream over the endpoint. Framing:
`[u8 type][u32 len][payload]`.

**Handshake & pairing** (every connection):
1. Client → `Hello{deviceID, deviceName, token?, sessionNonce?}`.
2. Host: if `deviceID` already paired → accept (data conns must also present a
   valid `sessionNonce` issued by a live, approved control session — so a raw pane
   stream can't be opened without an approved control session). Else if `token`
   matches the host's current short-lived **pairing code** → fire an in-app
   **approve prompt** ("<device> wants to attach — Allow / Deny"); on approval,
   persist the device id + a per-device secret and accept. Otherwise `Reject`.
3. The pairing code is only for first pairing; thereafter the persisted per-device
   secret is used. Token/secret travels via **injected env, not argv** (no `ps`
   leak).

**Control channel messages:**

| Direction | Message | Purpose |
|---|---|---|
| Host→Client | `Snapshot{tabs → panes, names, cwd, per-pane state, sessionNonce}` | sent right after attach → client builds the mirror workspace |
| Host→Client | `PaneAdded` / `PaneRemoved` / `PaneRenamed` / `TabChanged` | structural drift: host user splits/closes locally, mirror follows (we *observe* host-side changes even though v1 client can't *initiate* them) |
| Host→Client | `State{paneID, event, detail}` | a forwarded `AgentStore` transition → client calls `apply()` |
| Client→Host | `Focus{paneID}` | client focused a mirror pane → host's view agrees (clears need-to-check) |
| Client→Host | `Detach` | clean teardown |
| both | `Ping` / `Pong` | heartbeat / liveness |

**Per-pane data flow (hot path):**
- On connect, host sends the helper's **replay ring-buffer** (recent output,
  ~256 KB — enough to repaint + some scrollback), prefixed by a terminal **reset**
  to avoid corrupt partial-escape state, then switches to **live tee**. Client's
  libghostty processes replay-then-live → screen appears instantly.
- Steady state: host PTY output → tee → data conn → `shepherdd attach` stdout →
  libghostty renders. Keystrokes/mouse/paste → libghostty → `shepherdd attach`
  stdin → data conn → host helper → inner PTY. **Raw bytes, no translation.**
- **Resize:** the client surface's cols×rows ride an out-of-band frame on the data
  connection; the helper applies `TIOCSWINSZ` to the inner PTY. The helper
  arbitrates: **attached active client's size wins while attached; the host's own
  surface size re-asserts on host focus after detach** (coherent with
  single-viewer). This arbitration is a pure decision function in
  `RemoteProtocol.swift`.

**Reconnect / resilience:** the host PTY lives in the host app and keeps running
regardless of the link, so the helper just keeps buffering. The client does
**exponential-backoff reconnect** on the control conn and each pane conn; on
reconnect it re-`Snapshot`s structure and **replays each pane's ring-buffer**. The
mirror workspace shows a `reconnecting…` state meanwhile; heartbeat detects dead
links.

**State forwarding (the elegant bit):** on the host, `AgentStore.apply` already
computes a transition per pane (via `StopPolicy`). For any pane in a served
workspace, also emit `State{…}` on the control channel. The client receives it and
calls **its** `AgentStore.apply` on the mirror pane — same lifecycle map, same
dots, same notifications. The `didFocus` clear (need-to-check → idle) happens
locally on the client when you focus the mirror pane, and a `Focus` hint is
forwarded so the host's view agrees.

## 8. Integration into the existing app (file by file)

- **`SplitTree.swift` (`Pane`)** — add optional `remote: RemoteRef?` (host
  deviceID + remote-paneID + `connState`: live / reconnecting / dead). `nil` =
  ordinary local pane. `displayTitle`/`state` unchanged; `remote` only changes
  *where the surface's bytes come from* and adds a small connection-status glyph.
- **`GhosttyTerminal.swift` (`makeSurface`)** — if `pane.remote != nil`, set
  `cfg.command = ".../shepherdd attach <host> <remotePaneID>"` (token via injected
  env, not argv). On a **served host**, local panes get
  `cfg.command = ".../shepherdd pty -- <login-shell>"`, **gated by the
  machine-level serve toggle**. Existing `SHEPHERD_SOCK`/`SHEPHERD_TAB_ID` env
  injection still happens; on the host the helper passes it through so hooks fire
  normally.
- **`AgentStore.swift`** — owns a `RemoteServer?` (when serving) and a
  `[RemoteClient]` (one per attached host). `apply(event,detail,paneID)` gains a
  tail: if the resolved pane lives in a served workspace,
  `server?.forward(transition, paneID)`. `RemoteClient` calls the **same** `apply`
  for inbound `State{…}` on mirror panes — no new state machine. Mirror workspaces
  are real `Workspace`s in `workspaces`, so `locatePane`, attention aggregation,
  dock badge, `⌘⇧A`, notifications need **zero changes**.
- **`SocketServer.swift`** — unchanged. Hooks still report to the local unix
  socket; remoting forwards *after* `apply`. The socket never goes over the wire.
- **UI** — `WorkspaceSwitcher.swift` gains "Add remote host…" (enter Tailscale
  name → pair). A remote workspace renders like any other with a host-name +
  link-status affordance in the header; per-pane `reconnecting…`/`dead` overlays
  in `SplitContainer.swift`. A host-side **approve sheet** lives in
  `AppDelegate` / a small SwiftUI sheet. A **Settings toggle "Serve over
  Tailscale"** (machine-level switch) + current pairing code + paired-device
  list/revoke.
- **`Persistence.swift` (`shepherd.workspaces` → v2)** — a mirror workspace
  persists only as a **pointer** (host deviceID + name), never its tabs/panes
  (those are the host's truth). On relaunch it restores as a collapsed
  "reconnect to <host>" stub that re-attaches and re-`Snapshot`s. Additive bump to
  `shepherd.workspaces.v2` with a v1→v2 migration that tags everything `local`.
- **Menu/keys** — no new global keys in v1. `⌘W` on a mirror pane **detaches** the
  view (closes the local surface); it never kills the host's PTY. Closing a remote
  workspace = disconnect, not destroy.
- **New ADR** — `0015-remote-control.md`: helper-owned-PTY over libghostty-fork
  (and why — the API finding), per-pane data conns + one control conn,
  single-viewer winsize arbitration, pairing + approve, endpoint abstraction, and
  the bounded-replay alt-screen limitation.

## 9. Security & error handling

**Security:**
- **Bind to Tailscale only.** Listener binds the host's Tailscale interface
  address, never `0.0.0.0`. If Tailscale is down, serving refuses to start with a
  clear message — never a public-bind fallback.
- **Two-layer auth.** Tailscale (WireGuard encryption + device identity) +
  app-level pairing code + interactive approve on first attach; persisted
  per-device secret thereafter. Token/secret via injected env, not argv.
- **Data conns are capability-gated.** Control handshake issues a per-session
  nonce; pane data connections must present it — no raw pane stream without an
  approved, live control session. Every connection re-checks the device is still
  approved.
- **Least exposure.** Only *served* workspaces are enumerable; unshared workspaces
  are never named or reachable. (`GHOSTTY_ACTION_READONLY` exists for a future
  observe-only share; not v1.)
- **Teardown.** Host quit closes the server; helpers exit; PTYs die as today.
  Client quit detaches cleanly. Revoking a device drops its live conns immediately.

**Error handling & edge cases:**
- **Host unreachable / Tailscale down / host app not running** → mirror pane
  `dead`, control conn backoff-retries; explicit "host not running (no daemon in
  v1)" messaging.
- **Host user closes a pane/tab locally** → `PaneRemoved`/`TabChanged` → mirror
  follows; focus falls back if the focused mirror pane vanished.
- **Shell/agent exits on host** → helper relays child-exit → data EOF → mirror
  pane → `shell` (agent gone), same as a local `SessionEnd`.
- **Replay fidelity** → replay starts with a terminal reset; full-screen apps
  (vim/less) across a *cold* reconnect may need one redraw — the known bounded-ring
  limitation we accept (Approach 2 is the fix if it bites).
- **Second device attaches the same host** → single active viewer: **last attach
  takes over**, prior viewer drops to "attached elsewhere" and can re-claim.
- **Resize contention** → helper arbitrates (active client wins; host re-asserts on
  focus after detach).
- **No predictive echo** → raw byte pipe, latency ≈ ssh; fine on Tailscale.
  Predictive echo is Approach 3 territory.

## 10. Testing

- **`RemoteProtocol.swift` → `ShepherdModelTests`** (pure): frame encode/decode
  round-trip, message-DTO codec, `Snapshot`/diff application to a mirror tree,
  pairing handshake state machine, capability-nonce gating, winsize arbitration
  decision function, reconnect-backoff schedule.
- **`shepherdd` helper — standalone integration test** (no app): `shepherdd pty --
  bash`, assert tee output == inner PTY, injected input reaches the shell,
  ring-buffer replays, `TIOCSWINSZ` lands (`stty size`).
- **Loopback E2E**: host server + client over `127.0.0.1` (loopback endpoint, **no
  Tailscale needed**): pair → attach → type → echo → drop → reconnect → replay.
- **State-forwarding parity**: replay a scripted hook-event sequence into the host
  `AgentStore`, assert the mirror `AgentStore` reaches identical per-pane states —
  reusing existing `StopPolicy` fixtures.
- **Manual/real**: two Macs on the tailnet; UI via the window-id `screencapture`
  recipe in `CLAUDE.md`.

## 11. Phasing — milestones (each ships & tests independently)

- **M0 — Helper passthrough.** `RemoteProtocol.swift` (pure + tested) + the
  `shepherdd pty` helper wired as the surface `command` behind the serve toggle,
  **no network**. Prove local panes behave byte-identically through the inserted
  PTY layer. De-risks the one invasive local-behavior change before any remoting.
- **M1 — Control channel (awareness slice).** `RemoteServer` on a loopback
  endpoint, pairing + approve, `Snapshot` + `State` forwarding; client builds a
  mirror workspace showing **state + names** (surfaces still placeholders).
  Deliverable on its own: see the host's agent state + notifications on another
  instance. De-risks auth + structure-sync + state-projection.
- **M2 — PTY data channels (hot path).** Per-pane data conns, replay ring-buffer,
  live tee + input + resize; mirror panes become real `shepherdd attach`
  libghostty surfaces. A real remote terminal over loopback.
- **M3 — Tailscale endpoint + resilience.** Bind to Tailscale interface, the
  `KnownHost`/`AccessEndpoint` model, exponential-backoff reconnect,
  `reconnecting`/`dead`/`attached-elsewhere` UI, takeover + teardown. First real
  two-Mac usage.
- **M4 — Polish.** ADR 0015, `shepherd.workspaces.v2` migration, Settings UI
  (serve toggle + pairing code + paired-device list/revoke).

## 12. Deferred / future

- **Approach 2** (patch libghostty: tap live PTY + serialize grid) — the v2 if
  per-pane overhead or the "share an already-running workspace" limitation bites;
  removes the helper, gives zero idle overhead + high-fidelity replay.
- **Remote structural control** — create/close tabs, split/zoom/reorder panes from
  the client (every `AgentStore` mutation gains a remote-authority + echo path).
- **Approach 3 / co-presence** — server-authoritative grid mirror enabling true
  simultaneous local+remote viewing + predictive echo.
- **Additional endpoint types** — LAN, SSH-forward (the abstraction already
  allows them).
- **Observe-only share** — `GHOSTTY_ACTION_READONLY`-backed read-only attach.
