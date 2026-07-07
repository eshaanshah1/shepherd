# Mac Client Remote Workspaces — M2–M4 Implementation Plan

> **For agentic workers:** execute task-by-task, TDD where a unit/integration test is possible, compile-verify the AppKit/libghostty/UI shell, commit per task. Verify by build + tests; defer the real two-Mac runtime check to the user.

**Goal:** Turn the M1 protocol foundation into a working native Mac client: add another Mac's workspaces as fully-controllable remote workspaces with real terminals.

**Builds on M1 (already on master):** protocol v2 (`WorkspaceTree`, `cmd*`), host `broadcastWorkspaceTree` + `applyRemoteCommand`, `shepherdd pty`, `RemoteServer` pairing/data-channels.

## Architecture recap (from the design spec)

Host-authoritative. Client dials host → `hello` → receives `workspaceTree`s → builds **mirror** `Workspace`s (flagged remote). Mirror pane surfaces run `shepherdd attach <host> <paneID>` (real PTY bytes). Local structural actions on a remote workspace are **not** applied locally — they send `cmd*`; the host mutates + re-broadcasts the tree; the mirror re-renders. Inbound `state` deltas feed the existing `AgentStore.apply`.

---

## M2 — client role + real remote terminals (loopback)

### Task M2.1 — Pure models: RemoteRef, remote markers, mirror-tree rebuild
**Files:** `Sources/SplitTree.swift` (+`RemoteRef`, `Pane.remote`, `buildMirrorNode`), `Sources/Workspace.swift` (+`remoteHostID`/`remoteWorkspaceID`), test `Tests/RemoteProtocolTests.swift` (or `Tests/SplitTreeTests.swift`).
**Produces:**
```swift
struct RemoteRef: Equatable { let hostID: String; let remotePaneID: String; var conn: RemoteConnState }
enum RemoteConnState: String { case live, reconnecting, dead }
// Pane gains: var remote: RemoteRef? = nil   (NOT persisted — live only)
// Workspace gains: var remoteHostID: String? = nil; var remoteWorkspaceID: String? = nil  (nil = local)
// Inverse of buildRemoteNode: rebuild a SplitNode from a wire RemoteNode, marking each
// leaf Pane with a RemoteRef(hostID, remotePane.paneID, .live) + live state; fresh local
// paneIDs but the RemoteRef carries the host's id for surface command + command routing.
func buildMirrorNode(_ node: RemoteNode, hostID: String) -> SplitNode
```
- TDD: `buildMirrorNode` round-trips a `RemoteNode` into a `SplitNode` whose leaves carry the right `RemoteRef` + state; `Pane.Codable` still omits `remote`; a `Workspace` with `remoteHostID` set reports remote.
- Commit: `feat(remote): RemoteRef + mirror-tree rebuild (pure model)`.

### Task M2.2 — `shepherdd attach` helper subcommand
**Files:** `Helper/main.swift`, test `HelperTests/…` (loopback against a fake server socket).
- New `attach` subcommand: read env `SHEPHERD_ATTACH_HOST`/`PORT`/`NONCE`/`PANE` (secret/nonce via env, not argv). Connect TCP, send `DataMessage.dataHello(nonce, pane, cols, rows)` framed via `DataFrameCodec`, await `dataReady`, then raw duplex: socket→STDOUT, STDIN→socket; `SIGWINCH` → send `HelperFrame.resize` up the socket. On EOF/`dataRejected` → restore tty + exit.
- Reuse `makeOuterRaw`/`restoreOuter`/`installWinchForwarder` patterns from `pty`.
- Integration test: stand up a loopback TCP server that speaks `dataHello`→`dataReady`→echoes bytes; assert attach forwards stdin→socket and socket→stdout, and a resize emits a `HelperFrame.resize`.
- Commit: `feat(remote): shepherdd attach — client-side raw PTY pipe`.

### Task M2.3 — `RemoteClient.swift` (control connection)
**Files:** `Sources/RemoteClient.swift` (new — needs `project.yml` add to app + `ShepherdRemoteTests`), test `RemoteTests/RemoteClientTests.swift`.
**Produces:**
```swift
final class RemoteClient {
    init(host: String, port: UInt16, deviceID: String, deviceName: String,
         code: String?, secret: String?, connect: (String, UInt16) -> Int32,   // injectable for loopback
         onAccepted: (String) -> Void,                 // sessionNonce
         onWorkspaceTree: (WorkspaceTree) -> Void,
         onWorkspaceList: ([String]) -> Void,
         onState: (String, String, String?) -> Void,   // paneID,state,reason
         onStatus: (RemoteConnState) -> Void)
    func start(); func send(_ cmd: ControlMessage); func stop()
    var sessionNonce: String? { get }
}
```
- One reader loop: send `hello`, decode frames via `FrameDecoder`, dispatch to callbacks. `send` frames `cmd*`/`ping` to the socket.
- Loopback test: real `RemoteServer` (known device, auto-approve) + `RemoteClient` over 127.0.0.1 → assert `onAccepted` + `onWorkspaceTree` fire; `client.send(.cmdNewTab)` reaches the server's `onCommand`.
- Commit: `feat(remote): RemoteClient — control channel + mirror callbacks`.

