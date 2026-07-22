# Ephemeral Panes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add workspace-less "ephemeral" scratch panes — summoned by ⌘⌥N into a floating in-window overlay running a shell in `~`, collapsible to a bottom-right PiP (max 5), fully attention-tracked, persisted across restart, and mirrored to remote clients as a synthetic "Temp Tabs" folder.

**Architecture:** A new pure-model `EphemeralPane` (a `Pane` + a `collapsed` flag) lives in a new `ephemeralPanes` array on `AgentStore`, owned by no workspace. The socket/attention/persistence/remote machinery — currently keyed only over `workspaces` — is extended to also resolve and aggregate ephemeral panes. A new in-window SwiftUI layer (`EphemeralOverlayView`) mounts each ephemeral pane's libghostty surface once (live PTY survives collapse/expand) and animates it between a centered overlay card and a bottom-right PiP thumbnail.

**Tech Stack:** Swift, SwiftUI, AppKit, libghostty (via `GhosttyTerminal`), XCTest (`ShepherdModelTests`), xcodegen.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-22-ephemeral-panes-design.md` — this plan implements it.
- **Ephemeral cap:** exactly `5`. The 6th summon is a no-op (beep + flash); never destroys an existing pane.
- **Starting dir:** always `NSHomeDirectory()` (`~`). No focused-pane / workspace inheritance.
- **Single overlay invariant:** at most one ephemeral pane is un-collapsed at any time (`collapsed == false`).
- **Lifecycle:** explicit close only (⌘W while overlay up, or the × button). Never auto-reaped.
- **Never persist a running agent's live state:** ephemeral panes restore all-collapsed, `.shell` state, resuming only the Claude `sessionID` (same rule as tabs).
- **`xcodegen generate` after adding/removing any source file**, run from `spike/seam1`, before building. New *source* files must also be added to `ShepherdModelTests`'s explicit `sources:` list in `project.yml` if pure-model.
- **Build/verify from `spike/seam1`:**
  ```sh
  cd spike/seam1 && xcodegen generate
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
    -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
    CLANG_MODULE_CACHE_PATH=./build/ModuleCache build
  ```
- **Run tests:**
  ```sh
  cd spike/seam1 && xcodebuild test -project Shepherd.xcodeproj -scheme Shepherd \
    -destination 'platform=macOS' -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
    CLANG_MODULE_CACHE_PATH=./build/ModuleCache -only-testing:ShepherdModelTests
  ```
- **Do NOT `killall`/relaunch Shepherd** — the user runs it as their daily terminal. UI tasks verify by compile + unit tests; runtime checks are deferred to the user.
- **Commit messages end with:** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

### Task 1: Pure model — `EphemeralPane` + invariant/aggregation helpers

**Files:**
- Create: `spike/seam1/Sources/EphemeralPane.swift`
- Modify: `spike/seam1/project.yml` (add the source to `ShepherdModelTests.sources`)
- Test: `spike/seam1/Tests/EphemeralPaneTests.swift`

**Interfaces:**
- Consumes: `Pane` (from `SplitTree.swift`), `AgentState` (`wantsAttention`, `isBusy`).
- Produces:
  - `struct EphemeralPane: Identifiable, Equatable { var pane: Pane; var collapsed: Bool; var id: String }`
  - `let ephemeralPaneCap = 5`
  - `func canSpawnEphemeral(count: Int) -> Bool`
  - `func collapsingAllExcept(_ id: String?, in panes: [EphemeralPane]) -> [EphemeralPane]`
  - `func ephemeralAttentionCount(_ panes: [EphemeralPane]) -> Int`
  - `func anyEphemeralBusy(_ panes: [EphemeralPane]) -> Bool`

- [ ] **Step 1: Write the failing test**

Create `spike/seam1/Tests/EphemeralPaneTests.swift`:

```swift
import XCTest
@testable import Shepherd

final class EphemeralPaneTests: XCTestCase {
    private func makePane(state: AgentState = .shell) -> EphemeralPane {
        var p = Pane()
        p.state = state
        return EphemeralPane(pane: p, collapsed: true)
    }

    func testCapBlocksSixth() {
        XCTAssertTrue(canSpawnEphemeral(count: 0))
        XCTAssertTrue(canSpawnEphemeral(count: 4))
        XCTAssertFalse(canSpawnEphemeral(count: 5))
        XCTAssertFalse(canSpawnEphemeral(count: 6))
    }

    func testExpandingOneCollapsesAllOthers() {
        let a = makePane(), b = makePane(), c = makePane()
        let panes = [a, b, c]
        let expanded = collapsingAllExcept(b.id, in: panes)
        XCTAssertEqual(expanded.filter { !$0.collapsed }.count, 1)
        XCTAssertFalse(expanded.first { $0.id == b.id }!.collapsed)
        XCTAssertTrue(expanded.first { $0.id == a.id }!.collapsed)
        XCTAssertTrue(expanded.first { $0.id == c.id }!.collapsed)
    }

    func testCollapsingAllExceptNilCollapsesEverything() {
        let panes = [makePane(), makePane()].map { var e = $0; e.collapsed = false; return e }
        let collapsed = collapsingAllExcept(nil, in: panes)
        XCTAssertTrue(collapsed.allSatisfy { $0.collapsed })
    }

    func testAttentionCountOnlyCountsWantsAttentionStates() {
        let panes = [
            makePane(state: .shell), makePane(state: .working), makePane(state: .idle),
            makePane(state: .blocked), makePane(state: .needsCheck), makePane(state: .error),
        ]
        XCTAssertEqual(ephemeralAttentionCount(panes), 3)   // blocked + needsCheck + error
        XCTAssertTrue(anyEphemeralBusy(panes))              // working counts as busy
    }

    func testAnyBusyFalseWhenAllShellOrIdle() {
        let panes = [makePane(state: .shell), makePane(state: .idle)]
        XCTAssertFalse(anyEphemeralBusy(panes))
        XCTAssertEqual(ephemeralAttentionCount(panes), 0)
    }
}
```

- [ ] **Step 2: Add the source to the test target, regenerate, run test to verify it fails**

In `spike/seam1/project.yml`, under `ShepherdModelTests:` → `sources:` (after `- path: Sources/PtyBroker.swift`, before `- path: Tests`), add:

```yaml
      - path: Sources/EphemeralPane.swift
```

Then:

```sh
cd spike/seam1 && xcodegen generate
xcodebuild test -project Shepherd.xcodeproj -scheme Shepherd \
  -destination 'platform=macOS' -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache -only-testing:ShepherdModelTests 2>&1 | tail -20
```
Expected: FAIL — `cannot find 'EphemeralPane' in scope` / `cannot find 'canSpawnEphemeral' in scope` (the source doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `spike/seam1/Sources/EphemeralPane.swift`:

```swift
import Foundation

