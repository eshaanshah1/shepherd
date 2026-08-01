# Notification routing + per-workspace Mac-to-Mac sync

**Date:** 2026-08-01
**Status:** approved, implementing

Two changes that both hinge on the host knowing *which device* is doing what, rather
than treating remote clients as one anonymous pool.

---

## 1. Notification routing

### Today

`NotificationRoutingPolicy.decide(isAway:)` is a binary switch with two destinations:

```swift
struct Routing { let local: Bool; let fcm: Bool }
```

`local` deliberately gates the desktop banner **and** the attention chime together, and
`isAway` (lid shut, no external display) sends everything to the phone instead. There is
no notion of routing to a *paired Mac*, even though one may be streaming the very pane
that fired the event.

### Wanted

Three destinations, in priority order:

1. **Host Mac present** (lid open) — banner + chime locally.
2. **A remote Mac streaming that pane** — chime there.
3. **Otherwise** — phone push.

Destination 2 fires **unconditionally**, whether or not the pane is frontmost on that
Mac. This was a deliberate decision and it **knowingly departs from
[ADR 0020](../../../.claude/adr/0020-viewing-a-pane-is-one-predicate.md)**, which
suppresses alerts for a pane you are already watching. The reasoning: on the host, a
finished turn under your eyes is self-evident; on a mirror the chime is the whole point
of having the pane open, and a missed chime costs more than a redundant one. ADR 0020's
`isViewing` landing on the **host** is untouched — only the remote-Mac destination is
exempt.

On that remote Mac the **chime is required and the banner is skipped**. That forces the
one structural change to `Routing`: banner and sound stop being a single flag.

### Shape

```swift
struct Routing: Equatable {
    let banner: Bool           // host desktop banner
    let sound: Bool            // host attention chime
    let chimeDevices: [String] // deviceIDs of remote Macs streaming this pane
    let fcm: Bool
}
```

`decide` gains the set of Mac viewers for the pane. It stays pure and unit-tested,
mirroring `SleepPolicy`/`StopPolicy`.

### Supporting changes

- **`RemoteServer.paneViewers` becomes device-aware.** It is currently `[String: Int]` —
  a bare count, used only to decide who owns the pane's size. It becomes
  `[paneID: [(deviceID, kind)]]` so a Mac viewer can be told from a phone viewer.
  `viewerAttached`/`viewerDetached` carry the identity already known to the control
  session. The size-ownership logic reads the array's count and is otherwise unchanged.
- **A new host→client control message**, `.chime(paneID:)`. Additive to `ControlMessage`.
- **`RemoteClient`** plays the attention sound on receipt. No banner.

### Why not reuse the FCM path

Push is for a device that is *away*. A paired Mac on the same tailnet with a live control
session is present; waking it through Firebase to make a sound would add latency and a
cloud dependency to a link that is already open.

---

## 2. Per-workspace Mac-to-Mac sync

### Today

`AgentStore.workspaceTrees()` projects **every** workspace to **every** attached client,
and `broadcastWorkspaceTree(workspaceID:)` fans structural changes to all of them. A
paired Mac therefore mirrors the host's entire workspace list with no say in it.

### Wanted

Choose which workspaces come over when pairing a Mac, and change that selection later.

Selection is enforced **host-side**: an unselected workspace never crosses the wire. This
was chosen over a client-side filter because it is a real boundary rather than a display
preference, and the cost — per-device state plus a protocol round-trip — buys that.

### Shape

- **`PairedDevice` gains `syncedWorkspaceIDs: [String]?`.** `nil` means *all*, which
  preserves today's behaviour for every existing pairing and needs no migration.
- **`workspaceTrees()` becomes `workspaceTrees(for deviceID:)`** and filters. Every
  `broadcastWorkspaceTree` / `broadcastCurrentWorkspaceTree` call site sends per-client
  instead of to all — a workspace the client does not sync produces no traffic for it.
- **Two additive control messages:**
  - client → host: request the host's workspace catalogue (id + display name only, so the
    picker can list workspaces the client does not yet mirror);
  - client → host: set this device's selection.
- **Persistence** rides the existing paired-devices blob.

### Client UI

- A checklist presented once pairing succeeds.
- The same list in Settings → Remote, for adding or removing later.

### Edge cases

- **Deselecting a live workspace** removes its mirror on the client. Panes in it stop
  being addressable from that Mac; the host is unaffected.
- **A workspace created after selection** is not synced (selection is an explicit list,
  not a filter over future state). `nil` — the default for old pairings — still means all.
- **Notifications interact:** a pane in an unsynced workspace can have no Mac viewer on
  that device, so destination 2 above simply never selects it. No extra logic.

---

## Testing

- `NotificationRoutingPolicy` — pure, table-driven over presence × Mac-viewers × phone.
- Workspace filtering — pure projection tested over `nil` / empty / subset selections.
- Both land in `ShepherdModelTests`.

## Known limitation

The end-to-end Mac-to-Mac path cannot be verified with one machine, and the second Mac is
currently offline. Pure logic is unit-tested; the wire path ships unverified.
