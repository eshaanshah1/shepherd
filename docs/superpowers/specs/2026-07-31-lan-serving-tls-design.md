# LAN serving over TLS — design

**Date:** 2026-07-31
**Status:** implemented + tested, both halves (2026-07-31). Runtime evidence pass (§7's tcpdump row) is outstanding.
**Scope:** Mac ↔ Mac **and** Android, first slice

Serve a Shepherd host to your own devices over any local link — same wifi, a phone
hotspot, ethernet — with no Tailscale involved, and with the wire safe on a network you
do not control.

## Why

Tailscale already routes direct over the local link when it can, so this is not about
speed. It is about the cases where the tailnet is not available: not installed, blocked
by a locked-down network, or a phone without the app. The tailnet path stays the default.

The requirement that shapes everything: **encrypted end to end, on a public network.**
Today's control channel is plaintext — WireGuard is doing the encryption, and the moment
the same socket sits on a café LAN it broadcasts the pairing secret, workspace names, and
raw PTY bytes (your keystrokes, any token a terminal prints) to everyone on the link.

## Non-goals

- No plaintext fallback on the LAN listener, ever, under any toggle.
- No automatic trust of anything discovered. Discovery is not identity (§3).
- No cert rotation, no expiry handling. One identity per Mac, reset by hand (§5).
- No change to the tailnet path's transport. It keeps its raw sockets (§1).
- Nothing hides the tailnet's own plaintext frames — they are inside WireGuard.

## 1. Architecture: a second listener behind one seam

The LAN listener is **additive**. `NWListener` + `NWProtocolTLS` (TLS 1.3), on
`0.0.0.0:8723` (`AgentStore.defaultLANPort`), advertising Bonjour from the same object.
The existing `RemoteServer` raw-socket listener keeps serving the tailnet on the tailnet
address, unchanged.

Network.framework is right *because* this listener is new: there are no blocking read
loops to unpick, and it hands us TLS, Bonjour advertising, and IPv6 in one API.

**How it reaches the control path — revised during implementation.** This section originally
specified a `Transport` protocol with `FDTransport` / `NWTransport` implementations. Reading
`RemoteServer` first showed why that was the wrong trade: it is fd-keyed at every level that
matters — `clients[fd]`, a per-fd serial write queue, the data-channel handoff that gives the
raw fd to `serveDataChannel`, and `PtyBroker`'s viewer fds — so the seam would have rewritten
the path the tailnet depends on daily, to add a feature that is meant to be additive.

What shipped instead: `LANListener` terminates TLS and hands `RemoteServer` **one end of a
`socketpair`** (`LANBridge`), which `acceptBridged(fd:peerIP:)` adopts exactly as if it had
accepted an ordinary socket. Consequences:

- The tailnet path is untouched, and its loopback tests are unchanged.
- **The data channel came for free.** A `dataHello` on a bridged connection sniffs and routes
  through `serveDataChannel` like any other, so PTY streaming is encrypted with no extra work.
- The plaintext exists only in this process's memory and a kernel socket buffer it owns — never
  on a wire, so the end-to-end property is unaffected. Someone with root could read it, but
  they could read process memory anyway.
- The cost is one in-process copy per direction and two fds per connection.

`FrameCodec` / `FrameDecoder` were already transport-agnostic and are untouched.

**A separate port, not a second bind of 8722.** A `0.0.0.0` listener and a
`100.x`-specific listener on one port is BSD-specific `SO_REUSEADDR` behaviour, and which
socket receives a connection depends on bind specificity. Two ports, no ambiguity.

**`0.0.0.0`, not a chosen interface.** One listener covers wifi, ethernet, and a hotspot
with no per-interface selection and no rebinding when the link changes — the failure mode
that produced the OpenVPN bind bug, avoided by construction rather than by a better
heuristic. It also answers on the tailnet address, which is harmless: TLS plus a code or a
secret is still required.

## 2. Threat model — what an attacker on that LAN gets

**Protected:** frame contents (workspace names, pane titles, agent state, prompts), PTY
bytes both directions, the pairing secret. Confidentiality and integrity from TLS 1.3,
forward secrecy from its ephemeral key exchange, server authentication from the pin (§4).

**Not protected:** that a Shepherd host exists on the link (Bonjour advertises it), and
frame sizes and timing. Neither is worth padding traffic for.

**Out of scope:** either endpoint being compromised. No transport fixes that.

## 3. Discovery is untrusted by construction

`NWListener(service:)` advertises `_shepherd._tcp`; `NWBrowser` on Mac and `NsdManager` on
Android find it. The TXT record carries `v=1` and nothing else — a hostile network learns
nothing from us it cannot learn from any AirPlay device on the same link.

Every discovered host renders as **unknown, must pair**: `RemoteDeviceRow.Pairability`
grows a `.lanUnpaired` case, so the existing sheet gains a state rather than a new UI. A
row's presence is a convenience for not typing an address; it is never evidence of
identity. Manual `host:port` entry keeps working, which is also the fallback on a network
that blocks mDNS.

## 4. Identity: authorize with a code, authenticate the channel with a SAS

Two separate jobs, deliberately not conflated.

**The pairing code authorizes.** The host shows 6 digits, valid 5 minutes, 3 attempts,
one device. It proves a human is standing at the host. `ControlMessage.hello` already
carries `pairingCode: String?` — the field the tailnet path stopped using — so the wire
needs no new message.

**The SAS authenticates the channel.** Both ends derive 6 digits from SHA-256 of the
server's **whole certificate DER** — not its SPKI, so that `SecCertificateCopyData` on
Swift and `X509Certificate.getEncoded()` on Kotlin hash byte-identical input. The cert is
never rotated, so pinning the cert rather than the key costs nothing.

```swift
func sasDigits(certHash: Data) -> String   // pure, 6 digits, byte-pinned across languages
```

The host computes its own offline. The client computes it from the certificate it
*actually saw*. A man in the middle must present its own key, so its SAS differs — that
is the entire detection mechanism, and it needs no TLS exporter plumbing.

**The comparison cannot be a button.** A Confirm button gets mashed, and then the property
this feature exists for is gone. So the host's approval sheet shows **three** codes — the
real SAS and two decoys — and you pick the one the client is displaying. No match means
abort. A colliding SAS is 1-in-10⁶ on a single shot; a user who picks blind gives an
attacker 1-in-3 rather than 1-in-1. This is Bluetooth numeric comparison / ZRTP.

The existing `PairingApprovalView` grows the three-choice variant (not `NSAlert` — three
buttons plus Cancel is past what it does cleanly).

**Reconnect needs neither.** Approval mints the per-device secret exactly as today; from
then on a known device pairs by secret over either origin, with no code and no comparison.

**One admission decision, extended.** `pairingDecision` stays the only place this is
decided, and gains an origin:

```swift
enum PeerOrigin: Equatable { case tailnet, lan }   // `peer:` stays its own parameter
enum ConfirmKind: Equatable { case trustedOrigin, compareSAS }

// The tailnet parameters keep their defaults, so that call site does not move at all.
func pairingDecision(deviceID: String, secret: String?, known: [PairedDevice],
                     newSecret: String, peer: VerifiedPeer?, selfUserID: String?,
                     origin: PeerOrigin = .tailnet, deviceName: String? = nil,
                     presentedCode: String? = nil, activeCode: String? = nil,
                     codeAttemptsLeft: Int = 0) -> PairingDecision
```

| case | decision |
|---|---|
| known device, secret matches | `.accept(persistSecret: nil)` — either origin |
| known device, secret wrong | `.reject("bad secret")` |
| new, `.tailnet` verified same user | `.needsApproval(…, confirm: .trustedOrigin)` — today's path |
| new, `.lan`, `pairingCode == activeCode`, attempts left | `.needsApproval(…, confirm: .compareSAS)` |
| new, `.lan`, code absent/wrong/expired/exhausted | `.reject("bad code")` |
| new, anything else | `.reject("unverified peer")` |

`.needsApproval` gains the `confirm` field so the policy — not the AppKit shell — decides
which approval a connection deserves. Randomness stays out of the model: `newSecret` is
already injected, and the SAS decoys arrive the same way
(`sasChoices(real:decoys:insertAt:)`).

## 5. Server identity — settled by spike

One self-signed **RSA-2048** identity per Mac, minted on first LAN serve by a one-shot
`/usr/bin/openssl req -x509` + `openssl pkcs12 -export`, then imported with
`SecPKCS12Import` and handed to `sec_protocol_options_set_local_identity`. Reused forever;
regenerating invalidates every pin. No SwiftPM dependency — the spike proved the shell-out
path works, so `swift-certificates` is not needed.

Three things the spike settled, each of which would otherwise be a live bug:

- **RSA, not P-256.** An EC p12 written by the system LibreSSL makes `SecPKCS12Import`
  raise an Objective-C exception from inside `SecIdentityCreate` →
  `SecKeyCopyExternalRepresentation` — a crash, not an error code. RSA-2048 imports
  cleanly. TLS 1.3 is equally happy with either.
- **The p12 needs a passphrase.** An empty one fails with `-25293`
  (`errSecAuthFailed`). A constant passphrase is used, and it is not the protection —
  the `0600` file mode is, exactly as for an unencrypted `~/.ssh/id_ed25519`.
- **Cert DER is what gets hashed**, per §4, because that is the one representation both
  platforms can produce identically.

Stored at `~/.shepherd/lan-identity.p12`, mode `0600` — deliberately not the keychain:
keychain items are scoped to the signing identity, and an ad-hoc-signed rebuild would
prompt or lose access on every iteration. `AppMode.isDev` already redirects the support
subtree, so the dev app gets its own identity for free.

Settings → Remote grows **Reset LAN identity**, which regenerates and forgets every LAN
pairing, because every pin it handed out is now wrong.

**A first pairing has no pin.** Not covered originally, and it has to be: `LANBridge.Trust`
is `.pinned(hash)` for every later connection and `.learn` for the first, which accepts the
certificate and reports its hash. Nothing is stored until the host's user picks the SAS derived
from it — a learned certificate is never trusted on its own evidence.

## 6. Client pinning

Mac: `sec_protocol_options_set_verify_block` on the `NWConnection`, taking the leaf out of
the `sec_trust_t` via `SecTrustCopyCertificateChain` and comparing SHA-256 of
`SecCertificateCopyData` against the stored pin. Android: an `X509TrustManager` comparing
SHA-256 of `cert.encoded`. First pair stores the pin next to the secret; every later
connection compares and refuses on mismatch **before sending any frame**, so a substituted
host never sees the secret.

**A refusal arrives as `.waiting`, not `.failed`** (spike: `-9808: bad certificate
format`). Network.framework treats a handshake rejection as retryable and stays in
`.waiting` indefinitely, so `NWTransport` must treat a TLS error there as terminal, cancel,
and report — otherwise a pin mismatch renders as "connecting…" forever, which is the worst
possible presentation of a possible attack. `RemoteClient`'s existing reconnect logic must
not retry a pin mismatch either: a wrong pin is a decision, not an outage.

## 7. Testing

The claim is "encrypted on a public network", so the tests have to be about bytes, not
about having called a TLS API.

- **Ciphertext on the wire.** Loopback host + client exchanging a known workspace name;
  a tap on the raw socket asserts neither that name nor the 4-byte frame length prefix
  pattern appears in what crosses it.
- **Pin mismatch refuses, silently and early.** A second identity is rejected, and the tap
  asserts zero frames were written before the refusal.
- **No downgrade.** A plaintext client against the LAN listener is dropped; with the
  toggle off, nothing is listening on 8723 at all.
- **SAS is a function of the key.** Substituting the key changes the digits; a fixed
  input's expected digits are pinned in **both** Swift and Kotlin (the `PromptQuestion`
  byte-pinning precedent) so the two implementations cannot drift into showing different
  numbers for the same host.