/// A scratch pane that belongs to no workspace: summoned by ⌘⌥N, shown as a
/// floating overlay, tucked into a bottom-right PiP when it loses focus. Reuses
/// `Pane` for cwd / state / sessionID / displayTitle; it is always a single pane
/// (no split tree). Pure model — the store/UI live elsewhere.
struct EphemeralPane: Identifiable, Equatable {
    var pane: Pane
    var collapsed: Bool   // true = PiP thumbnail, false = the overlay
    var id: String { pane.id }
}

/// Max ephemeral panes alive at once. A summon beyond this is a no-op (spec §2).
let ephemeralPaneCap = 5

func canSpawnEphemeral(count: Int) -> Bool { count < ephemeralPaneCap }

/// Enforce the single-overlay invariant: exactly `id` un-collapsed (or none, when
/// `id` is nil). Every expand/collapse/spawn routes through this so at most one
/// overlay is ever open.
func collapsingAllExcept(_ id: String?, in panes: [EphemeralPane]) -> [EphemeralPane] {
    panes.map { var e = $0; e.collapsed = (e.id != id); return e }
}

/// Ephemeral panes wanting attention — folded into the dock badge / attention nav.
func ephemeralAttentionCount(_ panes: [EphemeralPane]) -> Int {
    panes.filter { $0.pane.state.wantsAttention }.count
}

