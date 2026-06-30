# Host FCM push — design (Android Phase 1, step 2)

**Date:** 2026-06-30
**Status:** Implemented (host-side, dark-shipped). The Android receiver is step 3. See "Status / progress" at the bottom.
**Branch:** `android-fcm-push`.
**Prereq context:** Builds on the shipped **Phase 1 host control channel** (squash `506e7cd` on `master`) and the design it implements:
[`2026-06-30-android-client-design.md`](2026-06-30-android-client-design.md) (read its §2 decisions + §4 host server first) and
[`2026-06-29-remote-control-design.md`](2026-06-29-remote-control-design.md).

> **Resuming across sessions:** read this whole file, then the "Status / progress" section at the bottom. This is **step 2 of three** in Android Phase 1: (1) host control channel — *done + merged*; (2) host FCM push — *this doc*; (3) Android monitor app — *next*.

---

## 1. Goal & boundary

When an agent on the **host** (the macOS Shepherd) needs attention and you're **away from the
machine**, wake your phone — even with the app swiped away — over Firebase Cloud Messaging
(FCM). The push carries only a tiny data-only signal (`{paneID, state, urgent}`, **no terminal
content**); the woken app dials back over Tailscale to pull context and raise its own local
notification.

**This step delivers the host wake mechanism only.** It does **not** build the Android receiver
(step 3) or per-pane data channels (Phase 2). It is independently buildable, and — crucially — the
only risky part (the auth pipeline) is **independently verifiable without a phone** (§8).

It also introduces a **notification-routing layer** that decides, per attention transition,
whether to fire the host's existing desktop notification *or* an FCM push, based on whether you're
physically at the machine.

## 2. Decisions (the "why", so future sessions don't relitigate)

These were settled in this brainstorming session:

- **Transport = FCM, not ntfy.** FCM is the correct mobile push primitive: Google wakes a
  swiped-away app with **no relay we run/trust** and **no persistent connection** on the phone,
  and data-only payloads keep terminal content off Google. The only cost is one-time host-side
  auth plumbing (service-account → JWT/RS256 → OAuth2 access token → HTTPS POST). ntfy was rejected
  because its "simpler send" relocates the complexity into a public relay (topic name = the only
  secret) or a self-hosted relay we must run + keep reachable, and delivering to a swiped-away app
  without shipping ntfy's own app effectively needs a persistent phone connection — which conflicts
  with the design's "no persistent foreground service" decision.
- **Push policy = all three attention states, urgency-tagged.** `blocked` + `error` + `needsCheck`
  all push, but the payload carries an `urgent` flag (`blocked`/`error` = urgent → FCM high
  priority; `needsCheck` = normal). The host pushes everything + dedups flaps; the Android side
  (step 3) routes the two priorities to different notification channels so turn-done can be muted
  without losing "stuck." Complete now, noise-tunable later in the right layer.
- **Away-detection = lid closed AND no external display attached.** "Lid open = at the machine" is
  the base signal, hardened against the clamshell-at-desk setup (lid shut + external monitor): an
  attached external display means you're present even with the lid down. So you only get phone
  pushes when you're genuinely mobile.
- **Routing is mutually exclusive on presence, and gates *all* local surfaces.** "Local surfaces" =
  the desktop banner (`notifyAttention`) **and** the attention sound (`playAttentionSound`) — both
  are local alerting, so both follow presence. Present → local surfaces only (banner + sound), as
  today; away → FCM push only, with **every local surface suppressed** (no banner, no sound — a
  closed laptop must never chirp to an empty room); on the away→present edge, a **catch-up** sweep
  fires desktop banners (only) for panes *still* needing attention. "Which panes the phone handled"
  needs no cross-device bookkeeping: acting on a blocker drives the **host** PTY, so the host
  observes that pane leave its attention state on its own — catch-up notifies only what's still
  outstanding.

## 3. Architecture (files; pure/shell split, mirroring `StopPolicy`/`AgentStore`, `SleepPolicy`/`SleepGuard`)

Lives in `spike/seam1/Sources`.

