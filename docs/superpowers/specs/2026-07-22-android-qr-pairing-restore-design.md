# Android QR Pairing — restoring the phone client over Tailscale

**Date:** 2026-07-22
**Status:** approved, pre-implementation
**Branch:** `android-qr-pairing-restore`

## Problem

The Android client (`android/`) is frozen at commit `cd619ab` (2026-07-07,
"protocol v2 + host commands + Android v2") and has not moved since, while
`master` continued to evolve the remote stack. Investigation (systematic
reconnaissance, not guesswork) established:

- **It still builds and its unit tests pass** — with **JDK 17** (only JDK 11 is
  on PATH; built via Homebrew `openjdk@17`). AGP 8.6.1 requires 17. This is an
  environment note, not a code defect.
- **The wire protocol did not break the phone.** The Kotlin `WireCodec` /
  `DataWireCodec` are hand-rolled tolerant parsers that read known keys and
  ignore unknown ones, so the additive changes since the freeze —
  `WorkspaceTree.defaultPath`, the new client→host `cmd*` messages — decode
  fine. The data-channel handshake, snapshot flow, resize, prompt/smart-approve,
  and FCM paths are all still protocol-compatible.
- **The one genuine breakage is pairing.** Commit `58a41a9` ("tailnet
  auto-discovery pairing") removed the pairing code **end-to-end** on the host:
  `pairingDecision` no longer takes a code and admits a *new* device only when
  its connection source IP resolves (via `tailscale status --json`) to a
  Tailscale peer owned by the **same user** as the host; otherwise it rejects
  with `"unverified peer"`. The Android `PairingScreen` still **hard-requires a
  4-digit code** (`enabled = host.isNotBlank() && code.length == 4`) that the
  host neither shows nor accepts. The user is blocked from even tapping "Pair,"
  and there is nothing to type.

A second consequence: because admission is Tailscale-identity-gated, pairing over
**adb-loopback** (source IP `127.0.0.1`) is rejected. The phone must reach the
host over Tailscale, from its own tailnet IP.

## Goal

Restore the phone to a working, pairable state and modernize its pairing to match
the Mac's post-`58a41a9` model — **no manual IP typing, no dead code field** —
using a **QR bootstrap over the existing tailnet**. Design polish beyond this is
out of scope (this restores function; UX design work follows separately).

## Non-goals / rejected alternatives

- **Full auto-discovered device list on the phone** (like the Mac's
  `RemoteDeviceSheet`). Rejected: Android third-party apps cannot read the local
  Tailscale peer list — there is no LocalAPI exposed to other apps (still an open
  feature request, tailscale/tailscale#11683). A real list would require the
  phone to hold a tailnet-wide-read **Tailscale Admin API token**, which is
  meaningful friction and secret-scope. Not worth it for the restore.
- **MagicDNS-name-typed-once** bootstrap. Rejected: closest to the manual-IP flow
  we are moving away from.
- **adb-loopback / dev bypass on the host.** Rejected: the user chose to test
  faithfully over Tailscale; no change to the host admission model.

## Approach — QR bootstrap

The host renders a QR that encodes how to reach it; the phone scans it and
connects over Tailscale. No secret in the QR: admission stays source-IP /
identity gated, so a leaked QR cannot pair from off-tailnet.

### Wire — the pairing payload (pure, byte-pinned both sides)

A single URI the QR encodes and the phone parses:

```
shepherd://pair?host=<magicdns-name>&ip=<100.x.y.z>&port=8722&name=<hostname>
```

- `host` — the host's MagicDNS name (stable, human-readable); the phone connects
  here first (Android's system resolver serves MagicDNS when Tailscale is up).
- `ip` — the host's Tailscale IPv4, used as a **fallback** if `host` does not
  resolve/connect.
- `port` — the control-channel port (default `8722`).
- `name` — display label only.

Pure codec on each side, unit-tested against the **exact same** string:
- Swift: `PairingPayload.encode(host:ip:port:name:) -> String`.
- Kotlin: `PairingPayload.parse(String) -> Parsed?` (host, ip, port, name),
  tolerant of missing optional keys, rejecting a wrong scheme.

### Mac host (serving side)

1. **`TailscaleDiscovery.parse`** — also capture the host's own
   `Self.DNSName` (trailing dot trimmed) and first CGNAT `Self` Tailscale IPv4.
   Add `selfDNSName: String?` and `selfIPv4: String?` to `TSStatus`. (Today only
   `Self.UserID` is read.)
2. **`PhonePairingQRView`** — a self-drawn Theme sheet (styled like
   `RemoteDeviceSheet` / `PairingApprovalView`): renders the payload as a QR via
   Core Image (`CIFilter.qrCodeGenerator`, no dependency), plus the MagicDNS name
   and port as selectable text. Backdrop-click / Esc dismiss. If Tailscale is
   down (no `selfIPv4`), show a "Tailscale is not running" message instead.
3. **⋯ overflow menu** — add **"Connect a phone…"**, shown only while
   `isServing`. Sets a `showingPhonePairingQR` flag on `AgentStore`, mirroring
   `showingRemoteDevices`.

### Phone client

1. **Dependency + permission** — add `com.journeyapps:zxing-android-embedded`
   (self-contained scanner, drop-in `ScanContract` via the AndroidX
   ActivityResult API, no Play-Services dependency) and the `CAMERA` permission
   in the manifest.
2. **`PairingPayload`** (Kotlin, pure) — parse the scanned URI.
3. **`PairingScreen`** rework:
   - Primary **"Scan QR to pair"** button → launches the ZXing scan contract →
     on a result, `PairingPayload.parse` → `vm.pair(host, ip, port)`.
   - A small collapsible **"Enter host manually"** fallback: host + port only.
   - **Remove the 4-digit code field and the `code.length == 4` gate entirely.**
4. **Connect preference** — `PairingViewModel.pair(host, ip, port)` builds the
   `RemoteConnection` against an **ordered candidate list** `[host, ip]`
   (deduped, nils dropped): each session attempt walks the list and connects to
   the first candidate that succeeds, so a MagicDNS miss transparently falls back
   to the literal IP without surfacing an error. The existing backoff/retry loop
   is unchanged.
5. **`PairingController.helloForFirstPair`** — drop the `code` parameter; the
   first-pair `Hello` sends `pairingCode = null`. `PairingViewModel.pair` sheds
   its `code` argument. `ControlMessage.Hello` keeps its nullable `pairingCode`
   field for wire compatibility (host tolerates its absence).

## Data flow

```
Mac serving
  → ⋯ "Connect a phone…" → PhonePairingQRView renders
      shepherd://pair?host=work.tailXXXX.ts.net&ip=100.78.141.27&port=8722&name=work
  → phone (Tailscale up) scans → PairingPayload.parse
  → RemoteConnection dials host:8722 (from the phone's tailnet IP)
  → host verifyPeer(sourceIP) resolves same-user peer → needsApproval
  → PairingApprovalView (Allow / Deny) on the Mac
  → Accepted(sessionNonce) → phone persists Pairing → FleetScreen
```

## Error handling

- Phone Tailscale down / `host` unresolved → try `ip`; if both fail →
  `PairingState.Error("Can't reach host — is Tailscale on?")`.
- Unparseable / wrong-scheme QR → inline error, remain on the scan screen.
- Host not serving → connect refused → surfaced as `PairingState.Error`.
- Host Tailscale down when opening the QR sheet → "Tailscale is not running"
  message, no QR.

## Testing

**Pure / unit (author-verified, compile + tests):**
- `PairingPayload` round-trip: Swift `encode` output parses in Kotlin and vice
  versa; missing-optional and wrong-scheme cases (both sides).
- `TailscaleDiscovery.parse` captures `selfDNSName` / `selfIPv4` from a fixture.
- Updated `PairingControllerTest` (no code param; first-pair `Hello` has null
  `pairingCode`).

**Manual / E2E (user-verified over Tailscale):**
- Bring `nothing-phone-2` online on the tailnet.
- Mac: enable serving → "Connect a phone…" → QR shows.
- Phone: scan → approve on Mac → agent fleet loads → open an agent → terminal +
  smart-approve still work.

**Environment:** build with JDK 17 (`JAVA_HOME=/opt/homebrew/opt/openjdk@17/...`).

## Files touched (anticipated)

Mac (`spike/seam1/Sources/`): `TailscaleDiscovery.swift`,
`PhonePairingQRView.swift` (new), `SidebarView.swift`, `AgentStore.swift`,
`ContentView.swift` (present the sheet), `RemoteProtocol.swift` or a new
`PairingPayload.swift` (pure). Tests under `spike/seam1/Tests/`.

Phone (`android/app/src/main/java/com/eshaan/shepherd/`):
`protocol/PairingPayload.kt` (new), `ui/PairingScreen.kt`, `ui/PairingViewModel.kt`,
`pairing/PairingController.kt`, `transport/RemoteConnection.kt` (ip fallback),
`AndroidManifest.xml`, `app/build.gradle.kts`. Tests under `app/src/test/…` plus
`PairingControllerTest.kt` update.