/// Any ephemeral pane busy — folded into the sleep-guard "keep awake" trigger.
func anyEphemeralBusy(_ panes: [EphemeralPane]) -> Bool {
    panes.contains { $0.pane.state.isBusy }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```sh
cd spike/seam1 && xcodebuild test -project Shepherd.xcodeproj -scheme Shepherd \
  -destination 'platform=macOS' -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache -only-testing:ShepherdModelTests 2>&1 | tail -20
```
Expected: PASS (all `EphemeralPaneTests` green, existing tests still green).

- [ ] **Step 5: Commit**

```sh
git add spike/seam1/Sources/EphemeralPane.swift spike/seam1/Tests/EphemeralPaneTests.swift spike/seam1/project.yml
git commit -m "$(cat <<'EOF'
feat(ephemeral): pure model — EphemeralPane + invariant/aggregation helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Persistence model — `PersistedEphemeral` + snapshot/build

**Files:**
- Modify: `spike/seam1/Sources/Persistence.swift`
- Test: `spike/seam1/Tests/PersistenceTests.swift` (existing — append cases)

**Interfaces:**
- Consumes: `EphemeralPane`, `Pane`, `PersistedState`.
- Produces:
  - `struct PersistedEphemeral: Codable { var userTitle: String?; var cwd: String?; var sessionID: String? }`
  - `PersistedState.ephemeral: [PersistedEphemeral]?` (optional so old blobs decode)
  - `func snapshotEphemerals(_ panes: [EphemeralPane]) -> [PersistedEphemeral]`
  - `func buildEphemerals(from persisted: [PersistedEphemeral]?) -> [EphemeralPane]`

- [ ] **Step 1: Write the failing test**

Append to `spike/seam1/Tests/PersistenceTests.swift` (inside the existing `final class PersistenceTests`):

```swift
    func testEphemeralRoundTripRestoresCollapsedShellWithSessionAndCwd() {
        var p = Pane()
        p.cwd = "/Users/x"; p.sessionID = "sess-1"; p.userTitle = "scratch"; p.state = .working
        let live = [EphemeralPane(pane: p, collapsed: false)]

        let snap = snapshotEphemerals(live)
        XCTAssertEqual(snap.count, 1)
        XCTAssertEqual(snap[0].cwd, "/Users/x")
        XCTAssertEqual(snap[0].sessionID, "sess-1")
        XCTAssertEqual(snap[0].userTitle, "scratch")

        let rebuilt = buildEphemerals(from: snap)
        XCTAssertEqual(rebuilt.count, 1)
        XCTAssertTrue(rebuilt[0].collapsed)                 // always restored to PiP
        XCTAssertEqual(rebuilt[0].pane.state, .shell)       // live state never persists
        XCTAssertEqual(rebuilt[0].pane.cwd, "/Users/x")
        XCTAssertEqual(rebuilt[0].pane.sessionID, "sess-1")
        XCTAssertEqual(rebuilt[0].pane.userTitle, "scratch")
    }

    func testBuildEphemeralsNilYieldsEmpty() {
        XCTAssertTrue(buildEphemerals(from: nil).isEmpty)
    }

    func testPersistedStateDecodesWithoutEphemeralField() throws {
        // A pre-feature blob has no `ephemeral` key — must still decode (nil).
        let json = #"{"workspaces":[],"selectedWorkspaceIndex":0}"#
        let state = try JSONDecoder().decode(PersistedState.self, from: Data(json.utf8))
        XCTAssertNil(state.ephemeral)
    }
```

- [ ] **Step 2: Run test to verify it fails**

```sh
cd spike/seam1 && xcodebuild test -project Shepherd.xcodeproj -scheme Shepherd \
  -destination 'platform=macOS' -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache -only-testing:ShepherdModelTests/PersistenceTests 2>&1 | tail -20
```
Expected: FAIL — `cannot find 'snapshotEphemerals'` / `value of type 'PersistedState' has no member 'ephemeral'`.

- [ ] **Step 3: Write minimal implementation**

In `spike/seam1/Sources/Persistence.swift`, add the struct after `PersistedWorkspace` (line ~17):

```swift
/// On-disk ephemeral pane: cwd + sessionID + userTitle only (like a tab, live
/// state never persists). Restored all-collapsed, .shell state, fresh id.
struct PersistedEphemeral: Codable {
    var userTitle: String?
    var cwd: String?
    var sessionID: String?
}
```

Add the optional field to `PersistedState` (keep existing fields):

```swift
struct PersistedState: Codable {
    var workspaces: [PersistedWorkspace]
    var selectedWorkspaceIndex: Int
    var ephemeral: [PersistedEphemeral]?   // optional ⇒ pre-feature blobs decode as nil
}
```

Add the two free functions (near the end of the file, after `migrateLegacyTabs`):

```swift
/// Live ephemeral panes → on-disk form (cwd + sessionID + userTitle).
func snapshotEphemerals(_ panes: [EphemeralPane]) -> [PersistedEphemeral] {
    panes.map { PersistedEphemeral(userTitle: $0.pane.userTitle, cwd: $0.pane.cwd,
                                   sessionID: $0.pane.sessionID) }
}

/// Rebuild ephemeral panes from on-disk form: fresh pane ids, .shell state, all
/// collapsed (PiP). A restored sessionID resumes via `claudeResumeInput` on mount.
func buildEphemerals(from persisted: [PersistedEphemeral]?) -> [EphemeralPane] {
    (persisted ?? []).map { pe in
        var p = Pane()
        p.userTitle = pe.userTitle
        p.cwd = pe.cwd
        p.sessionID = pe.sessionID
        return EphemeralPane(pane: p, collapsed: true)
    }
}
```

> **NOTE — update the existing `snapshotState` call site is done in Task 3** (where `AgentStore.save()` passes `ephemeralPanes`). `snapshotState`'s own signature is unchanged here; Task 3 sets `state.ephemeral` after calling it. To keep `snapshotState` the single builder, instead extend it now:

Replace the `return PersistedState(...)` at the end of `snapshotState` and its signature so it accepts ephemerals:

```swift
func snapshotState(_ workspaces: [Workspace], selectedWorkspaceID: String?,
                   ephemeral: [EphemeralPane] = []) -> PersistedState {
    let selWs = workspaces.firstIndex { $0.id == selectedWorkspaceID } ?? 0
    let pws = workspaces.map { ws -> PersistedWorkspace in
        let selTab = ws.tabs.firstIndex { $0.tabID == ws.selectedTabID } ?? 0
        return PersistedWorkspace(
            userTitle: ws.userTitle,
            selectedTabIndex: selTab,
            tabs: ws.tabs.map { PersistedTab(userTitle: $0.userTitle, root: $0.root) },
            collapsed: ws.collapsed,
            defaultPath: ws.defaultPath)
    }
    return PersistedState(workspaces: pws, selectedWorkspaceIndex: selWs,
                          ephemeral: snapshotEphemerals(ephemeral))
}
```

(The default `ephemeral: [] ` keeps existing callers compiling; Task 3 passes the real array.)

- [ ] **Step 4: Run tests to verify they pass**

```sh
cd spike/seam1 && xcodebuild test -project Shepherd.xcodeproj -scheme Shepherd \
  -destination 'platform=macOS' -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache -only-testing:ShepherdModelTests 2>&1 | tail -20
```
Expected: PASS (new Persistence cases + all existing green).

- [ ] **Step 5: Commit**

```sh
git add spike/seam1/Sources/Persistence.swift spike/seam1/Tests/PersistenceTests.swift
git commit -m "$(cat <<'EOF'
feat(ephemeral): persistence — PersistedEphemeral + snapshot/build

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Store — ephemeral state, spawn/expand/collapse/close, persistence wiring

**Files:**
- Modify: `spike/seam1/Sources/AgentStore.swift`

**Interfaces:**
- Consumes: `EphemeralPane`, `canSpawnEphemeral`, `collapsingAllExcept`, `snapshotState(...ephemeral:)`, `buildEphemerals`, `postPaneClosed`, `refocusActiveTerminal`, `broadcastEphemeralTree` (defined in Task 7 — declare a stub here so this task compiles; Task 7 fills it in).
- Produces:
  - `@Published var ephemeralPanes: [EphemeralPane]`
  - `@Published private(set) var ephemeralCapFlash: Int` (bumped when a summon is blocked)
  - `var expandedEphemeralID: String?` (computed)
  - `func spawnEphemeral()`, `func expandEphemeral(_ id: String)`, `func collapseEphemeral(_ id: String)`, `func closeEphemeral(_ id: String)`

- [ ] **Step 1: Add published state + computed overlay id**

In `AgentStore` (near the other `@Published` properties — e.g. just after the `workspaces` / `selectedWorkspaceID` declarations), add:

```swift
    /// Scratch panes owned by no workspace (spec: ephemeral panes). At most one is
    /// un-collapsed (the overlay); the rest are bottom-right PiP thumbnails.
    @Published var ephemeralPanes: [EphemeralPane] = []
    /// Bumped when a summon is blocked at the cap — drives a brief PiP-row flash.
    @Published private(set) var ephemeralCapFlash: Int = 0

    /// The single open overlay's pane id (nil = all collapsed). Derived from
    /// `collapsed` so there's one source of truth.
    var expandedEphemeralID: String? { ephemeralPanes.first { !$0.collapsed }?.id }
```

- [ ] **Step 2: Add spawn/expand/collapse/close**

Add this block (e.g. after `closeFocusedPane()`, ~line 1120):

```swift
    // MARK: Ephemeral panes (workspace-less scratch panes)

    /// ⌘⌥N: open a fresh scratch shell in ~ as the overlay, collapsing any current
    /// overlay. Blocked (beep + flash) at the cap.
    func spawnEphemeral() {
        guard canSpawnEphemeral(count: ephemeralPanes.count) else {
            ephemeralCapFlash += 1
            NSSound.beep()
            return
        }
        var p = Pane()
        p.cwd = NSHomeDirectory()
        ephemeralPanes.append(EphemeralPane(pane: p, collapsed: false))
        ephemeralPanes = collapsingAllExcept(p.id, in: ephemeralPanes)   // single overlay
        save()
        broadcastEphemeralTree()
    }

    /// Click a PiP → make it the overlay (collapsing the previous one). Clears its
    /// need-to-check like any focus.
    func expandEphemeral(_ id: String) {
        guard ephemeralPanes.contains(where: { $0.id == id }) else { return }
        ephemeralPanes = collapsingAllExcept(id, in: ephemeralPanes)
        didFocus(paneID: id)
        broadcastEphemeralTree()
    }

    /// Blur / minimize / Esc → tuck the overlay into PiP. Returns focus to the
    /// underlying terminal.
    func collapseEphemeral(_ id: String) {
        guard let i = ephemeralPanes.firstIndex(where: { $0.id == id }), !ephemeralPanes[i].collapsed else { return }
        ephemeralPanes[i].collapsed = true
        refocusActiveTerminal()
        broadcastEphemeralTree()
    }

    /// ⌘W (overlay up) / × button: destroy for good — free the surface (PTY dies).
    func closeEphemeral(_ id: String) {
        guard ephemeralPanes.contains(where: { $0.id == id }) else { return }
        let wasOverlay = expandedEphemeralID == id
        ephemeralPanes.removeAll { $0.id == id }
        postPaneClosed([id])              // GhosttyTerminal frees the surface
        if wasOverlay { refocusActiveTerminal() }
        save()
        updateDockBadge()
        broadcastEphemeralTree()
    }
```

- [ ] **Step 3: Wire persistence (save + restore)**

In `save()` (line ~1246), pass the ephemerals into the snapshot:

```swift
    private func save() {
        let state = snapshotState(workspaces.filter { !$0.isRemote },
                                  selectedWorkspaceID: selectedWorkspaceID,
                                  ephemeral: ephemeralPanes)
        if let data = try? JSONEncoder().encode(state) {
            UserDefaults.standard.set(data, forKey: persistKey)
        }
    }
```

In `restore()` (line ~1255), after `workspaces = buildWorkspaces(from: state)` and before/after the selection lines, rebuild ephemerals:

```swift
        workspaces = buildWorkspaces(from: state)
        guard !workspaces.isEmpty else { return false }
        ephemeralPanes = buildEphemerals(from: state.ephemeral)   // all collapsed (PiP)
        let i = workspaces.indices.contains(state.selectedWorkspaceIndex) ? state.selectedWorkspaceIndex : 0
        selectedWorkspaceID = workspaces[i].id
        save()
        return true
```

- [ ] **Step 4: Add a temporary stub for `broadcastEphemeralTree` (Task 7 replaces it)**

So this task compiles before Task 7 exists, add near `broadcastCurrentWorkspaceTree` (line ~1310):

```swift
    /// Re-broadcast the synthetic "Temp Tabs" tree to clients. (Filled in in Task 7.)
    func broadcastEphemeralTree() { }
```

- [ ] **Step 5: Build to verify it compiles**

```sh
cd spike/seam1 && xcodegen generate && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd \
  -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -20
```
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 6: Run the model tests (no regressions)**

```sh
cd spike/seam1 && xcodebuild test -project Shepherd.xcodeproj -scheme Shepherd \
  -destination 'platform=macOS' -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache -only-testing:ShepherdModelTests 2>&1 | tail -10
```
Expected: PASS.

- [ ] **Step 7: Commit**

```sh
git add spike/seam1/Sources/AgentStore.swift
git commit -m "$(cat <<'EOF'
feat(ephemeral): store state + spawn/expand/collapse/close + persistence

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Store — ephemeral-aware feeds & attention aggregation

Extend the per-pane feeds (`apply`, `didFocus`, `cwd(forPane:)`, `pane(_:)`, `takeResumeInput`, `setCwd`, `setTitle`) and the cross-workspace aggregations (dock badge, busy, `selectNextAttention`) to resolve/include ephemeral panes. Uses a shared transition tail so the socket lifecycle logic isn't duplicated.

**Files:**
- Modify: `spike/seam1/Sources/AgentStore.swift`

**Interfaces:**
- Consumes: `ephemeralPanes`, `ephemeralAttentionCount`, `anyEphemeralBusy`, `applyEvent` (StopPolicy), `NotificationRoutingPolicy`, `expandEphemeral`.
- Produces: `private func applyTransition(...)`; ephemeral branches on the feeds; `notifyAttention(_:hidden:)` (renamed).

- [ ] **Step 1: Refactor `apply` to a shared transition tail**

Replace the whole `apply(event:detail:paneID:sid:payload:)` body (lines ~935-1014) with:

```swift
    func apply(event: String, detail: String, paneID: String, sid: String = "", payload: String? = nil) {
        if let (w, t) = locatePane(paneID, in: workspaces),
           let pane = workspaces[w].tabs[t].root.pane(paneID) {
            applyTransition(event: event, detail: detail, paneID: paneID, sid: sid, payload: payload,
                            current: pane, wsID: workspaces[w].id) { body in
                guard let (w, t) = locatePane(paneID, in: self.workspaces) else { return nil }
                _ = self.workspaces[w].tabs[t].root.updatePane(paneID, body)
                return self.workspaces[w].tabs[t].root.pane(paneID)
            }
        } else if let i = ephemeralPanes.firstIndex(where: { $0.id == paneID }) {
            applyTransition(event: event, detail: detail, paneID: paneID, sid: sid, payload: payload,
                            current: ephemeralPanes[i].pane, wsID: nil) { body in
                guard let i = self.ephemeralPanes.firstIndex(where: { $0.id == paneID }) else { return nil }
                body(&self.ephemeralPanes[i].pane)
                return self.ephemeralPanes[i].pane
            }
        } else {
            shepherdLog("event=\(event) tab=\(paneID.prefix(8)) -> NO SUCH TAB")
        }
    }

    /// The socket lifecycle tail, shared by the workspace and ephemeral feeds. `wsID`
    /// is nil for an ephemeral pane (no owning workspace ⇒ treated as "hidden" for
    /// notification routing, since it has no visible sidebar dot). `mutate` applies a
    /// change to the resolved pane and returns the updated pane.
    private func applyTransition(event: String, detail: String, paneID: String, sid: String,
                                 payload: String?, current: Pane, wsID: String?,
                                 mutate: ((inout Pane) -> Void) -> Pane?) {
        guard sessionEventAccepted(sid: sid, owner: current.sessionID) else {
            shepherdLog("event=\(event) tab=\(paneID.prefix(8)) (ignored: foreign session \(sid.prefix(8)))")
            return
        }
        let cur = current.state
        let res = applyEvent(event, detail: detail, current: cur, reason: current.reason)

        let suffix: String
        if res.heldForBackground {
            suffix = "\(cur.rawValue) (held: \(detail) background task\(detail == "1" ? "" : "s"))"
        } else if res.applied {
            suffix = "\(cur.rawValue)->\(res.state.rawValue)"
        } else {
            suffix = "\(cur.rawValue) (ignored: not mid-turn)"
        }
        shepherdLog("event=\(event)\(detail.isEmpty ? "" : "[\(detail)]") tab=\(paneID.prefix(8)) " + suffix)

        guard res.applied else { return }
        let updated = mutate {
            if res.clearTitle { $0.title = "" }
            $0.state = res.state
            $0.reason = res.reason
        }
        if res.state == .needsCheck { diffTurnPane = paneID; diffTurnTick += 1 }
        if res.state == .idle { refreshPR(forPane: paneID) }
        if event == "SessionStart", !detail.isEmpty {
            _ = mutate { $0.sessionID = detail }; save()
        } else if event == "SessionEnd" {
            _ = mutate { $0.sessionID = nil }; save()
        }
        if res.state != cur, res.state.wantsAttention, let updated {
            let routing = NotificationRoutingPolicy.decide(isAway: isAway())
            if routing.local {
                notifyAttention(updated, hidden: wsID == nil || wsID != selectedWorkspaceID)
                playAttentionSound(for: res.state)
            }
            if routing.fcm { pushWake(paneID: paneID, state: res.state) }
        }
        updateDockBadge()
        remoteServer?.broadcast(.state(paneID: paneID, state: res.state.rawValue, reason: res.reason))
        if res.state == .blocked {
            let kind: String? = {
                if event == "PreToolUse", detail == "AskUserQuestion" { return "askUserQuestion" }
                if event == "PreToolUse", detail == "ExitPlanMode" { return "plan" }
                if event == "PermissionRequest", detail != "AskUserQuestion", detail != "ExitPlanMode" { return "permission" }
                return nil
            }()
            if let kind {
                let questions: [PromptQuestion]? = (kind == "askUserQuestion")
                    ? payload.flatMap { $0.data(using: .utf8) }
                             .flatMap { try? JSONDecoder().decode([PromptQuestion].self, from: $0) }
                    : nil
                remoteServer?.broadcast(.prompt(paneID: paneID, kind: kind,
                    detail: kind == "permission" ? detail : nil, questions: questions))
            }
        }
        if wsID == nil { broadcastEphemeralTree() }   // ephemeral state changed → re-mirror
    }
```

- [ ] **Step 2: Rename `notifyAttention` to take `hidden:` and update its other caller**

Change the signature (line ~1220):

```swift
    private func notifyAttention(_ pane: Pane, hidden: Bool) {
        guard !NSApp.isActive || hidden else { return }
        ...unchanged body...
    }
```

Find the other caller (line ~1626, in the away→present catch-up replay) — currently `notifyAttention(pane, inWorkspace: workspaces[w].id)` — and change it to:

```swift
                    notifyAttention(pane, hidden: workspaces[w].id != selectedWorkspaceID)
```

- [ ] **Step 3: Make `didFocus` ephemeral-aware**

Replace `didFocus(paneID:)` (lines ~1054-1064) with:

```swift
    func didFocus(paneID: String) {
        if diffPanelOpen || codeSurface != nil { diffPanelOpen = false; codeSurface = nil }
        dismissNotifications(forPane: paneID)
        if let (w, t) = locatePane(paneID, in: workspaces) {
            guard workspaces[w].tabs[t].root.pane(paneID)?.state == .needsCheck else { return }
            _ = workspaces[w].tabs[t].root.updatePane(paneID) { $0.state = .idle }
        } else if let i = ephemeralPanes.firstIndex(where: { $0.id == paneID }) {
            guard ephemeralPanes[i].pane.state == .needsCheck else { return }
            ephemeralPanes[i].pane.state = .idle
            broadcastEphemeralTree()
        } else { return }
        updateDockBadge()
        refreshPR(forPane: paneID)
    }
```

- [ ] **Step 4: Make surface-config feeds ephemeral-aware**

`cwd(forPane:)` (line ~840) — so the ephemeral surface opens in `~`:

```swift
    func cwd(forPane paneID: String) -> String? {
        if let (w, t) = locatePane(paneID, in: workspaces) {
            return workspaces[w].tabs[t].root.pane(paneID)?.cwd
        }
        return ephemeralPanes.first { $0.id == paneID }?.pane.cwd
    }
```

`pane(_:)` (line ~845):

```swift
    func pane(_ paneID: String) -> Pane? {
        if let (w, t) = locatePane(paneID, in: workspaces) {
            return workspaces[w].tabs[t].root.pane(paneID)
        }
        return ephemeralPanes.first { $0.id == paneID }?.pane
    }
```

`takeResumeInput(forPane:)` (line ~919) — resume a restored ephemeral agent:

```swift
    func takeResumeInput(forPane paneID: String) -> String? {
        let sid: String?
        if let (w, t) = locatePane(paneID, in: workspaces) {
            sid = workspaces[w].tabs[t].root.pane(paneID)?.sessionID
        } else {
            sid = ephemeralPanes.first { $0.id == paneID }?.pane.sessionID
        }
        guard let sid, !sid.isEmpty else { return nil }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if let (w, t) = locatePane(paneID, in: self.workspaces) {
                _ = self.workspaces[w].tabs[t].root.updatePane(paneID) { $0.sessionID = nil }
            } else if let i = self.ephemeralPanes.firstIndex(where: { $0.id == paneID }) {
                self.ephemeralPanes[i].pane.sessionID = nil
            }
            self.save()
        }
        return claudeResumeInput(sessionID: sid)
    }