- **`FCMMessage.swift`** — *pure model, unit-tested in `ShepherdModelTests`*. No AppKit, no network,
  no crypto. Holds:
  - `parseServiceAccount(_ json: Data) -> ServiceAccount` — extract `client_email`, `private_key`
    (PEM), `project_id`, `token_uri` from the Google key JSON.
  - `buildSigningInput(clientEmail:tokenURI:scope:iat:) -> String` — the base64url `header.claims`
    JWT signing input (`iat`/`exp` derived from the passed-in `iat`, so it is deterministic to
    test — same discipline `SleepPolicy` uses to keep `Date.now` out of the model).
  - `buildWakeMessage(token:paneID:state:urgent:) -> [String: Any]` — the **data-only** FCM v1
    body: `{"message":{"token":…,"data":{"paneID":…,"state":…,"urgent":"true|false"},"android":{"priority":"high|normal"}}}`.
    No title, no cwd, no content.
  - `PushDecision.shouldPush(paneID:state:lastPushed:now:window:) -> Bool` — dedup/coalesce: skip a
    same-pane, same-state push within `window` seconds (guards a flapping pane from a buzz-storm).
- **`FCMPusher.swift`** — *AppKit/IO shell; not unit-tested (loopback + standalone manual check)*.
  - Loads the service-account key at startup if present; caches the OAuth2 access token + its
    expiry; `ensureToken()` re-mints when stale (~1 h TTL).
  - **RS256 signing** via the Security framework
    (`SecKeyCreateSignature`, `.rsaSignatureMessagePKCS1v15SHA256`). **The one genuinely fiddly
    bit:** Google keys are **PKCS#8** (`-----BEGIN PRIVATE KEY-----`) but `SecKeyCreateWithData`
    expects PKCS#1 — mitigation is stripping the fixed-length PKCS#8 RSA wrapper to recover the
    inner PKCS#1 DER, then `SecKeyCreateWithData(kSecAttrKeyType=RSA, kSecAttrKeyClass=Private)`.
    This is the single implementation risk; the standalone auth check (§8) verifies it directly.
  - `wake(tokens:paneID:state:urgent:) async -> [String]` — token-exchange (cached) → one FCM
    `messages:send` POST per device token → returns the tokens Google rejected as
    `UNREGISTERED`/invalid so the caller can prune them. Runs off the main thread.
- **`NotificationRoutingPolicy.swift`** — *pure model, unit-tested*. No AppKit.
  - `decide(isAttentionWorthy:isAway:) -> Routing` where `Routing = (local: Bool, fcm: Bool)`.
    `local` gates **both** local surfaces together — the desktop banner *and* the attention sound
    (a closed/away machine fires neither).
  - `catchUpTargets(panes:) -> [PaneRef]` — given the fleet, the panes still in an attention state
    (`blocked`/`needsCheck`/`error`) to desktop-banner (no sound) on the away→present edge.

## 4. Routing policy (the unified desktop-vs-push decision)

`isAway = lidClosed && !externalDisplayAttached`. `isPresent = !isAway`.

| State | Local surfaces — desktop banner (`notifyAttention`) + sound (`playAttentionSound`) | FCM push |
|---|---|---|
| **Present** (at the machine) | both fire (unchanged) | suppress |
| **Away** (mobile) | both suppressed (no banner, no sound) | fire — `urgent = (blocked‖error)`, `needsCheck = normal`; deduped |
| **away → present edge** | **catch-up**: banner only (no sound burst) for panes *still* in an attention state | stop |

- **Inputs to `isAway`:** lid state from the existing `ClamshellMonitor`; external-display presence
  from `CGGetActiveDisplayList` filtered by `CGDisplayIsBuiltin` (any active non-builtin display ⇒
  attached). Live changes observed via `NSApplication.didChangeScreenParametersNotification` (plug
  in/out) and `ClamshellMonitor`'s lid change (open/close). The composite `isAway` is recomputed on
  either event; its **away→present transition** triggers the catch-up sweep.
- **Catch-up is host-state-derived, not phone-reported.** Responding to a blocker drives the host
  PTY → the pane's `AgentState` clears host-side → it's no longer an attention target. So the
  catch-up sweep, which notifies only panes *currently* in an attention state, automatically skips
  anything resolved while away and surfaces only what's still outstanding.

## 5. Push fire-point (`AgentStore.apply`)

