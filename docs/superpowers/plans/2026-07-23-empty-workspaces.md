# Empty Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a workspace hold zero tabs and persist as an empty (not deleted) container, so closing the last tab no longer spawns a stray replacement.

**Architecture:** Remove the `reseedIfEmpty()` reflex from the two close/move paths and set the workspace's `selectedTabID = nil` when it empties. Fix persistence so an empty workspace survives relaunch (today it's silently dropped). Add a content-area empty state and make the sidebar's empty folder selectable.

**Tech Stack:** Swift / SwiftUI / AppKit, xcodegen, XCTest (`ShepherdModelTests`).

## Global Constraints

- Working dir for all build/test commands: `/Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1`.
- Run `xcodegen generate` after adding/removing ANY source file, before building.
- Pure-model logic lives in files compiled by the `ShepherdModelTests` target; AppKit/SwiftUI files are NOT in that target — verify those by compile + user runtime, never by unit test.
- Build: `xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build`
- Test: `xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -destination 'platform=macOS' -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache test` (the `Shepherd` scheme runs `ShepherdModelTests` in its test action).
- Do NOT `killall`/relaunch Shepherd — it's the user's live daily terminal. Verify by compile + tests; defer runtime checks to the user.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- `SplitAxis` vocab, `store.tabs` = current-workspace view only — resolve panes across all workspaces via `locatePane`.

---

### Task 1: Persistence preserves empty workspaces

The store must round-trip a workspace with zero tabs. Today `buildWorkspaces` drops it. Pure-model, TDD.

**Files:**
- Modify: `spike/seam1/Sources/Persistence.swift:73-91` (`buildWorkspaces`)
- Test: `spike/seam1/Tests/PersistenceTests.swift`

**Interfaces:**
- Consumes: `snapshotState(_:selectedWorkspaceID:ephemeral:)`, `buildWorkspaces(from:)`, `Workspace(tabs:)`, `PersistedState`.
- Produces: `buildWorkspaces` now returns empty workspaces (with `tabs == []`, `selectedTabID == nil`) instead of dropping them.

- [ ] **Step 1: Write the failing tests**

Add to `spike/seam1/Tests/PersistenceTests.swift` (inside the class):

```swift
    func testEmptyWorkspaceSurvivesRoundTrip() throws {
        let empty = Workspace(userTitle: "cleared", tabs: [])
        let data = try JSONEncoder().encode(snapshotState([empty], selectedWorkspaceID: empty.id))
        let rebuilt = buildWorkspaces(from: try JSONDecoder().decode(PersistedState.self, from: data))
        XCTAssertEqual(rebuilt.count, 1)                 // NOT dropped
        XCTAssertTrue(rebuilt[0].tabs.isEmpty)
        XCTAssertNil(rebuilt[0].selectedTabID)
        XCTAssertEqual(rebuilt[0].userTitle, "cleared")
    }

    func testMixedEmptyAndNonEmptyWorkspacesRoundTrip() throws {
        let empty = Workspace(userTitle: "empty", tabs: [])
        let full = Workspace(userTitle: "full", tabs: [tab("t")])
        let data = try JSONEncoder().encode(snapshotState([empty, full], selectedWorkspaceID: full.id))
        let rebuilt = buildWorkspaces(from: try JSONDecoder().decode(PersistedState.self, from: data))
        XCTAssertEqual(rebuilt.map(\.userTitle), ["empty", "full"])
        XCTAssertTrue(rebuilt[0].tabs.isEmpty)
        XCTAssertEqual(rebuilt[1].tabs.count, 1)
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -destination 'platform=macOS' -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache test 2>&1 | grep -E "testEmptyWorkspace|testMixedEmpty|failed"`
Expected: FAIL — `testEmptyWorkspaceSurvivesRoundTrip` fails at `XCTAssertEqual(rebuilt.count, 1)` (got 0, the empty workspace was dropped).

- [ ] **Step 3: Remove the empty-drop guard**