```

`setCwd(_:paneID:)` (line ~1035) — track ephemeral cwd for persistence:

```swift
    func setCwd(_ cwd: String, paneID: String) {
        guard !cwd.isEmpty else { return }
        if let (w, t) = locatePane(paneID, in: workspaces) {
            guard workspaces[w].tabs[t].root.pane(paneID)?.cwd != cwd else { return }
            _ = workspaces[w].tabs[t].root.updatePane(paneID) { $0.cwd = cwd }
            save()
        } else if let i = ephemeralPanes.firstIndex(where: { $0.id == paneID }) {
            guard ephemeralPanes[i].pane.cwd != cwd else { return }
            ephemeralPanes[i].pane.cwd = cwd
            save()
        }
    }
```

`setTitle(_:paneID:)` (line ~1029) — OSC title on an ephemeral pane:

```swift
    func setTitle(_ title: String, paneID: String) {
        guard !title.isEmpty else { return }
        if let (w, t) = locatePane(paneID, in: workspaces) {
            _ = workspaces[w].tabs[t].root.updatePane(paneID) { $0.title = title }
        } else if let i = ephemeralPanes.firstIndex(where: { $0.id == paneID }) {
            ephemeralPanes[i].pane.title = title
            broadcastEphemeralTree()
        }
    }
