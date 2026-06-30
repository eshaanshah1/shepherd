# Android remote-control client — design

**Date:** 2026-06-30
**Status:** Design (brainstorming). Spans multiple sessions and two codebases. Not yet implemented.
**Prereq context:** Builds on [`2026-06-29-remote-control-design.md`](2026-06-29-remote-control-design.md) (the Shepherd↔Shepherd remote-control design) and **M0 (shipped on `master`)** — the `shepherdd pty` PTY-wrapping helper + serve toggle.

> **Resuming across sessions:** read this whole file first, then check the
> "Status / progress" section at the bottom for where we are. The macOS host
> work lives in this repo (`spike/seam1`); the Android app is a **new, separate
> Kotlin/Gradle codebase** (location TBD — see Open questions).

---

## 1. Goal

Drive a Shepherd **host** (the macOS app, already built) from an **Android phone**
over Tailscale: see all your agents and their live state, get **pushed when one
needs you** (even with the app closed), and tap in to **respond to any blocker or
send new prompts**. The phone is a *client* of the host; commands run on the host.

This **replaces "make a second Shepherd a client" as the first remote client** —
the phone is a better first client because (a) it forces a clean client-agnostic
host protocol, and (b) mobile agent-monitoring + push is the killer use case a
phone does *better* than a desktop. The Shepherd-as-client path is deferred; it
reuses the same host server unchanged.

## 2. Decisions (from brainstorming — the "why", so future sessions don't relitigate)

- **App shape: agent-monitor + respond** (not a full always-on terminal). The UI
  is organized around your agents (a fleet list + state dots + notifications);
  tapping an agent opens a terminal view to read + respond. The bar is
  "readable + respondable," not "run vim comfortably on a phone."
- **Respond to *any* blocker + send new prompts** → we need a **faithful terminal
  model**, not just smart buttons. Once the phone can render the agent's screen
  and send keystrokes, it is *driving the same PTY Claude runs on* — so
  `AskUserQuestion`/permission/plan menus render correctly and you drive them with
  real input; typing a line + Enter at Claude's prompt submits a new prompt. No
  special "respond"/"message" API — it's all input bytes.
- **Input scope (v1): type into existing agents only.** Respond to blocks, submit
  prompts, run commands in panes that already exist on the host. **No remote
  structural control** (no spawning new panes/sessions from the phone) in v1 —
  that's the deferred "remote structural control" (v2).
- **Terminal tech: Termux `terminal-emulator`/`terminal-view`** (native Kotlin,
  Apache-2.0, purpose-built to consume a PTY byte stream + produce input) over
  xterm.js-in-WebView (heavier, clumsier bridge). We feed it the data-channel
  bytes instead of a local PTY and send its input back over the wire.
- **Notifications: FCM (Firebase Cloud Messaging), data-only "wake" pushes.** FCM
  is **free** at any volume (paid Firebase tiers are for *other* services). The
  push payload carries only a tiny wake signal (`{paneID, state}` — **no terminal
  content**); the woken app connects over Tailscale to pull context and raise the
  *local* notification. So: alerted even if the app was swiped away, and terminal
  content never transits Google. **Fallback if host-side FCM OAuth plumbing is
  painful: self-hosted/`ntfy` push** (simple HTTP POST; survives app-kill; adds a
  relay to run/trust).
- **Transport: Tailscale, direct TCP.** The phone is on the tailnet via the
  Tailscale Android app; our app opens a normal socket to the host's MagicDNS
  name / `100.x` — **no Tailscale SDK needed**, Tailscale provides connectivity.
  Same framed wire protocol as the Shepherd↔Shepherd design.