- **Admission policy.** Pure `pairingDecision` cases per §4's table, including expiry and
  attempt exhaustion, in `ShepherdModelTests`.
- **On-device.** `tcpdump -i en0` between the two Macs and between Mac and phone,
  confirming no plaintext — the evidence, not the unit tests, is what closes this feature.

## 8. Staging

0. ~~**Spike (throwaway):** mint a `SecIdentity`, stand up `NWListener` + TLS, connect with
   `NWConnection` + verify block.~~ **Done 2026-07-31** — passed end to end: identity
   imported, TLS 1.3 established, client-observed cert hash equal to the server's,
   mismatched pin refused. Its four findings are folded into §4–§6.
1. `Transport` seam; tailnet path moved onto `FDTransport` with no behaviour change.
2. LAN listener on `0.0.0.0:8723` + Bonjour advertise; `PeerOrigin` / code / SAS policy,
   pure and tested.
3. Mac UI: the *Serve on local network* toggle, the host's code display, the three-code
   pick in `PairingApprovalView`, `.lanUnpaired` rows + code entry + SAS display in
   `RemoteDeviceSheet`.
4. Data channel over the same LAN listener (PTY streaming is why this matters).
5. Android: `NsdManager` discovery, `SSLSocket` + pinning `TrustManager` in
   `transport/RemoteConnection.kt` and `transport/DataChannel.kt`, code entry + SAS screen,
   shared SAS vector.
6. Evidence pass (§7's on-device row), then ship — the Android half needs an app release
   to be usable.

## 9. Known risks

- ~~**`SecIdentity` minting**~~ — settled by the spike (§5).
- **Three-code pick is a custom sheet**, not an alert; `PairingApprovalView` has to grow a
  variant rather than gain a parameter.
- **macOS Application Firewall** may prompt on the first `0.0.0.0` bind. Nothing to do but
  expect it.
- **A blind picker** still hands an attacker 1-in-3 at pairing time. Inherent to numeric
  comparison; the decoys exist to stop reflexive mashing, not to make guessing impossible.