```

- [ ] **Step 5: Fold ephemerals into attention aggregation**

`attentionCount` and `hasBusyAgent` (lines ~1205-1207):

```swift
    var attentionCount: Int { totalAttentionCount(in: workspaces) + ephemeralAttentionCount(ephemeralPanes) }

    var hasBusyAgent: Bool { anyAgentBusy(in: workspaces) || anyEphemeralBusy(ephemeralPanes) }
```

`selectNextAttention()` (lines ~701-718) — include ephemerals in the ring; landing on one expands its overlay instead of `revealPane`:

```swift
    func selectNextAttention() {
        var flat: [(kind: String, ws: String?, pane: String)] = []
        for ws in workspaces { for tab in ws.tabs { for pid in tab.paneIDs { flat.append(("ws", ws.id, pid)) } } }
        for e in ephemeralPanes { flat.append(("ephemeral", nil, e.id)) }
        guard !flat.isEmpty else { return }
        let curPane = currentWorkspace.flatMap { ws in
            ws.tabs.first { $0.tabID == ws.selectedTabID }?.focusedPaneID
        }
        let start = flat.firstIndex { $0.kind == "ws" && $0.ws == selectedWorkspaceID && $0.pane == curPane } ?? -1
        for off in 1...flat.count {
            let e = flat[(start + off) % flat.count]
            let wants: Bool
            if e.kind == "ws" {
                wants = locatePane(e.pane, in: workspaces).map {
                    workspaces[$0.ws].tabs[$0.tab].root.pane(e.pane)?.state.wantsAttention == true
                } ?? false
            } else {
                wants = ephemeralPanes.first { $0.id == e.pane }?.pane.state.wantsAttention == true
            }
            guard wants else { continue }
            if e.kind == "ws" { revealPane(e.pane) } else { expandEphemeral(e.pane) }
            return
        }
        NSSound.beep()
    }
```

- [ ] **Step 6: Build + tests**

```sh
cd spike/seam1 && xcodegen generate && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd \
  -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -20
cd spike/seam1 && xcodebuild test -project Shepherd.xcodeproj -scheme Shepherd \
  -destination 'platform=macOS' -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache -only-testing:ShepherdModelTests 2>&1 | tail -10
