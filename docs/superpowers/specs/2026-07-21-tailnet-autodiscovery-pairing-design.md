# Tailnet auto-discovery pairing — design

**Date:** 2026-07-21
**Status:** Approved design; ready for implementation planning.
**Topic:** Replace the manual "enter host name + 4-digit pairing code" remote-pairing
flow with **auto-discovery of your own Tailscale devices**. A client lists the tailnet
peers that belong to you, marks the ones running Shepherd as pairable, and pairing a
device is: click it → an approval popup appears on that device → Allow → paired. No
codes, no manual host entry.

Builds on [`2026-07-07-mac-client-remote-workspaces-design.md`](./2026-07-07-mac-client-remote-workspaces-design.md)
(the client role, `RemoteClient`, mirror workspaces) and
[`2026-06-29-remote-control-design.md`](./2026-06-29-remote-control-design.md)
(the Tailscale-bound host, pairing, interactive approval). Those documents' security
model, PTY relay, and endpoint abstraction stand and are not re-litigated here — this
document changes only **how a client finds a host and how a first pairing is gated.**

---

## 1. Motivation & security rationale

Today a client pairs by typing the host's Tailscale name/IP and a 4-digit pairing code
the host displays while serving; the host then shows an interactive approval popup. The
code is a second factor on top of WireGuard.

On a **personal tailnet**, WireGuard already authenticates every reachable peer as one
of the user's own devices, so the code is largely redundant — the interactive approval
popup is the real human gate. Dropping the code and discovering devices automatically is
therefore both safer-feeling and lower-friction. **But** two things become load-bearing
once the code is gone, and this design makes them explicit rather than assumed:

1. **"Every tailnet device is mine" is only true on a personal tailnet.** Tailscale also
   supports node-sharing and multi-user / org tailnets (plausible in a corporate setting).
   There, tailnet membership ≠ ownership. The fix is programmatic, not a trust assumption:
   **only discover and pair peers whose `UserID == Self.UserID`.**
2. **The device name in the `hello` handshake is self-reported and spoofable.** With the
   code gone, the approval popup is the *only* gate, so it must display the
   **Tailscale-verified** identity of the connecting peer (resolved from its source IP via
   the Tailscale daemon), never the self-asserted `hello` name.

Net effect: dropping the code + same-`UserID` filtering + verified identity on the popup
is **stronger** than today's code-on-a-personal-tailnet, and safe-by-default on a shared
tailnet.

### Verified environment facts (2026-07-21, this machine)
- `tailscale status --json` works; peers carry `HostName`, `TailscaleIPs`, `OS`,
  `Online`, `UserID`, `DNSName`. A `User` map resolves `UserID → LoginName/DisplayName`.
- Personal tailnet: single login (`eshaan.shah@gmail.com`), all peers share one `UserID`.
- The Tailscale install is the **`macsys` network-extension variant**
  (`io.tailscale.ipn.macsys`): **no public unix socket** under `/var/run/tailscale*`, so
  the LocalAPI is not portably reachable.
- `/usr/local/bin/tailscale` is a 3-line shell **shim** forwarding to
  `/Applications/Tailscale.app/Contents/MacOS/Tailscale`. The shim is written by the app's
  manual **"Install CLI"** action (not auto-installed). The in-app binary is always present
  when the app is installed.

## 2. Why the CLI, and not a library or the LocalAPI

- **No native library fits.** Tailscale is Go. The only embeddable option is `libtailscale`
  / `TailscaleKit` (a CGo wrapper over `tsnet`), which makes Shepherd its **own new tailnet
  node** with its own identity + auth key and routes the app's traffic through that embedded
  node. It does **not** introspect the peer list of the user's already-installed, logged-in
  Tailscale — which is exactly what discovery needs. Rejected: wrong model (a second device),
  heavy, needs an auth key, zero gain over asking the running daemon.
- **The LocalAPI is not portable here.** The socket path/auth differs across the three
  variants (App Store, `macsys`, open-source `tailscaled`), and the `macsys` variant on this
  machine exposes no stable public socket. The `tailscale` CLI is the supported wrapper over
  exactly that LocalAPI.
