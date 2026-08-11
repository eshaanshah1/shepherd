# Shep-nets: membership replaces pairing — design

**Date:** 2026-08-11
**Status:** Approved design, and **built** — `packages/remote` implements it end
to end (`net.ts`, `netcrypto.ts`, `join.ts`, `roster.ts`, `netstore.ts`, a
rewritten `server.ts`, and the app/daemon wiring). Where the build decided
something this document had left open, or corrected it, the section says so.
**Supersedes for this area:** the pairwise model in
[`2026-08-09-v2-attachment-and-remote-design.md`](2026-08-09-v2-attachment-and-remote-design.md)
§4 R2, and everything `packages/remote/src/pairing.ts` and `devices.ts` say
about a device being paired *to a Mac*. The ceremony survives; what it grants
does not.
**Scope:** v2 `packages/remote` **and the Android client** (`android/…/v2`),
which speaks protocol 4. v1 (`spike/seam1`) keeps its own pairing until it is
retired.

---

## 1. The ask, and the thing that actually forces it

> "I'm thinking we build an idea of *shep-nets*, kinda like tailnets. So a
> device can join a shep-net, and instantly connect to all other devices in that
> shep-net."

The reason to do this is sharper than convenience. Today's model is **pairwise
and asymmetric**. A host stores `PairedDevice{id, name, secret, pin, …}` — a
secret it issued to that one device — and the client stores that one host's
certificate hash. Both halves are about a *pair*.

So the ceremony count is `N × (N−1) / 2`. Two devices is one ceremony and feels
fine. A phone, a MacBook and a Mac mini is three. Adding a fourth device is
three more, each with a six-digit code typed on one machine and a SAS compared
on the other. The model doesn't scale with the number of devices a person owns,
and every new device makes it worse.

A net fixes this structurally rather than ergonomically: **membership becomes
the credential**, so two devices that have never met authenticate on first
contact with no ceremony at all. The join cost goes from `N−1` ceremonies to
exactly one, forever.

## 2. What a shep-net is

A name and a root keypair. The net's **id is the SHA-256 of the root public
key** — stable, comparable across implementations, and short enough to show a
human when two nets need telling apart.

Every device holds its own keypair and a **member credential**: a certificate
over its public key, signed by whichever member admitted it, chaining back to
the root. Verification is a chain walk terminating at the net id.

**Any member can admit** (decided over a founder-holds-the-CA model and a shared
symmetric net key). Which means every member is, in effect, an intermediate CA,
and a joiner's chain reads `me ← admitter ← … ← root`. This is the option that
preserves what the current system already gets right — any device can pair with
any device, with nobody designated and nothing that has to be online. The
founder model would have made one machine load-bearing for every future join;
the shared-key model would have had no way to revoke anything short of rotating
the key on every device by hand.

The cost, stated up front: admission is transitive, so a device admitted by the
phone is trusted by the Mac mini that never saw it. That is acceptable **because
every admission still requires a human at both ends** (§3) — transitivity moves
trust between machines the user owns, not between people.

## 3. Joining: the ceremony survives intact

The existing two-halves doctrine in `pairing.ts` is right and is kept verbatim:

- The **code** authorizes. Six digits shown on the admitting device, proving a
  human is standing at it. `freshCode`, `CODE_LIFETIME_MS`, `CODE_ATTEMPTS` and
  `codeState` are unchanged.
- The **SAS** authenticates. Digits derived from the certificate both ends
  actually negotiated, so a man in the middle produces different digits.
  `sasDigits` and `sasChoices` are unchanged, including the finding that matters
  most — the host shows **three** candidate groups and the user picks the
  joiner's, because an "Allow?" button gets pressed without looking.

What changes is the payload. On approval the admitting member signs the joiner's
member certificate and returns the net id, the net name, the current roster and
the current tombstones. `pairingDecision` becomes `joinDecision`, and its check
order is preserved for the reason the original comment gives: **a known member is
checked before the code**, so a reconnecting device never spends an attempt on a
code the user is still typing.

`PairedDevice.secret` and `PairedDevice.pin` both die. Nothing bearer-shaped
remains in the model — and that is exactly why a **proof** had to be added.

**Proofs (decided during the build, and not optional).** A credential chain is
public: it reaches every member. Presenting one shows only that such a membership
exists, not that the presenter holds the key it names. So each direction proves
possession:

- **The client** signs `(netId, this host's certificate pin, a timestamp)` with
  its member key. Binding to the host's pin is what makes a proof captured at the
  laptop worthless at the Mac mini; the timestamp bounds replay to a minute
  (`PROOF_LIFETIME_MS`). It cannot use a nonce — it speaks first, so it has none
  to answer.
- **The host** signs `(netId, the nonce the client sent)`. The client chose the
  nonce, so the answer cannot be a recording. This is what replaces "I pinned this
  certificate" as the client's evidence that it reached the right Mac.

## 4. Transport authentication

Today: TLS with `rejectUnauthorized: false` plus an explicit fingerprint
comparison, which is the entire trust model and is why the R2 probe notes insist
it be written out.