```
Expected: `** BUILD SUCCEEDED **` and all tests PASS. (`StopPolicyTests` still green confirms the transition logic is unchanged.)

- [ ] **Step 7: Commit**

```sh
git add spike/seam1/Sources/AgentStore.swift
git commit -m "$(cat <<'EOF'
feat(ephemeral): ephemeral-aware socket feeds + attention aggregation

Route apply/didFocus/cwd/resume/setCwd/setTitle through a shared transition
tail that resolves workspace panes or ephemeral panes; fold ephemerals into
the dock badge, busy check, and ⌘⇧A ring (landing expands the overlay).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: UI — `EphemeralOverlayView` + mount in `ContentView`

The in-window layer: mounts each ephemeral pane's surface once, animating between a centered overlay card (dim click-catch backdrop, titlebar, Esc-to-collapse) and a bottom-right PiP thumbnail stack.

**Files:**
- Create: `spike/seam1/Sources/EphemeralOverlayView.swift`
- Modify: `spike/seam1/Sources/ContentView.swift`

**Interfaces:**
- Consumes: `AgentStore.ephemeralPanes`, `expandedEphemeralID`, `expandEphemeral`, `collapseEphemeral`, `closeEphemeral`, `ephemeralCapFlash`, `focusTick`; `GhosttyTerminal`, `Theme`, `AgentState.color`.
- Produces: `struct EphemeralOverlayView: View`.

- [ ] **Step 1: Create the view**

Create `spike/seam1/Sources/EphemeralOverlayView.swift`:

```swift
import SwiftUI

/// In-window layer for ephemeral (workspace-less) panes. Each pane's libghostty
/// surface is mounted once and kept mounted (live PTY survives collapse/expand);
/// its container animates between the centered overlay and a bottom-right PiP.
struct EphemeralOverlayView: View {
    @EnvironmentObject var store: AgentStore

    private let pipSize = CGSize(width: 240, height: 150)
    private let pipGap: CGFloat = 12

    var body: some View {
        GeometryReader { geo in
            ZStack {
                // Dim backdrop behind the overlay — tap to collapse it to PiP.
                if let id = store.expandedEphemeralID {
                    Color.black.opacity(0.45)
                        .ignoresSafeArea()
                        .contentShape(Rectangle())
                        .onTapGesture { store.collapseEphemeral(id) }
                        .transition(.opacity)
                }

                // One mounted surface per ephemeral pane; frame/position depends on state.
                ForEach(store.ephemeralPanes, id: \.id) { e in
                    paneContainer(e, in: geo.size)
                }
            }
            .background(escHandler)
        }
        .animation(.easeOut(duration: 0.18), value: store.expandedEphemeralID)
        .animation(.easeOut(duration: 0.18), value: store.ephemeralPanes.map(\.id))
    }

    @ViewBuilder
    private func paneContainer(_ e: EphemeralPane, in size: CGSize) -> some View {
        let isOverlay = !e.collapsed
        let frame = isOverlay ? overlayFrame(in: size) : pipFrame(for: e, in: size)

        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: isOverlay ? 12 : 8, style: .continuous)
                .fill(Theme.ground)
                .overlay(RoundedRectangle(cornerRadius: isOverlay ? 12 : 8, style: .continuous)
                    .strokeBorder(Theme.hairline, lineWidth: 1))

            VStack(spacing: 0) {
                titleBar(e, isOverlay: isOverlay)
                terminal(e, isOverlay: isOverlay)
            }
        }
        .frame(width: frame.width, height: frame.height)
        .clipShape(RoundedRectangle(cornerRadius: isOverlay ? 12 : 8, style: .continuous))
        .shadow(color: .black.opacity(isOverlay ? 0.4 : 0.25),
                radius: isOverlay ? 30 : 10, y: isOverlay ? 16 : 6)
        .position(x: frame.midX, y: frame.midY)
        // A collapsed card is a click-target that expands; the terminal underneath
        // doesn't take clicks (see terminal()).
        .contentShape(Rectangle())
        .onTapGesture { if !isOverlay { store.expandEphemeral(e.id) } }
        .modifier(FlashOnBump(trigger: store.ephemeralCapFlash, active: e.collapsed))
    }

    private func titleBar(_ e: EphemeralPane, isOverlay: Bool) -> some View {
        HStack(spacing: 8) {
            Circle().fill(e.pane.state.color).frame(width: 7, height: 7)
            Text(e.pane.displayTitle)
                .font(.ui(isOverlay ? 12.5 : 11))
                .foregroundColor(Theme.textPrimary)
                .lineLimit(1)
            Spacer(minLength: 0)
            if isOverlay {
                iconButton("minus") { store.collapseEphemeral(e.id) }
            }
            iconButton("xmark") { store.closeEphemeral(e.id) }
        }
        .padding(.horizontal, 10)
        .frame(height: isOverlay ? 30 : 24)
        .background(Theme.surface1)
    }

    private func iconButton(_ system: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: system).font(.system(size: 10, weight: .semibold))
                .foregroundColor(Theme.textSecondary)
        }
        .buttonStyle(.plain)
        .focusable(false)
    }

    @ViewBuilder
    private func terminal(_ e: EphemeralPane, isOverlay: Bool) -> some View {
        GhosttyTerminal(paneID: e.pane.paneID,
                        isVisible: true,                 // always render (live PiP preview)
                        isSelected: isOverlay,            // overlay grabs first responder
                        focusTick: store.focusTick)
            .allowsHitTesting(isOverlay)                 // PiP: clicks expand, not typed
    }

    // MARK: Layout

    private func overlayFrame(in size: CGSize) -> CGRect {
        let w = min(900, size.width * 0.65)
        let h = min(620, size.height * 0.7)
        return CGRect(x: (size.width - w) / 2, y: (size.height - h) / 2, width: w, height: h)
    }

    /// Vertical stack of PiPs anchored bottom-right, newest at the bottom.
    private func pipFrame(for e: EphemeralPane, in size: CGSize) -> CGRect {
        let collapsed = store.ephemeralPanes.filter { $0.collapsed }
        let idx = collapsed.firstIndex { $0.id == e.id } ?? 0
        let fromBottom = collapsed.count - 1 - idx
        let x = size.width - pipSize.width - pipGap
        let y = size.height - pipSize.height - pipGap - CGFloat(fromBottom) * (pipSize.height + pipGap)
        return CGRect(x: x, y: y, width: pipSize.width, height: pipSize.height)
    }

    private var escHandler: some View {
        Button("") { if let id = store.expandedEphemeralID { store.collapseEphemeral(id) } }
            .keyboardShortcut(.cancelAction)
            .opacity(0).frame(width: 0, height: 0).focusable(false)
    }
}

/// Briefly flashes a card's border when the summon cap is hit.
private struct FlashOnBump: ViewModifier {
    let trigger: Int
    let active: Bool
    @State private var on = false
    func body(content: Content) -> some View {
        content
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(Theme.blocked.opacity(on ? 0.9 : 0), lineWidth: 2))
            .onChange(of: trigger) { _ in
                guard active else { return }
                withAnimation(.easeIn(duration: 0.1)) { on = true }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                    withAnimation(.easeOut(duration: 0.2)) { on = false }
                }
            }
    }
}
```