The existing attention block (`AgentStore.swift:345`, where `notifyAttention` + `playAttentionSound`
already fire on `res.state != cur && res.state.wantsAttention`) becomes a single routing call:

```
if res.state != cur, res.state.wantsAttention, let updated = …pane {
    let r = NotificationRoutingPolicy.decide(isAttentionWorthy: true, isAway: isAway())
    if r.local {                                   // both local surfaces, together
        notifyAttention(updated, inWorkspace: …)
        playAttentionSound(for: res.state)
    }
    if r.fcm { pushWake(paneID: paneID, state: res.state) }   // off-main; reads persisted tokens
}
```

- `pushWake` is gated on `isServing` **and** a configured pusher (absent key ⇒ silent no-op —
  dark-ship clean). It reads the **persisted** paired-device tokens directly (push does **not**
  require a live control channel — that's the whole point), applies `PushDecision` dedup, sets
  `urgent`, dispatches `fcmPusher.wake(…)` off-main, and prunes any dead tokens it returns.
- The away→present edge handler runs `NotificationRoutingPolicy.catchUpTargets(fleet)` and fires a
  desktop notification for each.
- Reuses the existing cross-workspace aggregation (`locatePane`, the fleet helpers) — the fleet
  spans all panes across all workspaces, as it already does for the dock badge / `⌘⇧A`.

## 6. Protocol changes (`RemoteProtocol.swift` — additive)

No deployed Kotlin client exists yet, so these are not wire-back-compat-constrained — only the
loopback tests update.

- `hello(deviceID, deviceName, pairingCode, secret)` → add **`fcmToken: String?`** (the phone's
  token at pairing) and **`protocolVersion: Int`** (pin the version in the handshake — closes the
  "implemented twice, keep it versioned" open question while we're already editing `hello`; the
  server records/checks it and keeps messages additive thereafter).
- New case **`refreshFCMToken(token: String)`** — phone→host on the live control channel; FCM rotates
  tokens. The server maps the connection's `deviceID` → its stored `PairedDevice`, updates the token,
  and persists.
- `PairedDevice` → add mutable **`fcmToken: String?`** (persisted in `shepherd.remote.devices`; old
  blobs decode to `nil` — migration-safe).

## 7. Token lifecycle

- **Capture:** `hello.fcmToken` is persisted into `PairedDevice` on approve (the `persist` closure
  already runs on the accept path; it just carries one more field).
- **Rotate:** `refreshFCMToken` on the control channel updates that device's stored token + persists.
- **Invalidate:** `wake()` returns the tokens Google rejected (`UNREGISTERED`/invalid); `AgentStore`
  clears them from the owning device + persists. Self-healing — a stale token never wedges pushes.
- **Revoke:** dropping a device (revoke UI is a deferred Phase-1 item) clears its secret + token +
  any live connection, per the Android-client design §6.

## 8. Firebase setup (the one-time external dependency)

- Create a **free Firebase project** once — it serves *both* this step (the server's service-account
  key) and step 3 (the Android app's `google-services.json`). Worth doing now.
- Server key: **Firebase console → Project Settings → Service Accounts → Generate new private key** →
  a JSON file.
- It lives at **`~/.config/shepherd/fcm-service-account.json`** (consistent with the existing
  `~/.config/shepherd/config` theme convention, ADR 0010). `project_id` is read **from** the key
  (no separate config). **Absent key ⇒ push disabled, no error** (dark-ship clean).
- Documented in the README alongside the existing pmset/sudoers keep-awake setup.

## 9. Two interactions worth recording (spec, not code)

1. **Keep-awake dependency.** Pushes only happen while the host is *awake* processing hook events.
   If the lid closes and the machine sleeps, the agents freeze — there is nothing to push about. So
   "get pushed while away" presupposes the **sleep guard** is holding the host awake (the
   "while-agents" mode). The features compose: walk away → keep-awake holds the host → an agent
   blocks → FCM wakes the phone.
2. **Phase-1 reality.** The monitor app (step 3) can't *act* on agents yet (no input until Phase 2).
   So during a lid-closed stretch nothing is resolved via phone → the away→present catch-up
   correctly fires for **all** still-blocked panes. The "skip the ones I handled" benefit switches on
   automatically once Phase 2 adds input — same code, no change.

## 10. Security

- **Service-account key** is a send-only credential scoped to FCM messaging for the one project.
  Stored as a user-readable file in `~/.config/shepherd/` for v1 simplicity; **Keychain storage is a
  noted hardening follow-up**, not v1.
- **Data-only payloads** carry `{paneID, state, urgent}` only — no titles, cwd, or terminal content
  transits Google (matches the Android-client design §6). `urgent` is derived purely from `state`, so
  it carries no new information off the host — privacy is unchanged.
- **FCM tokens** are per-device push capabilities, stored in `PairedDevice` (UserDefaults). Dropped
  on invalidation or device revoke.
- The push path adds **no new network listener** and **no public egress beyond Google's FCM/OAuth
  endpoints**; the Tailscale-only bind of the control server is unchanged.

## 11. Testing

- **Unit (`ShepherdModelTests`, pure):** service-account key parse; JWT signing-input builder
  (deterministic `iat`); data-only wake-body shape + urgency mapping; `PushDecision` dedup window;
  `NotificationRoutingPolicy.decide` truth table + `catchUpTargets`; protocol round-trip for the new
  `hello.fcmToken` + `protocolVersion` + `refreshFCMToken`.
- **Loopback (`ShepherdRemoteTests`):** pairing persists `fcmToken`; `refreshFCMToken` updates it;
  an attention transition while *away* invokes a **mocked** pusher with the right tokens + urgency
  and fires **no local surface** (`decide` returns `local=false` → neither banner nor sound); the
  same transition while *present* returns `local=true` (banner + sound) and **no** push; dedup
  suppresses a rapid repeat; the away→present edge replays catch-up banners for still-attention
  panes only.
- **Standalone auth check (no phone, manual):** point the pusher at a real service-account key and
  hit Google's token endpoint — a `200` + `access_token` proves the entire **key-parse / PKCS#8→PKCS#1
  / RS256 / JWT / OAuth** pipeline, which is the only risky plumbing. FCM's `validateOnly` flag can
  exercise a send-shaped request too.
- **End-to-end real-device wake:** deferred to **step 3's** checklist (needs the app to register and
  produce a real token).
- Honors the standing rule — **don't kill the user's live Shepherd** ([[shepherd-dont-kill-while-live]]):
  verify by compile + unit/loopback + the standalone token check; defer device E2E to step 3.

## 12. Out of scope (this step)

- The Android receiver (`FirebaseMessagingService`, local-notification raise, deep-link) — **step 3**.
- Per-pane data channels + terminal view/input — **Phase 2**.
- Device-revoke UI; Keychain storage of the key — noted hardening follow-ups.
- Any change to the Tailscale bind, the control-channel framing beyond the additive fields above, or
  the existing state lifecycle.

---

## Status / progress (update each session)

- **2026-06-30 (design):** This doc written from a brainstorming session. Decisions settled:
  FCM (not ntfy); push all three attention states urgency-tagged + host dedup; away =
  lid-closed-AND-no-external-display; mutually-exclusive desktop-vs-push routing with an
  away→present catch-up sweep; `protocolVersion` pin folded into `hello`. Next: writing-plans →
  implementation plan for this step.
- **2026-06-30 (implemented):** Host FCM push built per the plan
  `docs/superpowers/plans/2026-06-30-android-phase1-fcm-push.md`. Shipped:
  `FCMMessage.swift` (pure: key parse, JWT signing-input, data-only wake body,
  PushDecision dedup), `NotificationRoutingPolicy.swift` (pure present-vs-away +
  catch-up), `FCMPusher.swift` (OAuth2/RS256/PKCS#8 + data-only send + dead-token
  prune), `PresenceMonitor.swift` (lid + external-display away signal), protocol
  (hello.fcmToken + protocolVersion + refreshFCMToken + PairedDevice.fcmToken),
  RemoteServer token persistence/refresh, AgentStore routing + pushWake + catch-up.
  Tests: ShepherdModelTests 77/0, ShepherdRemoteTests 6/0. Dark-shipped (no key
  ⇒ no push). Live device-delivery deferred to step 3's checklist.
