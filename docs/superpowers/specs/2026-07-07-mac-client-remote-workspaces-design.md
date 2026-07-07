# Mac client — remote workspaces (full control) — design

**Date:** 2026-07-07
**Status:** Approved design; ready for implementation planning.
**Topic:** A Shepherd instance on one Mac ("client") adds another Mac's Shepherd
("host") workspaces as **remote workspaces** and drives them exactly like local
ones — create/split/close tabs & panes, type, scroll, copy, full agent-state and
notifications — with everything actually executing on the host.

Supersedes the deferred **"remote structural control"** and **"additional endpoint
types (client role)"** items of
[`2026-06-29-remote-control-design.md`](./2026-06-29-remote-control-design.md).
That document's Approach-1 decision (helper-owned PTY + byte relay over
libghostty, §3), endpoint abstraction (§6), and security model (§9) still stand
and are not re-litigated here.

---

## 1. What already exists (host side — built for the Android client)

The Android Phase 1/2 work built the **host role**, and it is client-agnostic —
it speaks a wire protocol, not "Android." Reused as-is:

- **`RemoteServer.swift`** — Tailscale-bound TCP control server; pairing +
  interactive approve (`pairingDecision` + `PairingApprovalView` +
  `respondToApproval`); per-connection reader loops; broadcasts `ControlMessage`s;
  nonce-gated per-pane raw-PTY **data channels** (`serveDataChannel`) fanned out
  by `PtyBroker` (256 KB replay ring); `applyResize` winsize arbitration.
- **`RemoteProtocol.swift`** — framed wire codec (`FrameCodec`/`FrameDecoder`),
  `ControlMessage`/`DataMessage`/`HelperFrame` enums, `pairingDecision`,
  Tailscale CGNAT interface selection.
- **`shepherdd pty`** helper (`Helper/main.swift`) — owns each served pane's real
  PTY, tees output to the broker + accepts injected input. Wired as the surface
  `command` when serving (`remoteSurfaceCommand`).
- **Serving toggle** — `shepherd.remote.serving` UserDefaults bool; when on,
  `startRemoteServingIfEnabled` binds the control server to the 100.x Tailscale
  interface and prints a pairing code.
- **`PtyBroker`/`PtyHub`**, **presence + FCM push**, **smart-approve**.

## 2. What's missing (this project — the client role)