> **Runtime note (defer to user):** PiP click-to-expand relies on `.allowsHitTesting(false)` on the collapsed terminal so the card's `onTapGesture` wins. If a PiP swallows clicks at runtime instead of expanding, the fix is to keep the terminal non-hit-testable while collapsed (already done) and, if still needed, place an explicit transparent `Color.clear.contentShape(Rectangle()).onTapGesture` layer above it. Flag this for the user's runtime check.

- [ ] **Step 2: Mount it in `ContentView`**

In `spike/seam1/Sources/ContentView.swift`, add the layer to the top-level `ZStack` — after the `HStack` that holds the sidebar+divider (line ~54, still inside the outer `ZStack(alignment: .leading)`), so it sits above the terminal and sidebar but below the modal overlays:

```swift
            HStack(spacing: 0) {
                SidebarView()
                    .frame(width: displayWidth)
                divider
            }

            EphemeralOverlayView()
                .environmentObject(store)
                .allowsHitTesting(!store.ephemeralPanes.isEmpty)
        }
```

(The existing `.overlay { … }` modals stay after this, so they still render on top.)

- [ ] **Step 3: Build**

```sh
cd spike/seam1 && xcodegen generate && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd \
  -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -20
```
Expected: `** BUILD SUCCEEDED **`. (If `Theme.ui`/`Theme.surface1`/`Theme.blocked` names differ, match the tokens used in `ShortcutCheatsheetView.swift`.)

- [ ] **Step 4: Commit**

```sh
git add spike/seam1/Sources/EphemeralOverlayView.swift spike/seam1/Sources/ContentView.swift
git commit -m "$(cat <<'EOF'
feat(ephemeral): in-window overlay + bottom-right PiP layer

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Keybinding — ⌘⌥N to summon, ⌘W precedence to close

**Files:**
- Modify: `spike/seam1/Sources/ShortcutCatalog.swift`
- Modify: `spike/seam1/Sources/ShepherdApp.swift`
- Test: `spike/seam1/Tests/ShortcutCatalogTests.swift` (existing — the catalog-integrity tests auto-cover the new id; add nothing unless a case is missing)

**Interfaces:**
- Consumes: `ShortcutID`, `ShortcutCatalog.all`, `ShortcutActions.run`, `AgentStore.spawnEphemeral`, `AgentStore.expandedEphemeralID`, `AgentStore.closeEphemeral`.
- Produces: `ShortcutID.newEphemeral`.

- [ ] **Step 1: Add the catalog entry**

In `ShortcutCatalog.swift`, add `newEphemeral` to the `ShortcutID` enum (in the `tabsPanes`-ish group, line ~20):

```swift
    case newTab, newEphemeral, closePane, splitRight, splitDown, zoomPane
```

Add its command to `ShortcutCatalog.all` (right after the `newTab` line, ~line 42):

```swift
        .init(id: .newEphemeral, title: "New Ephemeral Pane", key: "n", modifiers: [.command, .option], category: .tabsPanes, display: "⌘⌥N"),
```

- [ ] **Step 2: Wire the action + ⌘W precedence**

In `ShepherdApp.swift`, in `ShortcutActions.run(_:)` (the exhaustive switch, ~line 99), add the `newEphemeral` case and update `closePane`:

```swift
        case .newTab:        s.newTab()
        case .newEphemeral:  s.spawnEphemeral()
        case .closePane:
            if let id = s.expandedEphemeralID { s.closeEphemeral(id) }
            else if s.selectedTabIsSplit { s.closeFocusedPane() }
            else { s.closeSelected() }
```

- [ ] **Step 3: Build + tests**

```sh
cd spike/seam1 && xcodegen generate && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd \
  -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -20
cd spike/seam1 && xcodebuild test -project Shepherd.xcodeproj -scheme Shepherd \
  -destination 'platform=macOS' -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache -only-testing:ShepherdModelTests/ShortcutCatalogTests 2>&1 | tail -10
```
Expected: BUILD SUCCEEDED (the `switch` is exhaustive, so a missing case would fail the build) and `ShortcutCatalogTests` PASS (no dup glyphs/ids; full `ShortcutID` coverage — the new id is present in `all`).

- [ ] **Step 4: Commit**

```sh
git add spike/seam1/Sources/ShortcutCatalog.swift spike/seam1/Sources/ShepherdApp.swift
git commit -m "$(cat <<'EOF'
feat(ephemeral): ⌘⌥N summon + ⌘W-closes-overlay precedence

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Remote mirror — synthetic "Temp Tabs" workspace

Project ephemeral panes to clients as one `WorkspaceTree` (id `"ephemeral"`, name "Temp Tabs"), broadcast on every ephemeral change, and route client commands on that id to spawn/expand/close.

**Files:**
- Modify: `spike/seam1/Sources/AgentStore.swift`
- Modify: `spike/seam1/Sources/RemoteProtocol.swift` (reserved-id constant)

**Interfaces:**
- Consumes: `WorkspaceTree`, `RemoteTab`, `RemoteNode`, `RemotePane`, `ephemeralPanes`, `expandedEphemeralID`, `spawnEphemeral`, `expandEphemeral`, `closeEphemeral`, `isServing`, `remoteServer`.
- Produces: `let ephemeralWorkspaceID = "ephemeral"`; real `broadcastEphemeralTree()`; `ephemeralTree()`; `applyRemoteCommand` "ephemeral" cases; `workspaceTrees()` appends the synthetic tree.

- [ ] **Step 1: Add the reserved id constant**

In `RemoteProtocol.swift`, near the `WorkspaceTree` struct (line ~77), add:

```swift
/// Reserved workspace id for the synthetic "Temp Tabs" folder that mirrors
/// ephemeral panes. Real workspace ids are UUIDs, so this never collides.
let ephemeralWorkspaceID = "ephemeral"
```

- [ ] **Step 2: Build the synthetic tree + append it to `workspaceTrees()`**

In `AgentStore.swift`, add after `remoteTab(_:)` (line ~1294):