In `spike/seam1/Sources/Persistence.swift`, `buildWorkspaces`, delete the guard so an empty workspace is built too:

```swift
func buildWorkspaces(from state: PersistedState) -> [Workspace] {
    state.workspaces.compactMap { pw -> Workspace? in
        let tabs: [Tab] = pw.tabs.compactMap { pt in
            guard let first = pt.root.firstLeafID else { return nil }
            var tab = Tab(pane: Pane())
            tab.userTitle = pt.userTitle
            tab.root = pt.root
            tab.focusedPaneID = first
            return tab
        }
        let selID = tabs.indices.contains(pw.selectedTabIndex)
            ? tabs[pw.selectedTabIndex].tabID
            : tabs.first?.tabID
        return Workspace(userTitle: pw.userTitle, tabs: tabs, selectedTabID: selID,
                         collapsed: pw.collapsed ?? false, defaultPath: pw.defaultPath,
                         worktreeHook: pw.worktreeHook)
    }
}
```

(The only change is deleting the `guard !tabs.isEmpty else { return nil }` line that sat above the `selID` line. For empty `tabs`, `tabs.first?.tabID` is `nil`, so `selectedTabID` resolves to nil.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -destination 'platform=macOS' -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache test 2>&1 | grep -E "testEmptyWorkspace|testMixedEmpty|TEST SUCCEEDED|failed"`
Expected: PASS — both new tests pass, `** TEST SUCCEEDED **`.

- [ ] **Step 5: Commit**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd
git add spike/seam1/Sources/Persistence.swift spike/seam1/Tests/PersistenceTests.swift
git commit -m "fix(persistence): preserve empty workspaces on restore

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Stop reseeding on close/move

Closing the last tab (or dragging it out) must leave the workspace empty instead of reseeding. Delete `reseedIfEmpty()` and update both callers. AppKit-bound — verified by compile.

**Files:**
- Modify: `spike/seam1/Sources/Workspace.swift:44-53` (delete `reseedIfEmpty()`)
- Modify: `spike/seam1/Sources/AgentStore.swift:725-742` (`closeTabInWorkspace`)
- Modify: `spike/seam1/Sources/AgentStore.swift:900-929` (`moveTab`)

**Interfaces:**
- Consumes: `Workspace.tabs`, `Workspace.selectedTabID`, `refocusActiveTerminal()`.
- Produces: after this task, `Workspace` has no `reseedIfEmpty()`; both paths set `selectedTabID = nil` when the workspace empties.

- [ ] **Step 1: Delete `reseedIfEmpty()` from `Workspace.swift`**

Remove this entire block (lines 44-53), including its doc comment:

```swift
    /// Drop in a fresh tab if the workspace was emptied — a workspace is never empty.
    /// The reseeded tab opens in the workspace's default dir, like any new tab here.
    mutating func reseedIfEmpty() {
        guard tabs.isEmpty else { return }
        var pane = Pane()
        if let p = defaultPath, !p.isEmpty { pane.cwd = (p as NSString).expandingTildeInPath }
        let t = Tab(pane: pane)
        tabs = [t]
        selectedTabID = t.tabID
    }
```

- [ ] **Step 2: Update `closeTabInWorkspace`**

In `spike/seam1/Sources/AgentStore.swift`, replace the method's doc comment + empty branch:

```swift
    /// closeTab targeting a specific workspace. Closing the last tab leaves the
    /// workspace EMPTY (not deleted) — it persists and shows the empty state.
    private func closeTabInWorkspace(_ w: Int, tabID: String) {
        let wasSelected = workspaces[w].selectedTabID == tabID
        let closingPaneIDs = workspaces[w].tabs.first { $0.tabID == tabID }?.root.panes.map(\.paneID) ?? []
        workspaces[w].tabs.removeAll { $0.tabID == tabID }
        if workspaces[w].tabs.isEmpty {
            workspaces[w].selectedTabID = nil
            DispatchQueue.main.async { [weak self] in self?.refocusActiveTerminal() }
        } else if wasSelected {
            workspaces[w].selectedTabID = workspaces[w].tabs.last?.tabID
            DispatchQueue.main.async { [weak self] in self?.refocusActiveTerminal() }
        }
        save()
        updateDockBadge()
        postPaneClosed(closingPaneIDs)
        broadcastWorkspaceTree(workspaceID: workspaces[w].id)
    }
```

- [ ] **Step 3: Update `moveTab` source cleanup**

In `moveTab`, replace the source-empty branch and fix the doc comment's last sentence:

```swift
    /// Move a tab (with its whole pane tree + live agents) into another folder,
    /// appended, selected, and made active. No-op across remote/mirror workspaces
    /// (host-authoritative) or into its own folder. The source is left empty if drained.
    func moveTab(_ tabID: String, toWorkspace destID: String) {
        guard let srcW = workspaces.firstIndex(where: { ws in ws.tabs.contains { $0.tabID == tabID } }),
              let destW = workspaces.firstIndex(where: { $0.id == destID }),
              srcW != destW,
              !workspaces[srcW].isRemote, !workspaces[destW].isRemote,
              let ti = workspaces[srcW].tabs.firstIndex(where: { $0.tabID == tabID }) else { return }

        let srcID = workspaces[srcW].id
        let wasSelected = workspaces[srcW].selectedTabID == tabID
        let tab = workspaces[srcW].tabs.remove(at: ti)
        if workspaces[srcW].tabs.isEmpty {
            workspaces[srcW].selectedTabID = nil
        } else if wasSelected {
            workspaces[srcW].selectedTabID = workspaces[srcW].tabs.last?.tabID
        }
```

(Only the `if workspaces[srcW].tabs.isEmpty { ... }` body changes from `reseedIfEmpty()` to `selectedTabID = nil`, plus the doc comment's final sentence. Leave the rest of `moveTab` — the append/select/broadcast tail — untouched.)

- [ ] **Step 4: Build to verify it compiles**

Run: `cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -3`
Expected: `** BUILD SUCCEEDED **` and no `reseedIfEmpty` reference errors.

- [ ] **Step 5: Run the model tests (guard against regressions)**

Run: `xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -destination 'platform=macOS' -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache test 2>&1 | tail -3`
Expected: `** TEST SUCCEEDED **`.

- [ ] **Step 6: Commit**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd
git add spike/seam1/Sources/Workspace.swift spike/seam1/Sources/AgentStore.swift
git commit -m "feat(workspaces): leave a workspace empty instead of reseeding a tab

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Content-area empty state

When the selected workspace has no visible tab, show a centered hint + New Tab / New Worktree Tab buttons. New SwiftUI file; verified by compile + user runtime.

**Files:**
- Create: `spike/seam1/Sources/WorkspaceEmptyView.swift`
- Modify: `spike/seam1/Sources/ContentView.swift:115-135` (`terminalArea`)

Note: the `Shepherd` app target uses a `- path: Sources` directory glob, so a new file under `Sources/` is picked up by `xcodegen generate` with NO `project.yml` edit. (The explicit `sources:` list requirement in CLAUDE.md applies only to the `ShepherdModelTests` target.)

**Interfaces:**
- Consumes: `AgentStore.selectedTab`, `AgentStore.currentWorkspace` (id + `defaultPath` + `isRemote`), `store.newTab()`, `store.newWorktreeTab(inWorkspace:name:)`, `Git.isWorkTree(_:)`, `Theme`, `store.selectWorkspace(_:)`.
- Produces: `WorkspaceEmptyView` (an `EnvironmentObject`-driven view, no init args).

- [ ] **Step 1: Create `WorkspaceEmptyView.swift`**

```swift
import SwiftUI

/// Shown in the content area when the selected workspace has no tabs. A workspace
/// can now be empty (closing its last tab no longer reseeds one), so this is the
/// resting state, not an error. New Tab / New Worktree Tab open work when wanted.
struct WorkspaceEmptyView: View {
    @EnvironmentObject var store: AgentStore
    @State private var isGitRepo = false

    private var ws: Workspace? { store.currentWorkspace }

    // Mirror the sidebar's rule: local ⇒ default dir is a work tree; mirror ⇒ wired defaultPath.
    private var worktreeEnabled: Bool {
        guard let ws else { return false }
        return ws.isRemote ? (ws.defaultPath?.isEmpty == false) : isGitRepo
    }

    var body: some View {
        VStack(spacing: 14) {
            Text("No tabs")
                .font(.ui(15, .medium))
                .foregroundStyle(Theme.textPrimary)
            Text("⌘T to open one")
                .font(.ui(12, .regular))
                .foregroundStyle(Theme.textDim)
            HStack(spacing: 10) {
                Button("New Tab") { store.newTab() }
                    .buttonStyle(.borderedProminent)
                if worktreeEnabled {
                    Button("New Worktree Tab…") { promptNewWorktree() }
                        .buttonStyle(.bordered)
                }
            }
            .focusable(false)
            .padding(.top, 4)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear(perform: refreshGitStatus)
        .onChange(of: store.selectedWorkspaceID) { _ in refreshGitStatus() }
    }

    private func refreshGitStatus() {
        guard let ws, !ws.isRemote, let p = ws.defaultPath, !p.isEmpty else { isGitRepo = false; return }
        let dir = (p as NSString).expandingTildeInPath
        DispatchQueue.global(qos: .userInitiated).async {
            let ok = Git.isWorkTree(dir)
            DispatchQueue.main.async { isGitRepo = ok }
        }
    }

    private func promptNewWorktree() {
        guard let ws else { return }
        let alert = NSAlert()
        alert.messageText = "New worktree tab"
        alert.informativeText = "Branch name for the new worktree:"
        alert.addButton(withTitle: "Create")
        alert.addButton(withTitle: "Cancel")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 240, height: 24))
        alert.accessoryView = field
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let name = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        store.newWorktreeTab(inWorkspace: ws.id, name: name)
    }
}
```

- [ ] **Step 2: Wire it into `terminalArea`**

In `spike/seam1/Sources/ContentView.swift`, add an overlay to the `ZStack` in `terminalArea` (after the `ForEach`, before the closing brace of the `ZStack`):

```swift
    private var terminalArea: some View {
        ZStack {
            Theme.ground
            ForEach(store.allMountedTabs, id: \.tab.tabID) { entry in
                SplitContainer(node: entry.tab.root,
                               tabID: entry.tab.tabID,
                               isTabSelected: entry.visible,
                               focusTick: store.focusTick,
                               zoomedPaneID: entry.tab.zoomedPaneID)
                    .opacity(entry.visible ? 1 : 0)
                    .allowsHitTesting(entry.visible)
            }
            if store.selectedTab == nil {
                WorkspaceEmptyView()
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(.easeInOut(duration: 0.22), value: store.selectedWorkspaceID)
        .background(GeometryReader { geo in
            Color.clear
                .onAppear { store.lastContentSize = geo.size }
                .onChange(of: geo.size) { store.lastContentSize = $0 }
        })
    }
```

(`store.selectedTab == nil` is true exactly when the current workspace has no selected tab, i.e. it's empty. `WorkspaceEmptyView` reads `store` from the environment — `ContentView` already injects it.)

- [ ] **Step 3: Regenerate the project and build**

Run: `cd spike/seam1 && xcodegen generate && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -3`
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 4: Commit**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd
git add spike/seam1/Sources/WorkspaceEmptyView.swift spike/seam1/Sources/ContentView.swift
git commit -m "feat(workspaces): content-area empty state with New Tab buttons

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Sidebar — activate empty folder + placeholder row

An empty folder has no tab to click, so it can't be made active today. Fix the header tap to also select the workspace when empty, and show a faint `No tabs` row when expanded. AppKit-bound — verified by compile + user runtime.

**Files:**
- Modify: `spike/seam1/Sources/SidebarView.swift:105-118` (`folderSection` tab rows)
- Modify: `spike/seam1/Sources/SidebarView.swift:238` (`WorkspaceFolderHeader` `onTapGesture`)

**Interfaces:**
- Consumes: `store.toggleWorkspaceCollapsed(_:)`, `store.selectWorkspace(_:)`, `ws.tabs`, `ws.id`, `Theme`.
- Produces: no new symbols; behavior change only.

- [ ] **Step 1: Header tap selects an empty workspace**

In `WorkspaceFolderHeader.body`, replace the `onTapGesture` (line ~238):

```swift
        .onTapGesture {
            guard !editing else { return }
            if ws.tabs.isEmpty { store.selectWorkspace(ws.id) }   // no tab to click ⇒ activate via header
            store.toggleWorkspaceCollapsed(ws.id)
        }
```

(A non-empty folder is unchanged — it just toggles collapse. An empty folder also becomes the active workspace so the content area shows its empty state.)

- [ ] **Step 2: `No tabs` placeholder row when expanded**

In `folderSection`, add an `else` to the tab-rows block so an expanded empty folder shows a faint placeholder:

```swift
            if !ws.collapsed {
                if ws.tabs.isEmpty {
                    Text("No tabs")
                        .font(.ui(12, .regular))
                        .foregroundStyle(Theme.textDim.opacity(0.7))
                        .padding(.leading, 22)
                        .padding(.vertical, 3)
                        .allowsHitTesting(false)
                } else {
                    ForEach(ws.tabs) { tab in
                        Group {
                            if tab.isSplit {
                                SplitTabGroup(tab: tab, workspaceID: ws.id)
                            } else {
                                TabRow(tab: tab, workspaceID: ws.id,
                                       draggingID: $draggingID, dragOffset: $dragOffset,
                                       folderRegions: folderRegions,
                                       dropTargetWorkspaceID: $dropTargetWorkspaceID)
                            }
                        }
                    }
                }
            }
```

- [ ] **Step 3: Build to verify it compiles**

Run: `cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -3`
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 4: Commit**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd
git add spike/seam1/Sources/SidebarView.swift
git commit -m "feat(sidebar): empty folder activates on header tap + No tabs row

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Update repo docs

Bring `CLAUDE.md` in line with the new behavior (it currently asserts "a workspace is never empty").

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:** none (docs).

- [ ] **Step 1: Update the ⌘W and Workspace notes**

In `CLAUDE.md`, edit the three spots that assert reseeding:
1. The `Tab.swift` / `AgentStore.swift` `⌘W` table row — change "reseed a fresh tab (last tab — a workspace is never empty; no longer closes the window)" to reflect that the last tab leaves the workspace empty.
2. The `Workspace.swift` bullet — drop the `reseedIfEmpty` mention (the method is gone).
3. The keybindings table `⌘W` row — "→ falls through to close-tab (last pane) → reseed a fresh tab (last tab …)" becomes "→ close-tab (last pane) → leave the workspace empty (last tab; workspaces may now be empty)".

Exact new `⌘W` keybindings-table row:

```markdown
| `⌘W` | close the **focused pane** → falls through to close-tab (last pane) → **leave the workspace empty** (last tab — a workspace may now hold zero tabs; it is not deleted, just empty) |
```

- [ ] **Step 2: Commit**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd
git add CLAUDE.md
git commit -m "docs: workspaces may now be empty (reseed removed)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Verification (defer runtime to user)

After all tasks: model tests green (`** TEST SUCCEEDED **`) and app builds (`** BUILD SUCCEEDED **`). Then hand to the user to confirm at runtime, without killing their live session:
- Close the last tab of a workspace → the workspace stays in the sidebar, content shows `No tabs` + New Tab button.
- New Tab / New Worktree Tab buttons work; ⌘T works in an empty workspace.
- Clicking an empty folder's header activates it (content shows the empty state).
- Empty workspace survives an app relaunch (persistence).
- ⌘⇧N still opens a workspace with one tab.