- **The CLI is not a separate dependency.** It is the binary bundled inside the Tailscale app
  the user already runs (a precondition for being on the tailnet at all). We resolve it by
  path — we do **not** depend on the "Install CLI" shim:
  1. `/Applications/Tailscale.app/Contents/MacOS/Tailscale`  ← reliable anchor
  2. `/usr/local/bin/tailscale`  (shim, if present)
  3. `/opt/homebrew/bin/tailscale`, `/usr/bin/tailscale`  (open-source variant)
  First hit wins.

**Accepted risk:** `status --json` / `whois` output is a semi-public contract, stable in
practice (the CLI itself depends on it) but not a versioned guarantee. Acceptable.

## 3. Discovery source & "pairable" detection

- **Device list:** invoke the resolved `tailscale` binary → `tailscale status --json`. Parse
  `Self` and `Peer`; resolve `User[UserID]` for display names.
- **"Mine" filter:** keep only peers with `UserID == Self.UserID`; exclude `Self`.
- **"Shepherd running" = pairable:** a short-timeout TCP connect probe to the peer's Tailscale
  (100.x) IP on the shared control port (`AgentStore.defaultRemotePort`). Connect succeeds ⇒
  Shepherd is *serving* there ⇒ pairable. (A device running Shepherd but not serving fails the
  probe and shows as not pairable — correct: you can only attach to a serving host.)
- **Row status:** online + probe-ok → *pairable*; online + probe-fail → *"Shepherd not
  running"*; offline → *"offline"*. All three are listed; only pairable rows are clickable.
- **Cadence:** probe on sheet open + a manual **Refresh** + a light periodic re-probe while the
  sheet is visible.

## 4. Pairing flow (no code)

```
client discovery sheet → pick a pairable device
  → client dials peerIP:port, sends hello WITHOUT a pairing code
     (still sends its own deviceID / deviceName / persisted secret if any)
  → host captures the peer source IP, verifies identity (§5), decides:
       known device + matching secret        → accepted   (no popup — unchanged)
       unknown but verified same-UserID peer  → needsApproval → PairingApprovalView
       IP not a peer / different UserID        → reject
  → on Allow: per-device secret persisted BOTH sides; accepted(nonce) returned;
     mirror workspaces appear (unchanged post-approval path)
```

Reconnects after the first approval are silent forever (persisted secret), exactly as today.

## 5. Host-side verification (the hardening)

- **Capture the peer source IP.** `RemoteServer`'s accept currently calls
  `accept(lfd, nil, nil)` — change to `accept(lfd, &addr, &len)` and extract the peer IPv4.