```swift
    /// The synthetic "Temp Tabs" workspace projecting ephemeral panes as single-leaf
    /// tabs, so any client shows them as ordinary tabs. nil when there are none.
    private func ephemeralTree() -> WorkspaceTree? {
        guard !ephemeralPanes.isEmpty else { return nil }
        let tabs = ephemeralPanes.map { e in
            RemoteTab(tabID: e.pane.paneID,
                      root: .leaf(RemotePane(paneID: e.pane.paneID, title: e.pane.displayTitle,
                                             cwd: e.pane.cwd, state: e.pane.state.rawValue,
                                             reason: e.pane.reason)),
                      focusedPaneID: e.pane.paneID, zoomedPaneID: nil)
        }
        return WorkspaceTree(workspaceID: ephemeralWorkspaceID, name: "Temp Tabs",
                             tabs: tabs, selectedTabID: expandedEphemeralID ?? ephemeralPanes.first?.id,
                             defaultPath: nil)
    }
```

Update `workspaceTrees()` (line ~1277) to append it:

```swift
    func workspaceTrees() -> [WorkspaceTree] {
        var trees = workspaces.enumerated().map { (i, ws) in
            WorkspaceTree(workspaceID: ws.id, name: ws.displayName(index: i),
                          tabs: ws.tabs.map(remoteTab), selectedTabID: ws.selectedTabID,
                          defaultPath: ws.defaultPath)
        }
        if let e = ephemeralTree() { trees.append(e) }
        return trees
    }
```

- [ ] **Step 3: Replace the `broadcastEphemeralTree` stub (from Task 3) with the real one**

Replace the stub body:

```swift
    /// Re-broadcast the synthetic "Temp Tabs" tree to attached clients. When the last
    /// ephemeral pane closes, tell clients to drop the folder. No-op unless serving.
    func broadcastEphemeralTree() {
        guard isServing, let server = remoteServer else { return }
        if let tree = ephemeralTree() {
            server.broadcast(.workspaceTree(tree))
        } else {
            server.broadcast(.workspaceRemoved(workspaceID: ephemeralWorkspaceID))
        }
    }
```

- [ ] **Step 4: Route client commands on the reserved id**

In `applyRemoteCommand(_:)` (line ~1320), add ephemeral handling at the top of the `switch` so the reserved id never falls into the workspace paths:

```swift
    func applyRemoteCommand(_ msg: ControlMessage) {
        switch msg {
        case .cmdNewTab(let ws) where ws == ephemeralWorkspaceID:
            spawnEphemeral(); return
        case .cmdSwitchTab(let ws, let tab) where ws == ephemeralWorkspaceID:
            expandEphemeral(tab); return
        case .cmdClosePane(let p) where ephemeralPanes.contains(where: { $0.id == p }):
            closeEphemeral(p); return
        case .cmdFocusPane(let p) where ephemeralPanes.contains(where: { $0.id == p }):
            expandEphemeral(p); return
        case .cmdNewTab(let ws):            selectWorkspace(ws); _ = newTab()
        case .cmdSplit(let p, let axis):    revealPane(p); splitFocused(axis == "column" ? .column : .row)
        case .cmdClosePane(let p):          closePane(p)
        case .cmdFocusPane(let p):          revealPane(p)
        case .cmdZoom(let p):               revealPane(p); toggleZoom()
        case .cmdRenamePane(let p, let title):
            guard let (w, t) = locatePane(p, in: workspaces) else { return }
            let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
            _ = workspaces[w].tabs[t].root.updatePane(p) { $0.userTitle = trimmed.isEmpty ? nil : trimmed }
            save()
        case .cmdReorderTab(let ws, let from, let to):
            selectWorkspace(ws)
            guard tabs.indices.contains(from) else { return }
            reorder(tabID: tabs[from].tabID, toIndex: to); commitOrder()
        case .cmdSwitchTab(let ws, let tab): selectWorkspace(ws); select(tabID: tab)
        case .cmdSetWorkspaceDirectory(let ws, let path): setWorkspaceDirectory(ws, to: path)
        case .cmdNewWorktreeTab(let ws, let name):        newWorktreeTab(inWorkspace: ws, name: name)
        default: return
        }
        broadcastCurrentWorkspaceTree()
    }
```

(The four ephemeral cases `return` early — they already broadcast the Temp Tabs tree via their store methods — so the trailing `broadcastCurrentWorkspaceTree()` only runs for the real-workspace paths, as before.)

- [ ] **Step 5: Build + tests**

```sh
cd spike/seam1 && xcodegen generate && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd \
  -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -20
cd spike/seam1 && xcodebuild test -project Shepherd.xcodeproj -scheme Shepherd \
  -destination 'platform=macOS' -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache -only-testing:ShepherdModelTests 2>&1 | tail -10
```
Expected: BUILD SUCCEEDED and all model tests PASS.

- [ ] **Step 6: Commit**

```sh
git add spike/seam1/Sources/AgentStore.swift spike/seam1/Sources/RemoteProtocol.swift
git commit -m "$(cat <<'EOF'
feat(ephemeral): mirror ephemeral panes as a synthetic "Temp Tabs" workspace

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

- [ ] **Full build + full test suite**

```sh
cd spike/seam1 && xcodegen generate && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd \
  -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -5
cd spike/seam1 && xcodebuild test -project Shepherd.xcodeproj -scheme Shepherd \
  -destination 'platform=macOS' -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache -only-testing:ShepherdModelTests 2>&1 | tail -10
```
Expected: `** BUILD SUCCEEDED **` and all `ShepherdModelTests` PASS.

- [ ] **Runtime smoke test — DEFER TO USER** (do not `killall`/relaunch). Hand off this checklist for the user to run when they next rebuild:
  1. ⌘⌥N pops a centered overlay running a shell in `~`; type a command, it works.
  2. Click outside → collapses to a bottom-right PiP thumbnail (live). Click the PiP → returns to overlay.
  3. Summon 5, then a 6th → beep + PiP-row flash, no new pane.
  4. Run `claude` in one, let it block → the PiP shows the blocked dot + a notification fires when unfocused; ⌘⇧A jumps to it (expands the overlay).
  5. ⌘W while overlay up → destroys it. Quit + relaunch → surviving ephemerals return as PiPs (and a Claude one resumes its session).
  6. With "Serve to remote devices" on, a connected client shows a "Temp Tabs" folder listing them.

## Self-Review notes

- **Spec coverage:** §1 model→T1; §2 spawn/lifecycle/cap→T3+T6; §3 UI→T5; §4 attention→T4; §5 persistence→T2+T3; §6 remote→T7; §7 keybindings→T6; §8 tests→T1+T2. All covered.
- **Type consistency:** `collapsingAllExcept`, `canSpawnEphemeral`, `ephemeralAttentionCount`, `anyEphemeralBusy` (T1) used verbatim in T3/T4. `snapshotState(...ephemeral:)`/`buildEphemerals` (T2) used in T3. `broadcastEphemeralTree` stubbed in T3, defined in T7. `notifyAttention(_:hidden:)` renamed in T4 with both callers updated. `ephemeralWorkspaceID` (T7) used in T7 only.
- **Ordering:** T3 depends on T1+T2; T4 on T3; T5 on T3; T6 on T3; T7 on T3. Linear 1→7 satisfies all deps.