### Task M2.4 — AgentStore client integration + command routing
**Files:** `Sources/AgentStore.swift`.
- Own `private var remoteClients: [String: RemoteClient]` keyed by hostID.
- `func addRemoteHost(host: String, port: UInt16, code: String)` → make a `RemoteClient`, wire callbacks: `onWorkspaceTree` → `upsertMirrorWorkspace(tree, hostID:)` (build/replace a `Workspace(remoteHostID:hostID, remoteWorkspaceID:tree.workspaceID)` whose tabs come from `buildMirrorNode`; preserve local pane ids across updates by keying on `remotePaneID` so surfaces aren't torn down); `onState` → resolve mirror pane by remotePaneID → `apply`-equivalent set; `onStatus` → mark panes' `RemoteRef.conn`.
- **Command routing:** at the top of each structural mutation (`newTab`, `splitFocused`, `closePane`, `focusPane`, `toggleZoom`, `rename(tabID:)`, `reorder`+`commitOrder`, `select`), if the acting workspace is remote, translate to the matching `cmd*` on that workspace's `RemoteClient` and **return without mutating locally**. Helper: `private func routeIfRemote(_ make: (RemoteClient, String /*remoteWSID*/) -> ControlMessage?) -> Bool`.
- Unit-testable slice: `upsertMirrorWorkspace` mapping (pure-ish) can be tested by extracting a free function `buildMirrorWorkspace(tree, hostID) -> Workspace` in `Workspace.swift`; the routing guard is AppKit shell (compile + manual).
- Commit: `feat(remote): AgentStore mirror workspaces + command routing`.

### Task M2.5 — GhosttyTerminal remote surface
**Files:** `Sources/GhosttyTerminal.swift`, `Sources/RemoteWiring.swift` (extend `remoteSurfaceCommand`).
- If `pane.remote != nil`: `cfg.command = "<helper> attach"`, inject `SHEPHERD_ATTACH_HOST/PORT/NONCE/PANE` env from the pane's `RemoteRef` + the client's nonce (looked up via a store accessor). Local panes unchanged.
- Compile-only (libghostty surface). Commit: `feat(remote): mirror panes run shepherdd attach`.

### Task M2.6 — "Add remote host" UI (minimal)
**Files:** `Sources/WorkspaceSwitcher.swift` (+ a small sheet), `Sources/ShepherdApp.swift` if a menu item helps.
- Add "Add remote host…" row → sheet with host + 4-digit code fields → `store.addRemoteHost(...)`. Host-side approve sheet already exists.
- Compile-only + manual. Commit: `feat(remote): Add remote host UI`.

**M2 done-when:** builds; `buildMirrorNode`/`buildMirrorWorkspace` unit tests green; `shepherdd attach` integration test green; `RemoteClient` loopback test green; manual: two app instances over 127.0.0.1 (or one instance serving + a second pointed at it) mirror + drive.

---

## M3 — Tailscale + resilience + persistence v2

### Task M3.1 — Reconnect + link status
- `RemoteClient` exponential-backoff reconnect on control-conn drop; per-pane data conns already independent (helper exits → surface shows dead). `onStatus(.reconnecting/.dead/.live)` drives `RemoteRef.conn`; `SplitContainer` shows a `reconnecting…`/`dead` overlay on remote panes.
- Test: loopback — kill the server, assert client goes `.reconnecting`; restart, assert `.live` + re-`workspaceTree`.
- Commit: `feat(remote): client reconnect + link-status overlays`.

### Task M3.2 — KnownHost + persistence v2
- `KnownHost` (hostID + display name + last endpoint) persisted client-side. `shepherd.workspaces.v2`: a remote workspace persists as a **pointer** (hostID + name), not its tabs/panes; on launch it restores as a "reconnect to <host>" stub that re-attaches + re-snapshots. v1→v2 migration tags existing workspaces local.
- Test (pure): persistence snapshot/restore of a pointer workspace; migration.
- Commit: `feat(remote): KnownHost + workspaces.v2 pointer persistence`.

### Task M3.3 — Tailscale endpoint
- Client dials the host's Tailscale MagicDNS/100.x address (the host already binds it + shows the code). `AccessEndpoint` type behind the host string. Manual two-Mac verification.
- Commit: `feat(remote): reach hosts over Tailscale`.

---

## M4 — ADR + polish

### Task M4.1 — ADR 0016
- `.claude/adr/0016-mac-client-remote-control.md`: host-authoritative full control, whole-tree re-snapshot, `shepherdd attach` dumb pipe, protocol v2. Update `CLAUDE.md` + `SPEC.md` "done" section.
- Commit: `docs: ADR 0016 — Mac client remote control`.

### Task M4.2 — Deferred cleanups (from M1)
- Remove now-redundant `paneAdded`/`paneRemoved`/`paneRenamed` deltas (whole-tree re-snapshot supersedes them) on both Swift + Kotlin; add focus/selection mirroring (broadcast on `focusPane`/`select`, or a lightweight focus-hint delta).
- Commit: `refactor(remote): drop redundant pane deltas; mirror focus`.

**M4 done-when:** ADR written; docs updated; redundant deltas gone; full Swift + Android suites green.