There is **no client role**: no `RemoteClient.swift`, no `shepherdd attach`
subcommand (the helper only has `pty`), no `RemoteRef` marker on `Pane`, no mirror
workspace, no "Add remote host" UI, and the snapshot is a **flat `[PaneInfo]`**
(fine for Android's list; insufficient to render split geometry on a Mac).

Because the flat `snapshot` is being replaced (not supplemented) by the tree, the
in-repo **Android client (`./android`) migration to protocol v2** is part of this
project's scope, not a follow-on (§3.5, §10 M1).

## 3. Decisions (locked in brainstorming)

1. **Full terminal fidelity.** Mirror panes are real libghostty surfaces running
   `shepherdd attach`, streaming raw PTY bytes (byte-identical vim/REPLs/colors).
2. **Full structural control, host-authoritative.** The client can create/split/
   close/zoom/rename/reorder tabs & panes *within* a mirrored workspace. The host
   is the single source of truth; the client **sends commands and re-renders from
   the host's broadcast** (pessimistic projection, no optimistic local mutation).
3. **One remote workspace per host workspace.** Adding a host surfaces each of its
   workspaces as its own remote entry in the client's `WorkspaceSwitcher`.
4. **Whole-tree re-snapshot on structural change** (not granular structural
   deltas). Trees are tiny; always-correct and far simpler. Frequent per-pane
   `state` transitions keep using the existing lightweight `state` delta.
5. **Single protocol v2, hard cutover.** The host emits only `workspaceTree` (no
   dual-emit of the old flat `snapshot`). The in-repo Android client
   (`./android`) migrates to v2 in the same effort — it flattens the tree into its
   existing flat fleet list. Both apps are ours and ship together, so a coordinated
   bump is clean.
6. **Out of scope:** creating or deleting *entire host workspaces* from the client
   (control is within each mirrored workspace only). Optimistic echo,
   multi-viewer co-presence, non-Tailscale endpoints — all remain deferred.

## 4. Authority model

Shepherd stays one peer app playing two roles at once (your desktop can serve
while also being a client of another box). The **host owns all structure** because
the PTYs, tabs, and split trees physically live there. The client holds a
**mirror**: a read-through projection.

Structural op in a remote workspace (⌘T / ⌘D / ⌘⇧D / ⌘W / ⌘⇧↩ / rename / reorder):

```
client UI action
  → client sends cmd* over the control channel
  → host performs the real mutation on its AgentStore
     (creates the real Pane + PTY + `shepherdd pty` helper + PtyBroker)
  → host re-broadcasts that workspace's full tree (workspaceTree)
  → client rebuilds/updates the mirror Workspace → re-renders
  → for each new remote pane, the client opens a `shepherdd attach` data channel
```

The client never mutates its mirror directly. This yields zero split-brain and
reuses the host's existing broadcast machinery.

## 5. Wire protocol changes (`RemoteProtocol.swift`)

Bump `kRemoteProtocolVersion` to 2 as a **hard cutover**: the flat `snapshot` case
is **replaced** by `workspaceTree`, and both the Mac and the Android clients speak
v2 (see §9 + the Android migration in §10 M1). The host no longer emits the flat
`[PaneInfo]` snapshot at all.

**New host→client structural snapshot.** Reuses `SplitNode`'s **tree shape**, but
with **wire-specific leaf DTOs carrying live fields** — NOT the persistence `Pane`
codec, which deliberately drops `paneID`/`title`/live `state` (`SplitTree.swift`
`extension Pane: Codable`). The client mirror keys on the host's real paneID and
renders live state, so those must be on the wire:

```
case workspaceTree(WorkspaceTree)          // full tree for ONE workspace
case workspaceList(ids: [String])          // ordered host workspace ids (for switcher order + removal)
case workspaceRemoved(workspaceID: String)
```

```swift
// RemoteNode mirrors SplitNode's shape but its leaf is a live-field DTO, not Pane.
indirect enum RemoteNode: Codable, Equatable {
    case leaf(RemotePane)
    case split(axis: String, ratio: Double, first: RemoteNode, second: RemoteNode)
}
struct RemotePane: Codable, Equatable {          // one leaf, live fields
    let paneID: String; let title: String; let cwd: String?
    let state: String; let reason: String?
}
```

The Android fleet view keeps its flat model by **flattening** each
`workspaceTree`'s leaves into its existing `PaneInfo` list (paneID / title /
workspace / state all live on the tree's leaf panes) — no split geometry needed
there.

```swift
struct WorkspaceTree: Codable, Equatable {
    let workspaceID: String
    let name: String
    let tabs: [RemoteTab]
    let selectedTabID: String?
}
struct RemoteTab: Codable, Equatable {
    let tabID: String
    let root: RemoteNode     // SplitNode's shape, live-field leaves (RemotePane)
    let focusedPaneID: String?
    let zoomedPaneID: String?
}
```

Per-pane live `state` still rides the existing lightweight
`case state(paneID, state, reason)` delta (unchanged, high-frequency). The tree is
re-sent only on structural change (rare).

**New client→host commands** (host applies to its real `AgentStore`, then
re-broadcasts the affected `workspaceTree`):

```
case cmdNewTab(workspaceID: String)
case cmdSplit(paneID: String, axis: String)       // "row" | "column"
case cmdClosePane(paneID: String)
case cmdFocusPane(paneID: String)
case cmdZoom(paneID: String)                       // toggle
case cmdRenamePane(paneID: String, title: String)
case cmdReorderTab(workspaceID: String, fromIndex: Int, toIndex: Int)
case cmdSwitchTab(workspaceID: String, tabID: String)
```

Existing `resize`, `detach`, `ping`/`pong`, `refreshFCMToken`, `prompt`, smart-
approve, and the `DataMessage`/`HelperFrame`/data-channel path are all unchanged.

## 6. Client role — new pieces

### `RemoteClient.swift` (new, AppKit-shell over pure decisions)
- Owns one control connection to a `KnownHost`; runs the existing `hello`
  handshake (sends persisted per-device secret, or the pairing code on first
  pair). Receives `accepted(sessionNonce)`.
- On `workspaceTree` / `workspaceList`: build or update the corresponding mirror
  `Workspace`(s) in `AgentStore` — flagged `remote`, tagged with host id + remote
  workspace/pane ids. Rebuild each tab's `SplitNode` tree from the wire tree,
  marking every leaf `Pane` with a `RemoteRef` and (re)using stable local ids
  keyed by remote pane id so surfaces aren't needlessly torn down.
- On `state(paneID,…)`: map remote paneID → mirror pane, call the **existing**
  `AgentStore.apply` — same lifecycle map, dots, badge, notifications; no new
  state machine.
- Structural UI actions on a remote workspace are intercepted (see §7) and sent as
  `cmd*`; `focusPane` also sends a `cmdFocusPane` hint so the host's
  need-to-check→idle clear agrees.
- Exponential-backoff reconnect on the control conn; per-pane data conns reconnect
  independently and replay the ring. Link state drives per-pane
  `reconnecting…`/`dead` overlays.

### `RemoteRef` on `SplitTree.Pane` (new field)
```swift
struct RemoteRef: Codable, Equatable {
    let hostID: String
    let remotePaneID: String
    var conn: ConnState        // .live / .reconnecting / .dead
}
```
`pane.remote == nil` ⇒ ordinary local pane (unchanged). Non-nil only changes where
the surface's bytes come from and adds a small link-status glyph. `displayTitle`/
`state` logic unchanged. Everything keyed on per-pane `AgentState` (sidebar dots,
`Tab.attentionState()`, `⌘⇧A`, dock badge, notifications, cross-workspace
aggregation) works **with no change**.

### `shepherdd attach <host> <paneID>` (new helper subcommand)
A dumb bidirectional pipe between one TCP data-channel socket and its stdio (which
the client's libghostty drives):
1. Connect to `host:port`, send `DataMessage.dataHello(sessionNonce, paneID, cols,
   rows)` (nonce + host/port injected via **env, not argv** — no `ps` leak).
2. On `dataReady(cols,rows)`, go raw duplex: socket→stdout (PTY bytes libghostty
   renders), stdin→socket (keystrokes/paste), resize via the existing
   `HelperFrame.resize`.
This is byte-for-byte the data-channel protocol the Android terminal client
already uses, repackaged as a stdio pipe. Shares the one `shepherdd` binary with
`pty`.

### `GhosttyTerminal.makeSurface`
If `pane.remote != nil`, set `cfg.command = "<helper> attach"` with the host/port/
nonce/remotePaneID in injected env. Local panes are unchanged (login shell, or
`shepherdd pty` when this machine is itself serving).

## 7. Host command handling (`RemoteServer` + `AgentStore`)

`RemoteServer.process` gains the `cmd*` cases (today it handles only hello / ping /
refreshFCMToken / resize / detach). Each `cmd*` is validated (paired + live) then
dispatched to a new `AgentStore` closure that performs the mutation **on the main
actor** using the store's *existing* structural mutations (the same ones ⌘T/⌘D/⌘W
call locally). After the mutation, the store re-broadcasts the affected
`workspaceTree`. No new mutation logic — the remote command is just another caller
of the local mutation, then a broadcast.

`AgentStore` already owns `remoteServer?`; it gains: (a) a `broadcastWorkspaceTree`
tail on structural mutations of served workspaces, and (b) the `cmd*` dispatch
closures wired into `RemoteServer` at construction (like the existing `snapshot`,
`requestApproval`, `lookupBroker` closures).

## 8. UI, pairing, persistence

- **Add remote host (client, new UI):** `WorkspaceSwitcher` `+`/dropdown gains
  "Add remote host…" → enter Tailscale host (MagicDNS or 100.x) + pairing code →
  host shows its existing `PairingApprovalView` → on approve, device secret
  persisted both sides and the host's workspaces appear as remote entries
  (🖥 host·A, host·B).
- **Rendering:** a remote workspace renders like any local one via
  `SplitContainer`; header shows host name + a link-status affordance; per-pane
  `reconnecting…`/`dead` overlays. Structural keybindings work unchanged — they
  resolve to `cmd*` because the focused pane's workspace is `remote`.
- **`⌘W` semantics:** on a remote pane, ⌘W sends `cmdClosePane` (closes the host
  pane). Removing the whole remote workspace from the switcher = **disconnect**,
  never destroy the host's workspace.
- **Persistence (`shepherd.workspaces.v2`):** a mirror workspace persists only as a
  **pointer** (host id + display name + which host workspace id), never its
  tabs/panes (host's truth). On relaunch it restores as a collapsed "reconnect to
  <host>" stub that re-attaches and re-snapshots. Live agent state, zoom, and the
  tree never survive restart (consistent with local restore). Additive v1→v2
  migration tags every existing workspace `local`.
- **Menu/keys:** no new global keys. Creating/deleting *entire* host workspaces
  from the client is out of scope (§3.6); ⌘⇧N on the client makes a **local**
  workspace as today.

## 9. Compatibility, security, error handling

- **Protocol compat:** version 2 is a **coordinated hard cutover**, not additive
  back-compat — the host stops emitting the flat `snapshot` and both in-repo
  clients (Mac + Android) move to `workspaceTree` in the same effort. Acceptable
  because every host and client is ours and ships together; there is no third-party
  v1 peer to keep alive. The Android client never sends `cmd*` (it stays a
  view/respond client); only the Mac client issues structural commands.
- **Security (unchanged from the 2026-06-29 §9):** Tailscale-only bind; two-layer
  auth (WireGuard + pairing code + interactive approve, per-device secret
  thereafter); data conns capability-gated by the live session nonce;
  secret/nonce via injected env, not argv; revoke drops live conns. `cmd*` are
  accepted only from a paired, live control session — a client can only mutate a
  host that approved it.
- **Host app not running / Tailscale down:** mirror panes `dead`, control conn
  backoff-retries; explicit "host not running (no daemon)" messaging (no daemon in
  scope, same as before).
- **Host user mutates locally:** the local mutation broadcasts `workspaceTree`;
  the mirror follows. Focus falls back if a focused mirror pane vanished.
- **Shell/agent exits on host:** helper relays child-exit → data EOF → mirror pane
  → `shell`, same as a local `SessionEnd`.
- **Command race:** commands are serialized by the host's main actor; the
  authoritative re-broadcast reconciles any client/host interleaving. A `cmd*`
  naming a stale paneID (already closed) is a no-op.

## 10. Milestones (each ships & tests independently)

- **M1 — structural protocol + host commands + Android v2 migration.** Replace the
  flat `snapshot` with `WorkspaceTree`; add `cmd*` + the host-side dispatch +
  `broadcastWorkspaceTree`. **Migrate the Android client** (`protocol/
  ControlMessage.kt` + `WireCodec` gain `workspaceTree`; `FleetViewModel` flattens
  the tree into its existing `PaneInfo` list; drop `snapshot` consumption) so its
  fleet view keeps working after the host cutover — this must land with the host
  change or the Android app breaks. Pure-model tested both sides: tree
  encode/decode round-trip, command→mutation parity against a scripted local
  `AgentStore`, and the Kotlin flatten in `WireCodecTest`.
- **M2 — client role + mirror workspaces + `shepherdd attach` (loopback).**
  `RemoteClient`, `RemoteRef` on `Pane`, `shepherdd attach`, `GhosttyTerminal`
  remote branch. Real remote terminals over `127.0.0.1` (no tailnet). Loopback
  E2E: pair → mirror builds → type → echo → split → new pane appears + attaches →
  close → mirror follows.
- **M3 — Tailscale + resilience + pairing UI + persistence v2.** Bind/reach over
  the tailnet, "Add remote host" flow, backoff reconnect,
  `reconnecting`/`dead`/`attached-elsewhere` overlays, `shepherd.workspaces.v2`
  pointer persistence + migration. First real two-Mac usage.
- **M4 — polish + ADR 0016** (`0016-mac-client-remote-control.md`): host-
  authoritative full structural control, whole-tree re-snapshot rationale,
  `shepherdd attach` dumb-pipe, protocol v2 compatibility with the v1 Android
  client.

## 11. Testing

- **`RemoteProtocol` → `ShepherdModelTests` (pure):** `WorkspaceTree`/`cmd*`
  codec round-trip; rebuilding a mirror `SplitNode` tree from a `WorkspaceTree`
  and re-deriving it (idempotent); command→mutation parity reusing existing
  `SplitTree`/`Workspace` fixtures.
- **`shepherdd attach` tap** (`ShepherdHelperTests`): dials a fake data channel,
  asserts `dataHello`, raw duplex byte parity, resize frame.
- **Loopback E2E** (`ShepherdRemoteTests`): host `RemoteServer` + `RemoteClient`
  over 127.0.0.1 — pair → mirror → type → echo → structural command → re-snapshot
  → reconnect → replay.
- **State-forwarding parity:** replay a scripted hook sequence into the host
  `AgentStore`, assert the mirror reaches identical per-pane states (reuse
  `StopPolicy` fixtures).
- **Manual/real:** two Macs on the tailnet; UI via the window-id `screencapture`
  recipe in `CLAUDE.md`.
