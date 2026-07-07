# Mac Client Remote Workspaces — M1 Implementation Plan (Structural Protocol + Host Commands + Android v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat `[PaneInfo]` fleet snapshot with a full per-workspace *tree* snapshot, add a client→host structural command channel, and migrate the Android client to protocol v2 — so a later native Mac client (M2) can mirror and drive host workspaces.

**Architecture:** Host-authoritative. The host projects each served workspace as a `WorkspaceTree` (SplitNode's tree shape, live-field leaves) and re-broadcasts a workspace's whole tree on any structural change. Clients send `cmd*` messages; the host applies them to its real `AgentStore` (the same mutations ⌘T/⌘D/⌘W call locally) and re-broadcasts. No dual-emit: the flat `snapshot` is removed and the in-repo Android client moves to v2 in lockstep.

**Tech Stack:** Swift (host app `spike/seam1`, pure-model + AppKit shell split), XCTest (`ShepherdModelTests`, `ShepherdRemoteTests`), Kotlin (`android/`, kotlinx.serialization JSON), JUnit.

## Global Constraints

- **Protocol version:** bump `kRemoteProtocolVersion` from `1` to `2` (`RemoteProtocol.swift`). Hard cutover — no back-compat with a v1 peer (every host/client is in-repo and ships together).
- **Wire framing unchanged:** `[u32 BE len][json]` via `FrameCodec`/`FrameDecoder` (Swift) and `WireCodec` (Kotlin). New messages are additive `ControlMessage` cases.
- **JSON case shape:** Swift synthesized `Codable` for an enum case emits `{"<caseName>":{<labels…>}}`; a single *unlabeled* associated value uses key `"_0"` (e.g. `.workspaceTree(WorkspaceTree)` → `{"workspaceTree":{"_0":{…}}}`). Kotlin `WireCodec` must mirror this exactly (see existing `paneAdded` → `_0`).
- **Optionals:** synthesized `Codable` omits nil keys (`encodeIfPresent`); Kotlin reads them with `contentOrNull` / `?`.
- **`RemoteProtocol.swift` stays pure** (no AppKit) — it is compiled into `ShepherdModelTests` and `ShepherdRemoteTests`. Tree-building helpers that need only ids/strings/SplitNode live here; anything touching `@Published`/AppKit lives in `AgentStore.swift`.
- **libghostty C API calls remain main-thread** (not exercised in M1, but the `snapshot`/command closures already hop to main via `DispatchQueue.main.sync` — keep that).
- **Commit style:** messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **After adding a Swift source file:** `cd spike/seam1 && xcodegen generate` before building. M1 adds **no new Swift files** (only edits `RemoteProtocol.swift`, `RemoteServer.swift`, `AgentStore.swift` and test files already globbed), so no `project.yml` change is needed — but new *source* files (not tests under the globbed `Tests`/`RemoteTests` dirs) would require it.

---

## File Structure

| File | Responsibility in M1 |
|---|---|
| `spike/seam1/Sources/RemoteProtocol.swift` (modify) | Add `RemotePane`/`RemoteNode`/`RemoteTab`/`WorkspaceTree` DTOs; add v2 `ControlMessage` cases (`workspaceTree`, `workspaceList`, `workspaceRemoved`, `cmd*`); remove `snapshot`/`buildSnapshot`; add pure `buildRemoteNode(_:paneProjection:)` + `RemoteCommand` decode helper; bump version. |
| `spike/seam1/Sources/RemoteServer.swift` (modify) | `admit` sends `workspaceList` + one `workspaceTree` per served workspace (was: one `snapshot`); `process` handles `cmd*` → new injected `onCommand` closure; constructor takes `workspaceTrees` + `onCommand` closures (replacing `snapshot`). |
| `spike/seam1/Sources/AgentStore.swift` (modify) | Replace `fleetSnapshot()->[PaneInfo]` with `workspaceTrees()->[WorkspaceTree]`; add `broadcastWorkspaceTree(workspaceID:)` called after every structural mutation of a served workspace; wire `onCommand` to perform the mutation on main then re-broadcast. |
| `spike/seam1/RemoteTests/RemoteProtocolTests.swift` (modify) | Pure round-trip: `WorkspaceTree` + `cmd*` encode/decode; `buildRemoteNode` from a `SplitNode`. |
| `spike/seam1/RemoteTests/RemoteServerTests.swift` (modify) | Loopback: pair → receive `workspaceList` + `workspaceTree`; send `cmdNewTab` → assert host mutated + re-broadcast tree has the new tab. |
| `android/.../protocol/ControlMessage.kt` (modify) | Add `WorkspaceTree`/`RemoteTab`/`RemoteNode`/`RemotePane` data classes + `WorkspaceTree`/`WorkspaceList`/`WorkspaceRemoved` message cases; remove `Snapshot`. |
| `android/.../protocol/WireCodec.kt` (modify) | Decode the tree cases; keep the flatten out of the codec. |
| `android/.../model/Fleet.kt` (modify) | `flatten(WorkspaceTree)->List<PaneInfo>`; `applying` handles the tree cases; remove `Snapshot`. |
| `android/.../ui/FleetViewModel.kt` (modify) | Consume tree messages (mechanical; no logic change beyond message names). |
| `android/.../protocol/WireCodecTest.kt` (modify/create) | Kotlin round-trip + flatten. |

---

## Task 1: v2 wire DTOs + ControlMessage cases (pure)

**Files:**
- Modify: `spike/seam1/Sources/RemoteProtocol.swift`
- Test: `spike/seam1/RemoteTests/RemoteProtocolTests.swift`

**Interfaces:**
- Produces (consumed by Tasks 2–4 and the Android tasks' wire contract):
  ```swift
  struct RemotePane: Codable, Equatable {
      let paneID: String; let title: String; let cwd: String?
      let state: String; let reason: String?
  }
  indirect enum RemoteNode: Codable, Equatable {
      case leaf(RemotePane)
      case split(axis: String, ratio: Double, first: RemoteNode, second: RemoteNode)
  }
  struct RemoteTab: Codable, Equatable {
      let tabID: String; let root: RemoteNode
      let focusedPaneID: String?; let zoomedPaneID: String?
  }
  struct WorkspaceTree: Codable, Equatable {
      let workspaceID: String; let name: String
      let tabs: [RemoteTab]; let selectedTabID: String?
  }
  // new ControlMessage cases (see Step 3)
  ```

- [ ] **Step 1: Write the failing test** — append to `RemoteProtocolTests.swift`:

```swift
func testWorkspaceTreeRoundTrips() throws {
    let tree = WorkspaceTree(
        workspaceID: "w1", name: "ACTIVE WORK",
        tabs: [RemoteTab(
            tabID: "t1",
            root: .split(axis: "row", ratio: 0.6,
                first: .leaf(RemotePane(paneID: "p1", title: "zsh", cwd: "/x", state: "working", reason: nil)),
                second: .leaf(RemotePane(paneID: "p2", title: "claude", cwd: "/y", state: "blocked", reason: "answer needed"))),
            focusedPaneID: "p1", zoomedPaneID: nil)],
        selectedTabID: "t1")
    let data = try FrameCodec.encode(.workspaceTree(tree))
    let decoded = try FrameDecoder().feed(data)
    XCTAssertEqual(decoded, [.workspaceTree(tree)])
}

func testStructuralCommandsRoundTrip() throws {
    let msgs: [ControlMessage] = [
        .cmdNewTab(workspaceID: "w1"),
        .cmdSplit(paneID: "p1", axis: "column"),
        .cmdClosePane(paneID: "p2"),
        .cmdFocusPane(paneID: "p1"),
        .cmdZoom(paneID: "p1"),
        .cmdRenamePane(paneID: "p1", title: "build"),
        .cmdReorderTab(workspaceID: "w1", fromIndex: 0, toIndex: 2),
        .cmdSwitchTab(workspaceID: "w1", tabID: "t1"),
        .workspaceList(ids: ["w1", "w2"]),
        .workspaceRemoved(workspaceID: "w2"),
    ]
    let dec = FrameDecoder()
    var out: [ControlMessage] = []
    for m in msgs { out += try dec.feed(try FrameCodec.encode(m)) }
    XCTAssertEqual(out, msgs)
}
```

- [ ] **Step 2: Run test to verify it fails**
  Run: `cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -destination 'platform=macOS' -only-testing:ShepherdRemoteTests/RemoteProtocolTests build test CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache -derivedDataPath ./build 2>&1 | tail -20`
  Expected: FAIL — `type 'ControlMessage' has no member 'workspaceTree'` / `cmdNewTab` etc.

- [ ] **Step 3: Add the DTOs + cases + bump version** in `RemoteProtocol.swift`.
  - Bump: `let kRemoteProtocolVersion = 2`.
  - Add the four DTO types above. `RemoteNode` needs custom `Codable` mirroring `SplitNode`'s exact key shape so Kotlin can reuse one walker:
    ```swift
    extension RemoteNode {
        enum CodingKeys: String, CodingKey { case kind, pane, axis, ratio, first, second }
        private enum Kind: String, Codable { case leaf, split }
        init(from d: Decoder) throws {
            let c = try d.container(keyedBy: CodingKeys.self)
            switch try c.decode(Kind.self, forKey: .kind) {
            case .leaf: self = .leaf(try c.decode(RemotePane.self, forKey: .pane))
            case .split: self = .split(axis: try c.decode(String.self, forKey: .axis),
                ratio: try c.decode(Double.self, forKey: .ratio),
                first: try c.decode(RemoteNode.self, forKey: .first),
                second: try c.decode(RemoteNode.self, forKey: .second))
            }
        }
        func encode(to e: Encoder) throws {
            var c = e.container(keyedBy: CodingKeys.self)
            switch self {
            case .leaf(let p): try c.encode(Kind.leaf, forKey: .kind); try c.encode(p, forKey: .pane)
            case .split(let a, let r, let f, let s):
                try c.encode(Kind.split, forKey: .kind); try c.encode(a, forKey: .axis)
                try c.encode(r, forKey: .ratio); try c.encode(f, forKey: .first); try c.encode(s, forKey: .second)
            }
        }
    }
    ```
    (`RemoteNode: Codable` is declared on the enum; the extension provides the members. `WorkspaceTree`/`RemoteTab`/`RemotePane` use synthesized `Codable`.)
  - Add to `enum ControlMessage`:
    ```swift
    case workspaceTree(WorkspaceTree)
    case workspaceList(ids: [String])
    case workspaceRemoved(workspaceID: String)
    case cmdNewTab(workspaceID: String)
    case cmdSplit(paneID: String, axis: String)
    case cmdClosePane(paneID: String)
    case cmdFocusPane(paneID: String)
    case cmdZoom(paneID: String)
    case cmdRenamePane(paneID: String, title: String)
    case cmdReorderTab(workspaceID: String, fromIndex: Int, toIndex: Int)
    case cmdSwitchTab(workspaceID: String, tabID: String)
    ```
  - **Remove** `case snapshot(panes: [PaneInfo])` and the `buildSnapshot(_:)` function. (Callers are fixed in Tasks 2–3; the build will be red until then — that is expected within this task's own test target since `RemoteProtocolTests` doesn't reference `snapshot`, but the app target won't compile. To keep Task 1 self-contained and green, **leave `PaneInfo` in place** — it's still used by the tree? No. Keep `PaneInfo` for now; it is removed in Task 5's Android-parity cleanup only if unused. Actually `RemotePane` replaces it on the wire — keep `PaneInfo` defined but unreferenced is fine and avoids a cross-file cascade in this task.)

  > Note for the implementer: removing `snapshot` breaks `RemoteServer.admit` and `AgentStore` compile. Run the **test target** build for this task (which compiles `RemoteProtocol.swift` + tests, not the full app), so Task 1 is independently green; the app target is made green in Task 3. If your build config compiles the app target transitively, defer the `snapshot` case removal to Task 3 and only *add* the new cases here.

- [ ] **Step 4: Run test to verify it passes**
  Run: same command as Step 2.
  Expected: PASS — `testWorkspaceTreeRoundTrips`, `testStructuralCommandsRoundTrip`.

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/RemoteProtocol.swift spike/seam1/RemoteTests/RemoteProtocolTests.swift
git commit -m "feat(remote): protocol v2 — WorkspaceTree DTOs + structural command cases

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Pure host-side tree builder

**Files:**
- Modify: `spike/seam1/Sources/RemoteProtocol.swift`
- Test: `spike/seam1/RemoteTests/RemoteProtocolTests.swift`

**Interfaces:**
- Consumes: `SplitNode`, `SplitAxis`, `Pane` (from `SplitTree.swift`, already in both test targets); `RemoteNode`/`RemotePane` (Task 1).
- Produces (consumed by Task 3):
  ```swift
  // Pure conversion of one tab's SplitNode tree into a wire RemoteNode, given a
  // projection that supplies each pane's LIVE title/state/reason (which Pane.Codable omits).
  func buildRemoteNode(_ node: SplitNode,
                       projection: (Pane) -> RemotePane) -> RemoteNode
  ```

- [ ] **Step 1: Write the failing test**

```swift
func testBuildRemoteNodeMirrorsSplitTree() {
    let p1 = Pane(); let p2 = Pane()
    let tree: SplitNode = .split(axis: .row, ratio: 0.5, first: .leaf(p1), second: .leaf(p2))
    let node = buildRemoteNode(tree) { p in
        RemotePane(paneID: p.paneID, title: "T-\(p.paneID.prefix(4))", cwd: nil, state: "working", reason: nil)
    }
    guard case let .split(axis, ratio, first, second) = node else { return XCTFail("expected split") }
    XCTAssertEqual(axis, "row"); XCTAssertEqual(ratio, 0.5)
    guard case let .leaf(lp) = first else { return XCTFail() }
    XCTAssertEqual(lp.paneID, p1.paneID); XCTAssertEqual(lp.state, "working")
    guard case .leaf = second else { return XCTFail() }
}
```

- [ ] **Step 2: Run test to verify it fails** — same test command, `-only-testing:ShepherdRemoteTests/RemoteProtocolTests`. Expected: FAIL — `cannot find 'buildRemoteNode' in scope`.

- [ ] **Step 3: Implement** in `RemoteProtocol.swift`:

```swift
func buildRemoteNode(_ node: SplitNode, projection: (Pane) -> RemotePane) -> RemoteNode {
    switch node {
    case .leaf(let p): return .leaf(projection(p))
    case .split(let axis, let ratio, let first, let second):
        return .split(axis: axis.rawValue, ratio: ratio,
                      first: buildRemoteNode(first, projection: projection),
                      second: buildRemoteNode(second, projection: projection))
    }
}
```

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/RemoteProtocol.swift spike/seam1/RemoteTests/RemoteProtocolTests.swift
git commit -m "feat(remote): buildRemoteNode — SplitNode tree -> wire RemoteNode

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Host emits trees (AgentStore + RemoteServer)

**Files:**
- Modify: `spike/seam1/Sources/AgentStore.swift` (replace `fleetSnapshot`; add `workspaceTrees()` + `broadcastWorkspaceTree`; update server construction closures)
- Modify: `spike/seam1/Sources/RemoteServer.swift` (`admit` sends list + trees; constructor takes `workspaceTrees` instead of `snapshot`)
- Test: `spike/seam1/RemoteTests/RemoteServerTests.swift`

**Interfaces:**
- Consumes: `buildRemoteNode` (Task 2), `WorkspaceTree`/`RemoteTab`/`RemotePane` (Task 1).
- Produces (consumed by Task 4 + M2 client):
  ```swift
  // AgentStore
  func workspaceTrees() -> [WorkspaceTree]        // one per workspace, in switcher order
  func broadcastWorkspaceTree(workspaceID: String)   // re-send ONE workspace's tree to clients
  // RemoteServer constructor: `snapshot:` param REPLACED by:
  //   workspaceTrees: @escaping () -> [WorkspaceTree]
  ```

- [ ] **Step 1: Write the failing test** — append to `RemoteServerTests.swift` (follow the existing loopback harness in this file for pairing setup):

```swift
func testAdmitSendsWorkspaceListThenTrees() throws {
    // Build a server whose workspaceTrees() returns a fixed 1-workspace/1-tab/1-pane tree.
    let tree = WorkspaceTree(workspaceID: "w1", name: "WS", tabs: [
        RemoteTab(tabID: "t1", root: .leaf(RemotePane(paneID: "p1", title: "zsh", cwd: nil, state: "shell", reason: nil)),
                  focusedPaneID: "p1", zoomedPaneID: nil)], selectedTabID: "t1")
    let server = makeLoopbackServer(workspaceTrees: { [tree] })   // test helper; see harness
    // pair + read frames (reuse existing connect/handshake helper in this file)
    let frames = try pairAndCollect(server, expecting: 3)   // accepted + workspaceList + workspaceTree
    XCTAssertTrue(frames.contains(.workspaceList(ids: ["w1"])))
    XCTAssertTrue(frames.contains(.workspaceTree(tree)))
}
```

  > The implementer must extend the file's existing loopback helpers (`makeLoopbackServer` / `pairAndCollect` — mirror whatever the current `RemoteServerTests` uses for the flat-snapshot test being replaced) to inject `workspaceTrees` and to collect N control frames after the handshake. Reuse the existing pairing/nonce helpers verbatim; do not re-invent the socket dance.

- [ ] **Step 2: Run test to verify it fails** — `-only-testing:ShepherdRemoteTests/RemoteServerTests`. Expected: FAIL — constructor has no `workspaceTrees:` param / no `.workspaceList`.

- [ ] **Step 3: Implement.**
  - `RemoteServer.swift`: rename the stored `snapshot: () -> [PaneInfo]` closure to `workspaceTrees: () -> [WorkspaceTree]` (constructor param + property). In `admit`, replace the single `encode(.snapshot(panes: snapshot()))` enqueue with:
    ```swift
    let trees = workspaceTrees()
    enqueueWrite(fd, encode(.workspaceList(ids: trees.map { $0.workspaceID })), on: state)
    for t in trees { enqueueWrite(fd, encode(.workspaceTree(t)), on: state) }
    ```
    Keep the `accepted` frame first (ordering invariant unchanged). Add a `broadcastWorkspaceTree` convenience is not needed on the server — the store calls `broadcast(.workspaceTree(...))` directly via the existing `broadcast` API.
  - `AgentStore.swift`:
    - Replace `func fleetSnapshot() -> [PaneInfo]` with:
      ```swift
      func workspaceTrees() -> [WorkspaceTree] {
          workspaces.map { ws in
              WorkspaceTree(
                  workspaceID: ws.id, name: ws.displayName,
                  tabs: ws.tabs.map { tab in
                      RemoteTab(
                          tabID: tab.tabID,
                          root: buildRemoteNode(tab.root) { p in
                              RemotePane(paneID: p.paneID, title: p.displayTitle,
                                         cwd: p.cwd, state: p.state.rawValue,
                                         reason: p.state.reason)   // use whatever the model exposes for reason; nil if none
                          },
                          focusedPaneID: tab.focusedPaneID, zoomedPaneID: tab.zoomedPaneID)
                  },
                  selectedTabID: ws.selectedTabID)
          }
      }
      ```
      (Confirm the exact accessors: `ws.displayName`, `tab.tabID`, `tab.root`, `tab.focusedPaneID`, `tab.zoomedPaneID`, `Pane.displayTitle`, `Pane.cwd`, `Pane.state`. `reason` is carried on the pane's transition — if `Pane` has no stored `reason`, pass `nil` in M1 and let the per-pane `state` delta carry reason as it does today.)
    - Add:
      ```swift
      func broadcastWorkspaceTree(workspaceID: String) {
          guard let w = workspaces.firstIndex(where: { $0.id == workspaceID }) else { return }
          let ws = workspaces[w]
          let tree = WorkspaceTree(workspaceID: ws.id, name: ws.displayName,
              tabs: ws.tabs.map { /* same mapping as workspaceTrees() — extract a private helper `remoteTab(_:)` to DRY */ },
              selectedTabID: ws.selectedTabID)
          remoteServer?.broadcast(.workspaceTree(tree))
      }
      ```
      Extract the per-tab mapping into `private func remoteTab(_ tab: Tab) -> RemoteTab` used by both `workspaceTrees()` and `broadcastWorkspaceTree`.
    - Update the `RemoteServer(...)` construction in `startRemoteServingIfEnabled`: change `snapshot: { … fleetSnapshot() … }` to `workspaceTrees: { [weak self] in guard let self else { return [] }; if Thread.isMainThread { return self.workspaceTrees() }; return DispatchQueue.main.sync { self.workspaceTrees() } }` (same main-thread hop the old `snapshot` closure used).
    - Add `broadcastWorkspaceTree(workspaceID:)` calls after each structural mutation of a served workspace: at the end of `newTab()`, `closeTabInWorkspace`, `splitFocused`, `closePane`, `focusPane` (focus is structural for zoom/focus mirroring), `zoom` toggle, `rename(tabID:)`, `reorder(tabID:)`, and tab selection (`select`). Guard with `if isServing`. Broadcast the *affected* workspace id (`selectedWorkspaceID` for current-workspace mutations, or the located workspace for pane-addressed ones via `locatePane`).

- [ ] **Step 4: Run test to verify it passes** — `-only-testing:ShepherdRemoteTests/RemoteServerTests`. Then a full build to confirm the app target compiles now that `snapshot` is gone:
  `cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -5`
  Expected: test PASS + `** BUILD SUCCEEDED **`.

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/AgentStore.swift spike/seam1/Sources/RemoteServer.swift spike/seam1/RemoteTests/RemoteServerTests.swift
git commit -m "feat(remote): host emits per-workspace trees; drop flat snapshot

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Host applies client structural commands

**Files:**
- Modify: `spike/seam1/Sources/RemoteServer.swift` (`process` handles `cmd*` → `onCommand`)
- Modify: `spike/seam1/Sources/AgentStore.swift` (wire `onCommand` → perform mutation on main → re-broadcast)
- Test: `spike/seam1/RemoteTests/RemoteServerTests.swift`

**Interfaces:**
- Consumes: `broadcastWorkspaceTree` (Task 3), the `cmd*` cases (Task 1), the store's existing mutations (`newTab`, `splitFocused`, `closePane`, `focusPane`, `rename`, `reorder`, `select`, zoom toggle).
- Produces:
  ```swift
  // RemoteServer constructor gains:
  //   onCommand: @escaping (ControlMessage) -> Void   // invoked for a paired cmd* frame
  ```

- [ ] **Step 1: Write the failing test** — append to `RemoteServerTests.swift`:

```swift
func testCmdNewTabInvokesHandlerAndRebroadcasts() throws {
    var received: [ControlMessage] = []
    let server = makeLoopbackServer(workspaceTrees: { [] }, onCommand: { received.append($0) })
    let client = try pairClient(server)                // reuse existing helper
    try client.send(.cmdNewTab(workspaceID: "w1"))
    try waitUntil { received.contains(.cmdNewTab(workspaceID: "w1")) }   // existing poll helper
    XCTAssertEqual(received, [.cmdNewTab(workspaceID: "w1")])
}

func testUnpairedCmdIsIgnored() throws {
    var received: [ControlMessage] = []
    let server = makeLoopbackServer(workspaceTrees: { [] }, onCommand: { received.append($0) })
    let raw = try connectRaw(server)                   // connect WITHOUT handshake
    try raw.send(.cmdClosePane(paneID: "p1"))
    Thread.sleep(forTimeInterval: 0.2)
    XCTAssertTrue(received.isEmpty)                     // cmd* only honored while .paired
}
```

- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL — no `onCommand:` param.

- [ ] **Step 3: Implement.**
  - `RemoteServer.swift`: add stored `onCommand: (ControlMessage) -> Void` (constructor param, default `{ _ in }`). In `process`, add a case group **guarded by `phase == .paired`** that forwards command frames:
    ```swift
    case .cmdNewTab, .cmdSplit, .cmdClosePane, .cmdFocusPane, .cmdZoom,
         .cmdRenamePane, .cmdReorderTab, .cmdSwitchTab:
        guard phase == .paired else { break }
        onCommand(m)
    ```
    (Place before `default`. Commands are host-inbound only; the host never sends them.)
  - `AgentStore.swift`: in `startRemoteServingIfEnabled`, pass:
    ```swift
    onCommand: { [weak self] msg in
        DispatchQueue.main.async { self?.applyRemoteCommand(msg) }   // main: mutations touch @Published + libghostty
    }
    ```
    Add:
    ```swift
    private func applyRemoteCommand(_ msg: ControlMessage) {
        switch msg {
        case .cmdNewTab(let ws):        selectWorkspace(ws); _ = newTab()
        case .cmdSplit(let p, let ax):  focusPane(p); splitFocused(ax == "column" ? .column : .row)
        case .cmdClosePane(let p):      closePane(p)
        case .cmdFocusPane(let p):      focusPane(p)
        case .cmdZoom(let p):           focusPane(p); toggleZoom()        // use the store's existing zoom entry point
        case .cmdRenamePane(let p, let t): /* rename the pane's userTitle via the pane path used by inline rename */ break
        case .cmdReorderTab(let ws, let f, let t): selectWorkspace(ws); if let id = tabs[safe: f]?.tabID { reorder(tabID: id, toIndex: t); commitOrder() }
        case .cmdSwitchTab(let ws, let tab): selectWorkspace(ws); select(tabID: tab)
        default: break
        }
        broadcastWorkspaceTree(workspaceID: locateWorkspaceID(for: msg) ?? selectedWorkspaceID ?? "")
    }
    ```
    (Fill the `cmdRenamePane` and `cmdSplit`-focus details against the real store API — `splitFocused`/`closePane`/`focusPane` already exist per `AgentStore.swift`. Confirm the exact zoom entry point name; the header calls it "toggle zoom of the focused pane." `locateWorkspaceID(for:)` is a small helper: for pane-addressed commands, `locatePane(paneID, in: workspaces)` → workspace id; for workspace-addressed ones, the carried `workspaceID`.)

- [ ] **Step 4: Run test to verify it passes** — `-only-testing:ShepherdRemoteTests/RemoteServerTests` + full app build. Expected: PASS + `BUILD SUCCEEDED`.

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/RemoteServer.swift spike/seam1/Sources/AgentStore.swift spike/seam1/RemoteTests/RemoteServerTests.swift
git commit -m "feat(remote): host applies client structural commands, re-broadcasts tree

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Android v2 migration (decode trees, flatten to fleet list)

**Files:**
- Modify: `android/app/src/main/java/com/eshaan/shepherd/protocol/ControlMessage.kt`
- Modify: `android/app/src/main/java/com/eshaan/shepherd/protocol/WireCodec.kt`
- Modify: `android/app/src/main/java/com/eshaan/shepherd/model/Fleet.kt`
- Modify: `android/app/src/main/java/com/eshaan/shepherd/ui/FleetViewModel.kt`
- Test: `android/app/src/test/java/com/eshaan/shepherd/protocol/WireCodecTest.kt`

**Interfaces:**
- Consumes: the v2 JSON shapes from Tasks 1–3 (`{"workspaceTree":{"_0":{…}}}`, `{"workspaceList":{"ids":[…]}}`, `{"workspaceRemoved":{"workspaceID":…}}`).
- Produces: `Fleet` still exposes `panes: List<PaneInfo>` (unchanged downstream contract) — the tree is flattened into it.

- [ ] **Step 1: Write the failing test** — in `WireCodecTest.kt`:

```kotlin
@Test fun decodesWorkspaceTreeAndFlattens() {
    // Mirror the Swift wire shape exactly.
    val json = """{"workspaceTree":{"_0":{"workspaceID":"w1","name":"WS","selectedTabID":"t1",
      "tabs":[{"tabID":"t1","focusedPaneID":"p1",
        "root":{"kind":"split","axis":"row","ratio":0.5,
          "first":{"kind":"leaf","pane":{"paneID":"p1","title":"zsh","state":"working"}},
          "second":{"kind":"leaf","pane":{"paneID":"p2","title":"claude","state":"blocked","reason":"answer needed"}}}}]}}}"""
    val frame = frameOf(json)   // [u32 BE len][json] helper
    val msgs = WireCodec.Decoder().feed(frame)
    val tree = (msgs.single() as ControlMessage.WorkspaceTree).tree
    val panes = Fleet.flatten(tree)
    assertEquals(listOf("p1", "p2"), panes.map { it.paneId })
    assertEquals("WS", panes[0].workspace)
    assertEquals("blocked", panes[1].state)
    assertEquals("answer needed", panes[1].reason)
}
```

- [ ] **Step 2: Run test to verify it fails**
  Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "com.eshaan.shepherd.protocol.WireCodecTest" 2>&1 | tail -20`
  Expected: FAIL — unresolved `ControlMessage.WorkspaceTree` / `Fleet.flatten`.

- [ ] **Step 3: Implement.**
  - `ControlMessage.kt`: remove `data class Snapshot(...)`; add:
    ```kotlin
    data class RemotePane(val paneId: String, val title: String, val cwd: String?, val state: String, val reason: String?)
    sealed interface RemoteNode {
        data class Leaf(val pane: RemotePane) : RemoteNode
        data class Split(val axis: String, val ratio: Double, val first: RemoteNode, val second: RemoteNode) : RemoteNode
    }
    data class RemoteTab(val tabId: String, val root: RemoteNode, val focusedPaneId: String?, val zoomedPaneId: String?)
    data class WorkspaceTree(val workspaceId: String, val name: String, val tabs: List<RemoteTab>, val selectedTabId: String?)
    // message cases:
    data class WorkspaceTreeMsg(val tree: WorkspaceTree) : ControlMessage   // name to avoid clash with the DTO
    data class WorkspaceList(val ids: List<String>) : ControlMessage
    data class WorkspaceRemoved(val workspaceId: String) : ControlMessage
    ```
    (Adjust the test's cast to `ControlMessage.WorkspaceTreeMsg` accordingly, or name the message `WorkspaceTree` and the DTO `WorkspaceTreeDto` — pick one and keep it consistent across the three files + test.)
  - `WireCodec.kt`: bump the `Hello` default `protocolVersion` sent by the client to `2` (find where `Hello(...)` is constructed — likely `PairingController`/`RemoteConnection`; set `protocolVersion = 2`). Remove the `"snapshot"` encode+parse arms. Add parse arms:
    ```kotlin
    "workspaceTree" -> ControlMessage.WorkspaceTreeMsg(parseTree(b.getValue("_0").jsonObject))
    "workspaceList" -> ControlMessage.WorkspaceList(b.getValue("ids").jsonArray.map { it.jsonPrimitive.content })
    "workspaceRemoved" -> ControlMessage.WorkspaceRemoved(b.getValue("workspaceID").jsonPrimitive.content)
    ```
    with helpers:
    ```kotlin
    private fun parseTree(o: JsonObject) = ControlMessage.WorkspaceTree(
        workspaceId = o.getValue("workspaceID").jsonPrimitive.content,
        name = o.getValue("name").jsonPrimitive.content,
        selectedTabId = o["selectedTabID"]?.jsonPrimitive?.contentOrNull,
        tabs = o.getValue("tabs").jsonArray.map { te ->
            val t = te.jsonObject
            ControlMessage.RemoteTab(
                tabId = t.getValue("tabID").jsonPrimitive.content,
                root = parseNode(t.getValue("root").jsonObject),
                focusedPaneId = t["focusedPaneID"]?.jsonPrimitive?.contentOrNull,
                zoomedPaneId = t["zoomedPaneID"]?.jsonPrimitive?.contentOrNull) })
    private fun parseNode(o: JsonObject): ControlMessage.RemoteNode =
        when (o.getValue("kind").jsonPrimitive.content) {
            "leaf" -> ControlMessage.RemoteNode.Leaf(parseRemotePane(o.getValue("pane").jsonObject))
            else -> ControlMessage.RemoteNode.Split(
                o.getValue("axis").jsonPrimitive.content, o.getValue("ratio").jsonPrimitive.double,
                parseNode(o.getValue("first").jsonObject), parseNode(o.getValue("second").jsonObject)) }
    private fun parseRemotePane(o: JsonObject) = ControlMessage.RemotePane(
        paneId = o.getValue("paneID").jsonPrimitive.content, title = o.getValue("title").jsonPrimitive.content,
        cwd = o["cwd"]?.jsonPrimitive?.contentOrNull, state = o.getValue("state").jsonPrimitive.content,
        reason = o["reason"]?.jsonPrimitive?.contentOrNull)
    ```
    (Encoding arms for the tree cases are not needed — the client never sends them. `WorkspaceRemoved`/`WorkspaceList` are inbound-only too.)
  - `Fleet.kt`: remove the `Snapshot` arm; add:
    ```kotlin
    companion object {
        fun flatten(tree: ControlMessage.WorkspaceTree): List<PaneInfo> {
            val out = ArrayList<PaneInfo>()
            fun walk(n: ControlMessage.RemoteNode) { when (n) {
                is ControlMessage.RemoteNode.Leaf -> out.add(PaneInfo(n.pane.paneId, n.pane.title, tree.name, n.pane.state, n.pane.reason))
                is ControlMessage.RemoteNode.Split -> { walk(n.first); walk(n.second) } } }
            tree.tabs.forEach { walk(it.root) }
            return out
        }
    }
    ```
    and in `applying`:
    ```kotlin
    is ControlMessage.WorkspaceTreeMsg -> {   // replace this workspace's panes, keep others
        val others = panes.filterNot { it.workspace == msg.tree.name }
        Fleet(others + flatten(msg.tree))
    }
    is ControlMessage.WorkspaceRemoved -> this   // ids are host-scoped; the flat view drops panes via the next tree
    is ControlMessage.WorkspaceList -> this
    ```
    (M1 keeps the Android fleet keyed by workspace *name*, matching the current `byWorkspace()` grouping. Per-workspace replacement on each tree is correct for a flat list. Remove the now-dead `Snapshot` branch.)
  - `FleetViewModel.kt`: wherever it matched `ControlMessage.Snapshot`, match the new tree cases (mechanical). If it only calls `fleet.applying(msg)`, no change beyond removing any `Snapshot`-specific handling.

- [ ] **Step 4: Run test to verify it passes**
  Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "com.eshaan.shepherd.protocol.WireCodecTest" 2>&1 | tail -20`
  Expected: PASS. Then a full compile: `./gradlew :app:compileDebugKotlin 2>&1 | tail -5` → no unresolved `Snapshot` references.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/eshaan/shepherd/protocol/ControlMessage.kt \
        android/app/src/main/java/com/eshaan/shepherd/protocol/WireCodec.kt \
        android/app/src/main/java/com/eshaan/shepherd/model/Fleet.kt \
        android/app/src/main/java/com/eshaan/shepherd/ui/FleetViewModel.kt \
        android/app/src/test/java/com/eshaan/shepherd/protocol/WireCodecTest.kt
git commit -m "feat(android): protocol v2 — decode WorkspaceTree, flatten to fleet list

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## M1 Done-When

- `ShepherdRemoteTests` green: tree + command codec round-trip, `buildRemoteNode`, admit sends list+trees, host applies `cmdNewTab`, unpaired `cmd*` ignored.
- App target builds (`BUILD SUCCEEDED`) with `snapshot` removed.
- Android `WireCodecTest` green; `:app:compileDebugKotlin` clean; the fleet view still populates (now from trees) against a v2 host — verified manually on device or via the loopback harness.
- Manual smoke (optional, needs the pre-existing serving toggle): `defaults write com.shepherd.Shepherd shepherd.remote.serving -bool YES`, launch, pair the Android app, confirm the fleet list still shows all panes grouped by workspace.

---

## Follow-on plans (written after M1 lands, against M1's final signatures)

- **M2 plan** — `RemoteClient.swift`, `RemoteRef` on `Pane`, `shepherdd attach` helper subcommand, `GhosttyTerminal` remote branch, mirror workspaces built from `workspaceTree`; loopback E2E (pair → mirror → type → echo → split → close).
- **M3 plan** — Tailscale endpoint + `KnownHost`/`AccessEndpoint`, backoff reconnect, `reconnecting`/`dead` overlays, "Add remote host" UI in `WorkspaceSwitcher`, `shepherd.workspaces.v2` pointer persistence + migration.
- **M4 plan** — ADR `0016-mac-client-remote-control.md`, polish.