- **Phone is a viewer, not a resizer:** it **adopts the host pane's current size**
  (renders the host's e.g. 80×24, pan/zoom to read) rather than resizing the host
  PTY to phone dimensions — so glancing from the phone never reflows/wrecks the
  desktop view if you're also sitting there.
- **No persistent foreground service for notifications.** FCM is the wake
  mechanism, so the app connects over Tailscale **on demand** (user opens it / FCM
  wakes it / viewing an agent) — better battery, no persistent-notification
  requirement.
- **Pairing: token + approve, QR-first.** Host shows a short pairing code as a QR;
  phone scans → sends code + its FCM token + device name → host shows an approve
  sheet → persists the device. Paired devices use a stored per-device secret
  thereafter.

## 3. Decomposition & phasing

Two sub-projects; the host one is shared with the (deferred) Shepherd-as-client.

**Sub-project A — Host remote server** (in the macOS Shepherd app; client-agnostic).
This is the original M1 (control channel) + M2 (data channels) host work.

**Sub-project B — Android app** (new Kotlin/Gradle codebase).

**Phasing — each ships real value:**
- **Phase 1 — Monitor slice:** host control channel + pairing + FCM push; Android
  app pairs, shows the agent fleet with live state dots, and **notifies you when
  one needs you**. *No terminal view.* Cheap, killer-feature-first (phone buzzes
  when a desktop agent blocks), zero terminal-rendering work.
- **Phase 2 — Respond slice:** host per-pane data channels; Android terminal view
  (Termux) + input. Respond to any blocker; send new prompts.

**First spec = Phase 1** (host control channel + pairing + FCM + Android monitor app).

---

## 4. Host server design (sub-project A)

Lives in `spike/seam1` (the macOS app), mirroring Shepherd's pure-model / AppKit-shell split.

- **`RemoteProtocol.swift`** — *pure model*, unit-tested in `ShepherdModelTests`
  (like `StopPolicy`/`SleepPolicy`): the framed wire protocol — message enums +
  DTOs, the pairing handshake state machine, frame encode/decode
  (`[u8 type][u32 len][payload]`). No AppKit.
- **`RemoteServer.swift`** — the AppKit shell: binds a TCP listener on the
  **Tailscale interface only** (the `100.x`/utun address; **refuses to start if
  Tailscale is down** — never a public `0.0.0.0` bind), runs pairing/approve,
  holds a **control channel** per paired device, subscribes to `AgentStore`
  transitions, and (Phase 2) brokers per-pane data connections.
- **`FCMPusher.swift`** — holds a Firebase **service-account** key, mints the
  OAuth2 access token (Google FCM v1 API requires service-account auth, not the
  deprecated legacy server key), and POSTs **data-only** messages to a device's
  FCM token. Needs host internet access (it reaches Google, not the phone
  directly — that's what makes it work when the phone is unreachable/asleep).

### Pairing (Phase 1)
Host generates a short pairing code (shown in Settings, rendered as a **QR**). The
phone connects over Tailscale → `Hello{deviceID, deviceName, pairingCode, fcmToken}`
→ host raises an in-app **approve sheet** ("Pixel 8 wants to pair — Allow/Deny") →
on approval persists `{deviceID, perDeviceSecret, fcmToken, name}`. Paired devices
present the secret thereafter (code is first-pair only). The control channel also
carries `RefreshFCMToken{token}` (FCM rotates tokens).

### Control channel messages (Phase 1)
| Direction | Message | Purpose |
|---|---|---|
| Host→Phone | `Snapshot{ panes: [{paneID, title, workspace, state, reason}] }` | the agent fleet, on attach |
| Host→Phone | `State{paneID, state, reason}` | a forwarded `AgentStore` transition (live dot) |
| Host→Phone | `PaneAdded` / `PaneRemoved` / `PaneRenamed` | fleet drift |
| Phone→Host | `RefreshFCMToken{token}` / `Detach` | token rotation; clean teardown |
| both | `Ping` / `Pong` | heartbeat / liveness |

The fleet spans **all panes across all workspaces** (the value of "monitor" is the
whole fleet) — `AgentStore` already aggregates cross-workspace.

### State forwarding + push
`AgentStore.apply` already computes each pane's transition (via `StopPolicy`). Tap
it: for **every** transition, push `State{}` to any connected control channel; and
when a transition is **attention-worthy** (`blocked` / `needsCheck` / `error`),
also fire an **FCM data-only wake** (`{paneID, state}`, no content) to each paired
device. The woken app connects over Tailscale, pulls context, and raises the local
notification.

### Data channels (Phase 2)
Per-pane data connections stream the helper's tee'd PTY bytes ⇄ input. **M0 payoff:**
the `shepherdd pty` helper already has the **`Tee` seam** (the M0 no-op) — Phase 2
plugs the network into it + routes input back to the inner PTY. Reuses M0's raw-mode
+ teardown work. The phone does NOT resize the host PTY (viewer-not-resizer).

## 5. Android client design (sub-project B)

New Kotlin project, **Jetpack Compose** UI, Gradle. Connectivity assumes the user's
**Tailscale Android app** is installed + connected (phone on the tailnet).

Modules / units (each focused, testable):

- **`transport/`** — `RemoteConnection`: opens a TCP socket to `host:port` over the
  tailnet, runs the pairing handshake, speaks the framed protocol (a Kotlin
  re-implementation of `RemoteProtocol`; the protocol is **defined once in this
  spec and implemented twice** — keep it small + versioned). Maintains the control
  channel; exponential-backoff reconnect. Connects **on demand** (no persistent
  service).
- **`model/`** — the agent fleet (panes + states), updated from `Snapshot` +
  `State`/`Pane*` messages. Pure Kotlin, unit-tested.
- **`fcm/`** — Firebase SDK: obtain the FCM token, send it at pairing, handle
  refresh (→ `RefreshFCMToken`). A `FirebaseMessagingService` receives the
  data-only wake → connects over Tailscale → fetches the pane's current
  state/reason → posts a **local** notification ("Claude in ~/project needs you:
  approve Bash"). Tapping it deep-links to that agent.
- **`ui/`** (Compose) — **Fleet screen** (list of agents, state dots, workspace
  grouping, pull-to-refresh) and **Agent screen** (Phase 2: terminal view + input).
- **`pairing/`** — QR scan (CameraX + ML Kit barcode, or ZXing) or manual code
  entry; stores the paired host `{address, deviceSecret}` in **EncryptedSharedPreferences /
  Android Keystore**.
- **`terminal/` (Phase 2)** — wraps Termux `terminal-emulator`/`terminal-view`:
  feed data-channel bytes, render the host-sized screen (pan/zoom), send input;
  an **extra-keys row** (Esc / Ctrl / Tab / arrows / Enter) + a text field. Smart
  Approve/Deny/answer buttons (driven by the hook `reason`) are a later convenience
  layer, not required for capability.
- **`settings/`** — host address (Tailscale MagicDNS name), paired status,
  notification prefs.

## 6. Security

- **Tailscale-only reach** on the host (bind to the tailnet interface; refuse if
  Tailscale down). WireGuard encryption + device identity at the network layer.
- **Two-layer auth:** Tailscale + app-level pairing code + interactive **approve**
  on first pair; persisted per-device secret thereafter. Phone stores the secret in
  the Android Keystore / EncryptedSharedPreferences.
- **FCM privacy:** data-only wake messages carry no terminal content; context is
  pulled over Tailscale post-wake. Minimal metadata (`paneID`, `state`) transits
  Google.
- **Least exposure:** only the fleet of the host's panes is exposed to paired
  devices; revoking a device in host Settings drops its secret + FCM token and any
  live connection.
- (Phase 2) data connections are **capability-gated**: the control handshake issues
  a per-session nonce that a pane data connection must present — no raw pane stream
  without an approved, live control session.

## 7. Reconnect / resilience

The host PTYs live in the host app and keep running regardless of the phone. The
phone connects on demand and **backs off + retries** the control connection; on
(re)connect it re-`Snapshot`s the fleet. FCM decouples *alerting* from
*connectivity* — a wake arrives via Google even when no Tailscale connection is
live, then the app dials in. Heartbeat detects dead control links.

## 8. Testing

- **Host `RemoteProtocol.swift`** → `ShepherdModelTests` (pure): frame
  encode/decode round-trip, message-DTO codec, pairing handshake state machine,
  `Snapshot`/diff application. Reuse `StopPolicy` fixtures to assert
  attention-worthy transitions trigger a push (push call mocked).
- **Host server loopback E2E:** a test client over `127.0.0.1` (loopback endpoint —
  no tailnet needed): pair → approve → `Snapshot` → drive scripted hook events →
  assert `State` forwarding + that attention transitions invoke the (mocked)
  pusher.
- **Android `model/` + protocol** — pure Kotlin unit tests (JUnit): frame
  codec parity with the host, fleet-state application, pairing state machine.
- **Android instrumented/UI** — fleet list renders states; notification tap
  deep-links; (Phase 2) terminal view renders a byte fixture + sends input.
- **Manual/real:** host on the Mac + phone on the tailnet; verify push wakes a
  swiped-away app; verify respond-to-blocker drives a real `AskUserQuestion`.
- Host runtime checks honor the standing rule: **don't kill the user's live
  Shepherd** — verify by compile + unit/loopback tests; defer GUI/device checks to
  a user-run checklist.

## 9. Open questions (resolve as we go)

- **Android repo location:** subdir of this repo (`android/`) vs a separate repo.
  Leaning `android/` here for cohesion (one place, shared protocol doc). Confirm
  before scaffolding.
- **FCM host plumbing:** confirm the Swift-side service-account OAuth2 + FCM v1 POST
  is acceptable; else switch to `ntfy` (simpler send, adds a relay).
- **Min Android SDK / target device** (the user is on the BrowserStack mobile team
  — likely has specific devices; pick a sane minSdk, e.g. 26+).
- **Protocol versioning:** since it's implemented twice (Swift + Kotlin), pin a
  version byte in the handshake and keep messages additive.

## 10. Deferred (post-Android-v1)

- **Shepherd-as-client** (the original Mac↔Mac client) — reuses this host server.
- **Remote structural control** — spawn/split/close panes from the phone.
- **Smart respond buttons** — Approve/Deny/answer affordances over the faithful
  terminal, driven by the hook `reason`.
- **iOS client** — same protocol; different terminal widget (e.g. SwiftTerm).

---

## Status / progress (update each session)

- **2026-06-30 (design + plan):** Design captured (this doc) + **Phase 1 host plan written**:
  `docs/superpowers/plans/2026-06-30-android-phase1-host-control-channel.md`
  (RemoteProtocol pure + RemoteServer loopback-tested + AgentStore wiring/approve;
  **excludes** FCM push + data channels — their own plans). Branch: `android-remote-client`.
- **2026-06-30 (Phase 1 host IMPLEMENTED):** all 3 tasks built + reviewed via
  subagent-driven-development; final whole-branch review + a concurrency-hardening pass done.
  Shipped: `RemoteProtocol.swift` (pure wire protocol + framing + pairing decision, unit-tested),
  `RemoteServer.swift` (Tailscale-bound TCP control server: pairing token + interactive approve +
  per-device secret, per-connection serial write queue, `SO_SNDTIMEO`/`SO_NOSIGPIPE` drop-on-stall,
  loopback-tested), and `AgentStore` wiring (starts on the `shepherd.remote.serving` toggle when
  Tailscale is up, projects the fleet snapshot, broadcasts state/pane-removed, persists paired
  devices) + a `PairingApprovalView` approve sheet. Tests: ShepherdModelTests 59/59, ShepherdRemoteTests
  4/4 (+ determinism loops). **Dark-shipped:** off by default, no GUI toggle yet (power-user
  `defaults write` + relaunch); per [[shepherd-dont-kill-while-live]] runtime checks (live 100.x bind,
  real device pairing) are a deferred user checklist — verified by compile + unit/loopback only.
  **Deferred to future multi-viewer:** non-blocking I/O + per-connection coalescing-by-paneID buffer.
  **Next plans still to write:** (2) host FCM push [resolve FCM-vs-ntfy first], (3)
  Android monitor app [resolve repo location + minSdk].