Now: **TLS stays one-way** — the host terminates it with the same RSA identity
`identity.ts` already mints — and membership is proven inside the channel by the
chain plus the two proofs above. Verification is *"this chains to the root of the
net I am in, and no member in that chain is tombstoned"*, in both directions.

Client certificates were considered and dropped: a phone never serves, so it has
no certificate to present, and a scheme that only works between Macs would leave
the phone on a second code path — which is the drift this whole rewrite exists to
remove. A credential still carries `certPin`, for a member that *does* serve, so a
peer's credential can be checked against the certificate it actually presented.

This kills a real bug class rather than just moving it. Under pinning, a host
that re-mints its identity breaks every client it has — the pin is wrong
everywhere, with no path back except re-pairing all of them. Under a chain, host
identity rotation is a local event.

## 5. Roster and revocation

Membership solves *proving* who a peer is. It does not solve *finding* peers —
a phone that joined via the MacBook still has to locate the Mac mini.

**Transports keep discovering; the net filters.** mDNS `_shepherd._tcp` on a
LAN, tailnet enumeration for Tailscale — `api.ts` already states that discovery
is a transport's business and not remote-core's, and that holds. Membership just
decides which discovered candidates are dialable.

**Plus a gossiped roster**, because discovery is silent across networks. On every
connect, members exchange:

```
roster:     [{ memberId, name, addrs[], admittedBy, admittedAt, updatedAt }]
tombstones: [{ netId, memberId, at, signer: Credential[], signature }]
```

**Corrected during the build: entries are NOT signed, tombstones are.** An
address is a hint, and forging one costs an attacker a connection that then fails
the chain check and gains them nothing — while signing entries would mean
re-signing every member's record each time an address changed. A tombstone
DENIES, so a forged one would evict a device its owner still wants; it is signed,
and it carries **its signer's whole chain** rather than naming a member. That last
part is what makes revocation travel more than one hop: a Mac can accept "the
phone is revoked" relayed by a laptop it has never met.

Entries merge last-write-wins per member id; tombstones merge **earliest-wins**,
which is the opposite rule and deliberately so — a revocation is not a fact that
changes, it is a fact that happened, and keeping the earliest record stops anyone
making one look more recent by re-signing it. Resolution order when locating a
peer: whatever a transport discovered, else the roster's last-known addresses,
else show it in the list, greyed, as not reachable.

The roster earns its place twice: it makes off-LAN dialing possible, and it is
the channel revocation already needed. There was no other place for tombstones
to live.

**Revocation is gossip, and gossip is fail-open.** A machine that never hears
"the phone is revoked" keeps serving the phone. The fail-closed answer is an
epoch: rotate the root, re-issue every member certificate, and anything not
re-issued falls out by silence rather than by being told.

**Decision: the `epoch` field ships in the credential from day one; the rotation
operation does not.** Re-issuing requires reaching every member, and any device
offline during a rotation has to re-join by hand — so at three or four devices
"bump the epoch" and "make a new net and re-join everything" are close to the
same amount of work, and the second one is already free. Carrying the field now
means adding the operation later is not a protocol bump.

## 6. What membership authorizes

**Entry.** A member can drive a session on any other member that is serving. The
net is the trust boundary, and the only remaining gate is the existing per-host
serving toggle, which is off until asked for.

No per-host allow-list and no roles. Both were considered; both add a policy
layer to design, enforce on every command and explain in a UI, in exchange for
tightening a boundary the user has already decided sits at the net.

## 7. Multiple nets

A device stores N memberships and has **exactly one active**. The active net
decides what the transports advertise, what they browse, and what may be dialed.

This is one field in core and a switcher in the app. It costs nothing and it
does not block the case that motivated the feature: a phone watching two laptops
works because both laptops are members of one net. The active-net rule only
bites *across* nets — between, say, home and work — which is where the
separation is wanted.

## 8. Migration: re-join once

There is no literal migration path, and the reason is worth stating rather than
discovering during implementation. Minting a member credential means signing **a
device's public key**, and no such key exists anywhere in a `PairedDevice`
record: `secret` is a bearer token the host issued, `pin` is the client's copy of
the host's certificate hash. Neither is signable into a net.

So the only question is what happens on first reconnect after upgrade. **Decision:
old records are dropped and each device performs the code+SAS ceremony one final
time.**

The alternative — auto-issuing a member certificate to any device presenting its
valid old `secret` — is smoother and was rejected on blast radius. That secret
was issued to reach *one* Mac; under §6 it would now reach *all* of them.
Promoting a leaked bearer token into net membership is precisely the escalation
this design otherwise removes, and one ceremony per device, once, is a small
price for every credential in the net having been witnessed by a human.

On upgrade a Mac becomes the root of a net named after itself. Devices re-join it.

## 9. Protocol version, and the client

`REMOTE_PROTOCOL_VERSION` goes **3 → 4**, and the Android client speaks it: the
handshake carries a chain and a proof, the accept carries the net's facts and an
issued membership, and the phone verifies the Mac before believing any of it.