- **Resolve to a verified identity** via the Tailscale daemon: `tailscale whois <ip>` (or match
  the IP against the host's own `tailscale status --json` peer list). Yields the peer's real
  `UserID` + node/login name. This resolution is host-side and independent of anything the
  client claims.
- **`pairingDecision` signature change** (pure function, `RemoteProtocol.swift`): **drops**
  `code` and `currentCode`; **gains** the verified peer identity (`UserID` + verified name,
  optional — nil if the IP didn't resolve) and the host's own `Self.UserID`. New logic:
  - known `deviceID` + secret matches → `.accept(persistSecret: nil)`
  - known `deviceID` + secret mismatches → `.reject("bad secret")`
  - unknown + verified peer present + `peer.UserID == selfUserID` →
    `.needsApproval(deviceID:, name: <verified name>, proposedSecret:)`
  - otherwise → `.reject("unverified peer")`
- **`PairingApprovalView`** shows the **verified** name, not `hello`'s self-reported string.

## 6. Discovery sheet UI

- Self-drawn `Theme` card over a dimmed backdrop (matches `PairingApprovalView` /
  `NewWorkspaceModal`; no native sheet/alert), opened from the sidebar ⋯ overflow menu via a
  new **"Add remote device…"** item (replaces "Add remote host…").
- Rows: OS glyph (mac/phone/…) · device name · status. Pairable rows are clickable and show
  inline per-row progress ("pairing…" → "approved" / "denied" / "unreachable"); non-pairable
  rows greyed with their reason. Header carries a **Refresh** button.
- Empty / error states: `tailscale` binary not found → message pointing at Tailscale; no
  same-`UserID` peers → "No other devices on your tailnet."
- All controls `.focusable(false)` (sidebar/HUD convention — keep focus on the terminal).

## 7. Protocol, wiring & compatibility

- **No protocol version bump.** `hello`'s `pairingCode` field stays on the wire (the Android
  client still sends it) but the **host ignores it** — the gate is now whois + same-`UserID` +
  approval. The host simply stops *requiring* a code and starts *requiring* a verified
  same-`UserID` source. This is back-compatible for the existing Android client, which keeps
  its current manual flow untouched.
- **`RemoteServer` construction** loses the `currentCode` closure dependency (the code is no
  longer consulted) and gains a **peer-identity resolver** closure (IP → verified
  `UserID`/name) injected from the app shell, so the pure `pairingDecision` stays testable and
  the `tailscale whois` `Process` call lives in the AppKit layer.
- **`AgentStore`:** `addRemoteHost(host:port:code:)` → `addRemoteHost(host:port:)` (code
  dropped). New surface for discovery: a `TailscaleDiscovery` service (list peers, filter,
  probe) feeding the sheet. `store.pairingCode` and its ⋯-menu display are removed; the
  "Serve to remote devices" toggle stays.
- **Serving side** is otherwise unchanged: toggling serve still binds the control server to the
  Tailscale interface; it just no longer needs to mint/show a code.

## 8. New / changed pieces (summary)

| Piece | Change |
|---|---|
| `TailscaleDiscovery.swift` (new) | Resolve `tailscale` binary; parse `status --json`; same-`UserID` filter; TCP port-probe; `whois <ip>` identity resolver. Pure parse/filter split from the `Process`/socket shell for unit tests. |
| `RemoteProtocol.pairingDecision` | Drop `code`/`currentCode`; add verified peer identity + `selfUserID`; new decision logic. |
| `RemoteServer` | `accept` captures peer IP; construction drops `currentCode`, gains peer-identity resolver; `process(hello)` uses the new decision. |
| `PairingApprovalView` | Show verified name. |
| `RemoteDeviceSheet.swift` (new) | The discovery sheet UI. |
| `SidebarView` overflow menu | "Add remote host…" → "Add remote device…"; remove pairing-code display. |
| `AgentStore` | `addRemoteHost(host:port:)`; discovery wiring; remove `pairingCode`. |

## 9. Persistence / out of scope

- **Persistence unchanged.** Per-device secret is still stored both sides (approve once,
  reconnect silently). Nothing new to persist; no migration.
- **Out of scope:** non-Tailscale endpoints; discovering/pairing peers on a *different*
  `UserID` (deliberately excluded); a discovery UI on the Android client (Android keeps its
  existing flow; the host change is back-compatible for it); node-sharing across tailnets.

## 10. Testing

- **`TailscaleDiscovery` (pure, `ShepherdModelTests`):** parse a canned `status --json` into
  peers; same-`UserID` filter drops other-user/shared peers and `Self`; row-status derivation
  from (online, probe-result) tuples; binary-path resolution order; `whois` output parse.
- **`pairingDecision` (pure, `ShepherdModelTests`):** known+good-secret → accept;
  known+bad-secret → reject; unknown+verified-same-UserID → needsApproval (name = verified,
  not self-reported); unknown+unresolved-IP → reject; unknown+different-UserID → reject.
- **Loopback E2E (`ShepherdRemoteTests`):** client dials host over 127.0.0.1 with no code →
  host (with a stub identity resolver returning a same-`UserID` peer) → needsApproval →
  approve → accepted → reconnect with persisted secret is silent.
- **Manual/real:** two Macs on the tailnet; discover → pick → approve on the far Mac → mirror
  appears. Screenshot via the window-id `screencapture` recipe in `CLAUDE.md`.

## 11. Milestones

- **M1 — verification + protocol.** `pairingDecision` change; `RemoteServer` peer-IP capture +
  identity-resolver injection; `PairingApprovalView` verified name; drop code from `hello`
  handling and `addRemoteHost`. Pure-tested; loopback E2E with a stub resolver. (Host is now
  code-free and identity-gated; existing manual/Android flows still work.)
- **M2 — discovery service.** `TailscaleDiscovery`: binary resolution, `status --json` parse,
  same-`UserID` filter, port-probe, `whois`. Pure-tested.
- **M3 — sheet UI.** `RemoteDeviceSheet`; ⋯-menu rewire; remove pairing-code display; wire
  click → `addRemoteHost(host:port:)`. First real two-Mac discovery-to-pair run.