Two things about the phone that the Mac's side did not have to decide:

- **Ed25519 comes from Bouncy Castle, not the platform.** `minSdk` is 31 and JCA
  only offers Ed25519 from API 33, so two supported Android versions would have
  had no signing at all — a scheme that works on some phones is a net that admits
  some phones. The lightweight API is used directly, which also keeps the whole
  net layer testable as plain JVM unit tests.
- **The canonical bytes are pinned against the Mac's, not re-derived.** A
  signature covers `JSON.stringify` of an array, so `Net.canonical` reproduces
  JavaScript's escaping by hand and `NetTest` asserts the exact strings — plus it
  verifies a real signature the Mac produced. "Both sides used JSON" is not a
  guarantee that both sides produced the same bytes, and a near-miss would only
  ever show up as a refusal on the other machine.

**Joining is one link.** `remote.pair` returns the facts, a `shepherd://join?…`
URI and that URI rendered as a QR block; the phone scans it or takes it pasted,
through one parser (`payload.ts` / `JoinLink.kt`) that refuses anything it cannot
fully act on. It carries the net id **and** the root key, which check each other,
so a truncated or edited link is caught before a byte is sent. Nobody types an
88-character key.

## 10. Shape in code

| Now | After |
| --- | --- |
| `pairing.ts` | `join.ts` — code and SAS unchanged, decision rewritten around membership, plus both proofs |
| — | `net.ts` — credential shape, canonical signing bytes, chain walk. Pure. |
| — | `netcrypto.ts` — the one module touching `node:crypto`: Ed25519 keys, signing, net id |
| — | `roster.ts` — entries, tombstones, merge rules, tombstone verification. Pure. |
| `devices.ts` | `netstore.ts` — memberships, active net, roster and tombstones in the same KV |
| `server.ts` | verifies a chain instead of comparing a pin; issues credentials; gossips |
| `endpoint.ts`, `transports.ts` | filter candidates by the active net |

The split between `roster.ts` and `netstore.ts` is one the plan did not name: the
merge rules are pure and belong with the model, the KV binding is not, and this
package already keeps that line everywhere else.

The existing discipline holds throughout: **randomness stays out of the model.**
Codes, decoys, keypairs and signing inputs are passed in, so every decision is a
pure function a test pins without stubbing a generator. `net.ts` is pure for the
same reason `pairing.ts` is — the crypto primitives are injected, the chain walk
and the id derivation are not.

Two processes still share the store, and the invariant that makes that safe is
unchanged: **only the app writes a new member**, because only the app can show an
approval. The daemon reads. A headless process cannot admit a stranger.

## 11. Testing

Pure-model tests, no sockets:

- chain verification — valid chain, wrong root, tombstoned member, self-signed
  impostor, chain through a member that was itself later tombstoned
- roster merge — last-write-wins per member, tombstone beats a newer roster entry
- `joinDecision` order — a returning member never spends a code attempt; a known
  member id with a bad credential is a rejection and not a code attempt
- net id derivation — stable across serializations

The existing loopback e2e in `e2e.test.ts` covers the handshake end to end, and
gains a case for two members that have never met connecting with no ceremony.

## 12. Decided during the build

- **Signatures are Ed25519 and credentials are not X.509.** A credential is a
  signed JSON array with a version tag, and keys travel as hex DER (SPKI public,
  PKCS8 private) because they ride inside JSON frames and sit in a KV, where
  PEM's armour and newlines survive neither well. Minting is sub-millisecond
  against the ~70ms of the RSA-2048 TLS identity, signatures are 64 bytes, and
  there is no curve, digest or padding parameter to get wrong. The TLS identity
  stays exactly as it was — RSA, self-signed, `identity.ts` — because it does a
  different job; the credential binds to it by carrying its pin.
- **The root private key stays on the founding device.** It signs exactly one
  credential, ever: the founder's. Every later admission is signed by the
  admitting member's own key, so no other device needs it, and a key that
  travelled to every member would be a key that leaks from any of them.
- **This Mac's device id is minted once and kept** (`device-id` in the same KV).
  It is what a credential names and what a tombstone names, so a fresh one per
  launch would arrive at every other member as a stranger.

## 13. Still open

- **A second Mac.** A phone HAS joined a real Mac (2026-08-11): net created from
  the CLI, QR scanned, credential issued, and the phone verified the Mac's chain
  and its signature over the nonce before trusting the accept — over the `wifi`
  transport, no cable. What is still unexercised is the case the whole design is
  for: a device walking up to a SECOND member and being admitted with no
  ceremony. That needs two Macs in one net.
- The join sheet and the net switcher. The verbs exist (`remote.nets`,
  `remote.createNet`, `remote.useNet`, `remote.leaveNet`, `remote.members`,
  `remote.revoke`, `remote.pair`), which is deliberately the order this repo
  builds in: a verb is reachable from the palette and the CLI the moment it is
  registered, and a contributed view draws a prettier version later without
  becoming a second implementation.
- Transports filtering by the active net — `remote-lan` and `remote-tailscale`
  do not exist yet, so there is nothing to filter.
