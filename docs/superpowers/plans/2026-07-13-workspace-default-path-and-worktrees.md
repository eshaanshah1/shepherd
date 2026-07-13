# Workspace default directory + git worktree tabs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a workspace an optional default directory so all new tabs open there, and — when that directory is a git work tree — a "New Worktree Tab…" action that creates a git worktree and opens a tab inside it.

**Architecture:** A new optional `defaultPath` on the pure `Workspace` model (persisted, backward-compatible). New-tab creation seeds the pane's `cwd` from it; libghostty already opens a pane in its `cwd`, so the terminal layer is untouched. A new pure `WorktreeService.swift` holds path computation, the `# shepherd:` config-comment parser, and a thin `git` `Process` shell. The sidebar folder menu drives both features via native AppKit prompts (`NSOpenPanel`, `NSAlert`), matching the existing `promptAddRemoteHost` pattern.

**Tech Stack:** Swift, SwiftUI + AppKit, libghostty (GhosttyKit), xcodegen, XCTest.

## Global Constraints

- libghostty C API calls happen on the main thread.
- `xcodegen generate` after adding/removing any source file, else it isn't compiled.
- The `ShepherdModelTests` target is pure-model only (no AppKit); a new **compiled source** must be added to its explicit `sources:` list in `project.yml` (the `Tests` dir is already globbed for test files).
- SourceKit "cannot find type" diagnostics in this repo are stale — `xcodebuild` is ground truth.
- Do NOT `killall`/relaunch the running app — verify by compile + unit tests; defer runtime checks to the user.
- Commit messages end with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Worktree path layout: `<base>/<repo-folder-basename>/<worktree-name>`; base default `~/.shepherd/worktrees`, overridable via `# shepherd: worktree-base = <path>` in `~/.config/shepherd/config`.
- Work happens on branch `workspace-default-path-worktrees` (already created).

## File structure

- `Sources/Workspace.swift` — add `defaultPath` field + init param (pure model).
- `Sources/Persistence.swift` — `PersistedWorkspace.defaultPath` + snapshot/build wiring.
- `Sources/WorktreeService.swift` — **new**: pure path/args/config-parse + `Git` `Process` shell.
- `Sources/AgentStore.swift` — seed new-tab cwd from `defaultPath`; `setWorkspaceDirectory`; `newWorktreeTab`; worktree base resolution.
- `Sources/SidebarView.swift` — folder context menu (Set/Clear Directory), hover-`+` → `Menu` (New Tab / New Worktree Tab…), the two AppKit prompts.
- `Tests/PersistenceTests.swift` — `defaultPath` round-trip + backward-compat.
- `Tests/WorktreeServiceTests.swift` — **new**: path/args/config-parse coverage.
- `project.yml` — add `WorktreeService.swift` to the test target's `sources:`.
- `CLAUDE.md` — document the feature + the config-comment convention.

**Note (deviation from spec §4):** the spec floated a ContentView SwiftUI sheet + `promptingWorktree` state. The codebase already prompts for text via `NSAlert` accessory fields (`promptAddRemoteHost`) and for directories there's `NSOpenPanel`. Using those keeps the prompts in `SidebarView` and touches no ContentView — simpler and idiomatic. ContentView is **not** modified.

---

### Task 1: `defaultPath` on the model + persistence

**Files:**
- Modify: `Sources/Workspace.swift` (struct field + `init`)
- Modify: `Sources/Persistence.swift` (`PersistedWorkspace`, `snapshotState`, `buildWorkspaces`)
- Test: `Tests/PersistenceTests.swift`

**Interfaces:**
- Produces: `Workspace.defaultPath: String?` (init param `defaultPath: String? = nil`); `PersistedWorkspace.defaultPath: String?`. Both round-trip through `snapshotState`/`buildWorkspaces`.

- [ ] **Step 1: Write the failing tests**

Add to `Tests/PersistenceTests.swift` (inside the class):

```swift
func testDefaultPathRoundTrips() throws {
    let ws = Workspace(userTitle: "proj", tabs: [tab("t")], defaultPath: "~/dev/shepherd")
    let data = try JSONEncoder().encode(snapshotState([ws], selectedWorkspaceID: ws.id))
    let rebuilt = buildWorkspaces(from: try JSONDecoder().decode(PersistedState.self, from: data))
    XCTAssertEqual(rebuilt[0].defaultPath, "~/dev/shepherd")
}

func testMissingDefaultPathKeyDecodesToNil() throws {
    // A nil optional is OMITTED by JSONEncoder, so this blob is shaped like a pre-feature one.
    let ws = Workspace(tabs: [tab("t")])   // defaultPath nil
    let data = try JSONEncoder().encode(snapshotState([ws], selectedWorkspaceID: ws.id))
    XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("defaultPath"))
    let rebuilt = buildWorkspaces(from: try JSONDecoder().decode(PersistedState.self, from: data))
    XCTAssertNil(rebuilt.first?.defaultPath)
}
```

- [ ] **Step 2: Run tests, verify they fail to compile**

Run:
```bash
cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  -only-testing:ShepherdModelTests test 2>&1 | tail -20
```
Expected: build failure — `extra argument 'defaultPath' in call` / `value of type 'Workspace' has no member 'defaultPath'`.

- [ ] **Step 3: Add the field to `Workspace`**

In `Sources/Workspace.swift`, add the stored property after `var collapsed` (around line 10):

```swift
    var defaultPath: String? = nil   // new tabs in this workspace open here (tilde allowed); nil = shell default
```

And add the parameter to `init` (after `collapsed: Bool = false,` in the signature, and assign in the body):

```swift
    init(id: String = UUID().uuidString, userTitle: String? = nil,
         tabs: [Tab], selectedTabID: String? = nil, collapsed: Bool = false,
         defaultPath: String? = nil,
         remoteHostID: String? = nil, remoteWorkspaceID: String? = nil) {
        self.id = id
        self.userTitle = userTitle
        self.tabs = tabs
        self.selectedTabID = selectedTabID ?? tabs.first?.tabID
        self.collapsed = collapsed
        self.defaultPath = defaultPath
        self.remoteHostID = remoteHostID
        self.remoteWorkspaceID = remoteWorkspaceID
    }
```

- [ ] **Step 4: Thread it through persistence**

In `Sources/Persistence.swift`:

Add to `PersistedWorkspace` (optionals auto-default to nil in the memberwise init, so `migrateLegacyTabs` keeps compiling):

```swift
struct PersistedWorkspace: Codable {
    var userTitle: String?
    var selectedTabIndex: Int
    var tabs: [PersistedTab]
    var collapsed: Bool?
    var defaultPath: String?       // optional so pre-feature blobs still decode (nil = none)
}
```

In `snapshotState`, add `defaultPath` to the `PersistedWorkspace(...)` construction:

```swift
        return PersistedWorkspace(
            userTitle: ws.userTitle,
            selectedTabIndex: selTab,
            tabs: ws.tabs.map { PersistedTab(userTitle: $0.userTitle, root: $0.root) },
            collapsed: ws.collapsed,
            defaultPath: ws.defaultPath)
```

In `buildWorkspaces`, pass it to the `Workspace(...)` construction:

```swift
        return Workspace(userTitle: pw.userTitle, tabs: tabs, selectedTabID: selID,
                         collapsed: pw.collapsed ?? false, defaultPath: pw.defaultPath)
```

- [ ] **Step 5: Run tests, verify they pass**

Run:
```bash
cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  -only-testing:ShepherdModelTests test 2>&1 | tail -20
```
Expected: `** TEST SUCCEEDED **` (both new tests pass).

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/Workspace.swift spike/seam1/Sources/Persistence.swift \
        spike/seam1/Tests/PersistenceTests.swift
git commit -m "feat(workspace): persist optional per-workspace defaultPath

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `WorktreeService.swift` — pure path/args/config + git shell

**Files:**
- Create: `Sources/WorktreeService.swift`
- Create: `Tests/WorktreeServiceTests.swift`
- Modify: `project.yml` (add the source to the test target)

**Interfaces:**
- Produces (pure):
  - `struct ShepherdConfig: Equatable { var worktreeBase: String? }`
  - `func parseShepherdConfig(_ contents: String) -> ShepherdConfig`
  - `func worktreePath(base: String, repoDir: String, name: String) -> String`
  - `func worktreeAddArgs(dest: String, name: String, branchExists: Bool) -> [String]`
- Produces (shell, app target only): `enum Git` with
  `run(_:in:) -> (code: Int32, out: String, err: String)`, `isWorkTree(_:) -> Bool`,
  `branchExists(_:in:) -> Bool`, `addWorktree(dest:name:in:) -> (ok: Bool, err: String)`.

- [ ] **Step 1: Write the failing tests**

Create `Tests/WorktreeServiceTests.swift`:

```swift
import XCTest

final class WorktreeServiceTests: XCTestCase {
    func testWorktreePathLayout() {
        XCTAssertEqual(worktreePath(base: "/wt", repoDir: "/a/b/shepherd", name: "feat"),
                       "/wt/shepherd/feat")
    }
    func testWorktreePathTrailingSlashRepo() {
        XCTAssertEqual(worktreePath(base: "/wt", repoDir: "/a/b/shepherd/", name: "feat"),
                       "/wt/shepherd/feat")
    }
    func testWorktreePathTildeBasePreserved() {
        XCTAssertEqual(worktreePath(base: "~/code/wt", repoDir: "/x/repo", name: "b"),
                       "~/code/wt/repo/b")
    }
    func testWorktreeAddArgsNewBranch() {
        XCTAssertEqual(worktreeAddArgs(dest: "/d", name: "b", branchExists: false),
                       ["worktree", "add", "/d", "-b", "b"])
    }
    func testWorktreeAddArgsExistingBranch() {
        XCTAssertEqual(worktreeAddArgs(dest: "/d", name: "b", branchExists: true),
                       ["worktree", "add", "/d", "b"])
    }
    func testParseConfigWorktreeBase() {
        let c = parseShepherdConfig("# shepherd: worktree-base = ~/code/wt\nbackground = 000")
        XCTAssertEqual(c.worktreeBase, "~/code/wt")
    }
    func testParseConfigExtraSpacing() {
        let c = parseShepherdConfig("#   shepherd:   worktree-base   =   /tmp/wt  ")
        XCTAssertEqual(c.worktreeBase, "/tmp/wt")
    }
    func testParseConfigAbsentKey() {
        let c = parseShepherdConfig("background = 000\n# a normal comment")
        XCTAssertNil(c.worktreeBase)
    }
    func testParseConfigIgnoresPlainGhosttyLine() {
        // A non-comment `worktree-base` line is a ghostty key, not ours — ignored.
        let c = parseShepherdConfig("worktree-base = /should/not/apply")
        XCTAssertNil(c.worktreeBase)
    }
}
```

- [ ] **Step 2: Create the source file**

Create `Sources/WorktreeService.swift`:

```swift
import Foundation

// MARK: - Pure core (unit-tested)

/// Shepherd-specific settings parsed from its own config file.
struct ShepherdConfig: Equatable {
    var worktreeBase: String? = nil
}

/// Parse Shepherd directives out of the ghostty-syntax `~/.config/shepherd/config`.
/// They ride ghostty COMMENT lines (`# shepherd: key = value`) so libghostty ignores
/// them — keeping the single file valid ghostty syntax with no config-error noise.
/// Tolerant of extra whitespace after `#` and around the `=`.
func parseShepherdConfig(_ contents: String) -> ShepherdConfig {
    var cfg = ShepherdConfig()
    for raw in contents.split(whereSeparator: \.isNewline) {
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("#") else { continue }
        let afterHash = String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces)
        guard afterHash.hasPrefix("shepherd:") else { continue }
        let body = afterHash.dropFirst("shepherd:".count).trimmingCharacters(in: .whitespaces)
        guard let eq = body.firstIndex(of: "=") else { continue }
        let key = body[..<eq].trimmingCharacters(in: .whitespaces)
        let value = body[body.index(after: eq)...].trimmingCharacters(in: .whitespaces)
        guard !value.isEmpty else { continue }
        if key == "worktree-base" { cfg.worktreeBase = value }
    }
    return cfg
}

/// `<base>/<repo-folder-basename>/<name>`.
func worktreePath(base: String, repoDir: String, name: String) -> String {
    let repoName = (repoDir as NSString).lastPathComponent
    return (base as NSString).appendingPathComponent(repoName).appendingPathComponent(name)
}

/// `git worktree add` args — reuse an existing branch, else create it off HEAD.
func worktreeAddArgs(dest: String, name: String, branchExists: Bool) -> [String] {
    branchExists ? ["worktree", "add", dest, name]
                 : ["worktree", "add", dest, "-b", name]
}

// MARK: - git shell (app target only; not unit-tested)

enum Git {
    /// Run `git -C <dir> <args>`; returns exit code + captured stdout/stderr.
    static func run(_ args: [String], in dir: String) -> (code: Int32, out: String, err: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = ["git", "-C", dir] + args
        let outPipe = Pipe(), errPipe = Pipe()
        p.standardOutput = outPipe
        p.standardError = errPipe
        do { try p.run() } catch { return (-1, "", "\(error)") }
        // git worktree output is tiny, so read-to-EOF before wait can't deadlock the pipe buffer.
        let out = String(data: outPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let err = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        p.waitUntilExit()
        return (p.terminationStatus, out, err)
    }

    static func isWorkTree(_ dir: String) -> Bool {
        run(["rev-parse", "--is-inside-work-tree"], in: dir)
            .out.trimmingCharacters(in: .whitespacesAndNewlines) == "true"
    }

    static func branchExists(_ name: String, in dir: String) -> Bool {
        run(["show-ref", "--verify", "--quiet", "refs/heads/\(name)"], in: dir).code == 0
    }

    static func addWorktree(dest: String, name: String, in dir: String) -> (ok: Bool, err: String) {
        let r = run(worktreeAddArgs(dest: dest, name: name,
                                    branchExists: branchExists(name, in: dir)), in: dir)
        return (r.code == 0, r.err)
    }
}
```

- [ ] **Step 3: Register the new source with the test target**

In `project.yml`, under `ShepherdModelTests:` → `sources:`, add a line alongside the others (e.g. after `- path: Sources/Persistence.swift`):

```yaml
      - path: Sources/WorktreeService.swift
```

(The app target uses `- path: Sources`, so it picks up the file automatically; only the test target needs the explicit entry.)

- [ ] **Step 4: Regenerate the project**

Run:
```bash
cd spike/seam1 && xcodegen generate
```
Expected: `Created project at .../Shepherd.xcodeproj`.

- [ ] **Step 5: Run tests, verify they pass**

Run:
```bash
cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  -only-testing:ShepherdModelTests test 2>&1 | tail -20
```
Expected: `** TEST SUCCEEDED **`.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/WorktreeService.swift spike/seam1/Tests/WorktreeServiceTests.swift \
        spike/seam1/project.yml
git commit -m "feat(worktree): WorktreeService — path/args/config parse + git shell

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Store — new-tab cwd from `defaultPath`, set-directory, worktree flow

**Files:**
- Modify: `Sources/AgentStore.swift`

**Interfaces:**
- Consumes: `Workspace.defaultPath` (Task 1); `worktreePath`, `parseShepherdConfig`, `Git` (Task 2).
- Produces:
  - `func setWorkspaceDirectory(_ id: String, to path: String?)`
  - `func newTab(inWorkspace wsID: String, cwd: String? = nil) -> String` (added `cwd` param)
  - `func newWorktreeTab(inWorkspace wsID: String, name: String)`
- Behavior: `newTab()` and `newTab(inWorkspace:)` seed a fresh pane's `cwd` from the workspace's expanded `defaultPath` (unless an explicit `cwd` is passed). This is verified by compile (store is AppKit/@MainActor — outside the pure test target).

- [ ] **Step 1: Add the default-path helper + set-directory op**

In `Sources/AgentStore.swift`, add a new section (e.g. just before `// MARK: Tabs (current workspace)` near line 245):

```swift
    // MARK: Workspace default directory + git worktrees

    /// The workspace's default dir, tilde-expanded, or nil when unset/empty.
    private func expandedDefaultPath(_ ws: Workspace) -> String? {
        guard let p = ws.defaultPath, !p.isEmpty else { return nil }
        return (p as NSString).expandingTildeInPath
    }

    /// Set (or clear, when nil/empty) the directory new tabs in this workspace open in.
    func setWorkspaceDirectory(_ id: String, to path: String?) {
        guard let i = workspaces.firstIndex(where: { $0.id == id }) else { return }
        let trimmed = path?.trimmingCharacters(in: .whitespacesAndNewlines)
        workspaces[i].defaultPath = (trimmed?.isEmpty ?? true) ? nil : trimmed
        save()
    }

    /// The base dir worktrees are created under: `# shepherd: worktree-base` from the config,
    /// else `~/.shepherd/worktrees`.
    private func worktreeBaseDir() -> String {
        let cfgPath = (NSHomeDirectory() as NSString).appendingPathComponent(".config/shepherd/config")
        if let contents = try? String(contentsOfFile: cfgPath, encoding: .utf8),
           let base = parseShepherdConfig(contents).worktreeBase, !base.isEmpty {
            return (base as NSString).expandingTildeInPath
        }
        return (NSHomeDirectory() as NSString).appendingPathComponent(".shepherd/worktrees")
    }

    /// Create a git worktree under the workspace's default repo and open a tab in it.
    /// git runs off-main; on success the tab opens in the worktree, on failure git's
    /// stderr is surfaced. Reuses an existing branch named `name`, else creates it off HEAD.
    func newWorktreeTab(inWorkspace wsID: String, name: String) {
        guard let ws = workspaces.first(where: { $0.id == wsID }),
              let repoDir = expandedDefaultPath(ws) else { return }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let dest = worktreePath(base: worktreeBaseDir(), repoDir: repoDir, name: trimmed)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let result = Git.addWorktree(dest: dest, name: trimmed, in: repoDir)
            DispatchQueue.main.async {
                guard let self else { return }
                if result.ok {
                    self.newTab(inWorkspace: wsID, cwd: dest)
                } else {
                    let alert = NSAlert()
                    alert.messageText = "Couldn't create worktree"
                    alert.informativeText = result.err.isEmpty ? "git worktree add failed." : result.err
                    alert.alertStyle = .warning
                    alert.addButton(withTitle: "OK")
                    alert.runModal()
                }
            }
        }
    }
```

- [ ] **Step 2: Seed cwd in `newTab()` (⌘T, current workspace)**

In `Sources/AgentStore.swift`, in `newTab()` (around line 248), replace:

```swift
        let tab = Tab(pane: Pane())
        workspaces[w].tabs.append(tab)
```
with:
```swift
        var pane = Pane()
        pane.cwd = expandedDefaultPath(workspaces[w])
        let tab = Tab(pane: pane)
        workspaces[w].tabs.append(tab)
```

- [ ] **Step 3: Add `cwd` param + seed default in `newTab(inWorkspace:)`**

In `Sources/AgentStore.swift`, replace the whole `newTab(inWorkspace:)` (around lines 394-406):

```swift
    /// New tab into a specific folder, selecting it (the folder-header hover `+`).
    /// An explicit `cwd` (worktree flow) overrides the workspace's default directory.
    @discardableResult
    func newTab(inWorkspace wsID: String, cwd: String? = nil) -> String {
        guard let w = workspaces.firstIndex(where: { $0.id == wsID }) else { return "" }
        selectedWorkspaceID = wsID
        if let (c, wid) = remoteTarget(forWorkspace: wsID) { c.send(.cmdNewTab(workspaceID: wid)); return "" }
        var pane = Pane()
        pane.cwd = cwd ?? expandedDefaultPath(workspaces[w])
        let tab = Tab(pane: pane)
        workspaces[w].tabs.append(tab)
        workspaces[w].selectedTabID = tab.tabID
        save()
        refocusActiveTerminal()
        broadcastWorkspaceTree(workspaceID: wsID)
        return tab.tabID
    }
```

- [ ] **Step 4: Build the app target, verify it compiles**

Run:
```bash
cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  build 2>&1 | tail -20
```
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/AgentStore.swift
git commit -m "feat(workspace): new tabs open in defaultPath; set-directory + worktree-tab store ops

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4 (remote): Mac-to-Mac support — wire defaultPath + forward set-dir/worktree

Mirror workspaces are host-authoritative: the client sends `cmd*`, the host mutates its
real store and re-broadcasts the tree. Default-directory new tabs already work remotely
for free (client "New Tab" → `cmdNewTab` → host `newTab()` seeds from the host workspace's
`defaultPath`). This task makes set-directory and worktree-creation work remotely too, and
lets the client learn the host's `defaultPath`.

**Files:**
- Modify: `Sources/RemoteProtocol.swift` (`WorkspaceTree.defaultPath`, two `cmd*` cases)
- Modify: `Sources/AgentStore.swift` (client-forward in `setWorkspaceDirectory`/`newWorktreeTab`; host-apply; wire `defaultPath` in projections/mirror; broadcast on set)

**Interfaces:**
- Produces: `WorkspaceTree.defaultPath: String?`; `ControlMessage.cmdSetWorkspaceDirectory(workspaceID:path:)`, `.cmdNewWorktreeTab(workspaceID:name:)`.

- [ ] **Step 1: Wire `defaultPath` into `WorkspaceTree` + two commands**

In `Sources/RemoteProtocol.swift`, add to `WorkspaceTree` (defaulted so existing constructors compile):
```swift
struct WorkspaceTree: Codable, Equatable {
    let workspaceID: String; let name: String
    let tabs: [RemoteTab]; let selectedTabID: String?
    var defaultPath: String? = nil
}
```
Add to `ControlMessage` (after `cmdSwitchTab`):
```swift
    case cmdSetWorkspaceDirectory(workspaceID: String, path: String?)
    case cmdNewWorktreeTab(workspaceID: String, name: String)
```

- [ ] **Step 2: Host populates `defaultPath` in projections**

In `Sources/AgentStore.swift`, in `workspaceTrees()` and `broadcastWorkspaceTree`, add `defaultPath: ws.defaultPath` to the `WorkspaceTree(...)` constructions.

- [ ] **Step 3: Mirror reads it**

In `Sources/Workspace.swift`, in `buildMirrorWorkspace`, pass `defaultPath: tree.defaultPath` to the `Workspace(...)` init.

- [ ] **Step 4: Client forwards; host broadcasts on set**

In `setWorkspaceDirectory` (Task 3) add the remote-forward at the top and a trailing broadcast:
```swift
    func setWorkspaceDirectory(_ id: String, to path: String?) {
        if let t = remoteTarget(forWorkspace: id) {
            t.client.send(.cmdSetWorkspaceDirectory(workspaceID: t.wsID, path: path)); return
        }
        guard let i = workspaces.firstIndex(where: { $0.id == id }) else { return }
        let trimmed = path?.trimmingCharacters(in: .whitespacesAndNewlines)
        workspaces[i].defaultPath = (trimmed?.isEmpty ?? true) ? nil : trimmed
        save()
        broadcastWorkspaceTree(workspaceID: id)
    }
```
In `newWorktreeTab` add the remote-forward at the top:
```swift
    func newWorktreeTab(inWorkspace wsID: String, name: String) {
        if let t = remoteTarget(forWorkspace: wsID) {
            let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !n.isEmpty else { return }
            t.client.send(.cmdNewWorktreeTab(workspaceID: t.wsID, name: n)); return
        }
        // ... existing local git flow ...
    }
```

- [ ] **Step 5: Host applies the two commands**

In `applyRemoteCommand`, add before `default: return`:
```swift
        case .cmdSetWorkspaceDirectory(let ws, let path): setWorkspaceDirectory(ws, to: path)
        case .cmdNewWorktreeTab(let ws, let name):        newWorktreeTab(inWorkspace: ws, name: name)
```

- [ ] **Step 6: Build + commit**

Run the app build; expect `** BUILD SUCCEEDED **`. Commit:
```bash
git add spike/seam1/Sources/RemoteProtocol.swift spike/seam1/Sources/AgentStore.swift spike/seam1/Sources/Workspace.swift
git commit -m "feat(remote): host-forwarded set-directory + worktree tabs; wire defaultPath"
```

Known v1 limitation: a worktree git error on a remote workspace surfaces on the **host** (NSAlert), not the client.

---

### Task 5: Sidebar — Set/Clear Directory menu + hover-`+` worktree menu

**Files:**
- Modify: `Sources/SidebarView.swift` (the `WorkspaceFolderHeader` struct)

**Interfaces:**
- Consumes: `store.setWorkspaceDirectory(_:to:)`, `store.newTab(inWorkspace:)`, `store.newWorktreeTab(inWorkspace:name:)` (Task 3); `Git.isWorkTree(_:)` (Task 2); `ws.defaultPath` (Task 1).
- Verified by compile (SwiftUI view — outside the pure test target).

- [ ] **Step 1: Add the git-repo state + async refresh**

In `Sources/SidebarView.swift`, in `WorkspaceFolderHeader`, add near the other `@State` (around line 206):

```swift
    @State private var isGitRepo = false
```

Add this method alongside the other private methods (e.g. after `beginRename()`):

```swift
    /// Refresh whether the default dir is a git work tree (drives the worktree menu item).
    /// Off-main so a hover never hitches; settles before the `+` menu is opened.
    private func refreshGitStatus() {
        guard let p = ws.defaultPath, !p.isEmpty else { isGitRepo = false; return }
        let dir = (p as NSString).expandingTildeInPath
        DispatchQueue.global(qos: .userInitiated).async {
            let ok = Git.isWorkTree(dir)
            DispatchQueue.main.async { isGitRepo = ok }
        }
    }
```

- [ ] **Step 2: Trigger the refresh on hover-enter**

In `Sources/SidebarView.swift`, replace the header's `.onHover { hovering = $0 }` (around line 246) with:

```swift
        .onHover { h in
            hovering = h
            if h { refreshGitStatus() }
        }
```

- [ ] **Step 3: Replace the hover-`+` button with a menu**

In `Sources/SidebarView.swift`, replace the `if hovering { Button(...) { ... } ... }` block (around lines 225-234) with:

```swift
                if hovering {
                    Menu {
                        Button("New Tab") { store.newTab(inWorkspace: ws.id) }
                        if isGitRepo {
                            Button("New Worktree Tab…") { promptNewWorktree() }
                        }
                    } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Theme.textDim)
                    }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .focusable(false)
                    .help("New tab in this workspace")
                }
```

- [ ] **Step 4: Add the two prompts + Set/Clear menu items**

In `Sources/SidebarView.swift`, extend the header's `.contextMenu` (around lines 249-255) to:

```swift
        .contextMenu {
            Button("Rename") { beginRename() }
            Button("Set Directory…") { promptSetDirectory() }
            if ws.defaultPath?.isEmpty == false {
                Button("Clear Directory") { store.setWorkspaceDirectory(ws.id, to: nil) }
            }
            Button(ws.collapsed ? "Expand" : "Collapse") { store.toggleWorkspaceCollapsed(ws.id) }
            if store.workspaces.count > 1 {
                Button("Delete", role: .destructive) { confirmDelete() }
            }
        }
```

Add these two methods alongside the others in `WorkspaceFolderHeader`:

```swift
    /// Pick the workspace's default directory (native folder chooser).
    private func promptSetDirectory() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Set"
        panel.message = "Choose the default directory for new tabs in this workspace"
        if let cur = ws.defaultPath, !cur.isEmpty {
            panel.directoryURL = URL(fileURLWithPath: (cur as NSString).expandingTildeInPath)
        }
        guard panel.runModal() == .OK, let url = panel.url else { return }
        store.setWorkspaceDirectory(ws.id, to: url.path)
        store.refocusActiveTerminal()
    }

    /// Prompt for a branch name, then create a worktree tab (mirrors promptAddRemoteHost).
    private func promptNewWorktree() {
        let alert = NSAlert()
        alert.messageText = "New worktree tab"
        alert.informativeText = "Name a branch. An existing branch is reused; a new name is created off HEAD."
        let tf = NSTextField(frame: NSRect(x: 0, y: 0, width: 240, height: 24))
        tf.placeholderString = "branch name"
        alert.accessoryView = tf
        alert.addButton(withTitle: "Create")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = tf
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let name = tf.stringValue.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        store.newWorktreeTab(inWorkspace: ws.id, name: name)
    }
```

- [ ] **Step 5: Build the app target, verify it compiles**

Run:
```bash
cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  build 2>&1 | tail -20
```
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/SidebarView.swift
git commit -m "feat(sidebar): Set/Clear Directory + hover-+ menu with New Worktree Tab

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Docs + full verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Document the feature in `CLAUDE.md`**

In `/Users/eshaannileshshah/Home/dev/tools/shepherd/CLAUDE.md`, add to the **Sidebar** section (after the folder right-click description) a sentence:

```
A folder's right-click menu also carries **Set Directory…** / **Clear Directory** (a
per-workspace `defaultPath` that new tabs open in), and its hover-`+` is a menu (*New
Tab* / *New Worktree Tab…*). "New Worktree Tab…" shows only when the default dir is a
git work tree; it runs `git worktree add` under `<base>/<repo-name>/<branch>` (base =
`~/.shepherd/worktrees`, overridable via a `# shepherd: worktree-base = …` comment line
in `~/.config/shepherd/config`) and opens a tab in the new worktree.
```

Add to the **Persistence** section a note that `defaultPath` (optional, per workspace) persists in `shepherd.workspaces.v1` alongside `collapsed`.

Add to **Critical gotchas** one line:

```
- **Shepherd config keys ride ghostty comments**: `~/.config/shepherd/config` is parsed by
  libghostty, so Shepherd-specific keys (currently `worktree-base`) live on `# shepherd: key = value`
  comment lines that libghostty ignores (`parseShepherdConfig` in `WorktreeService.swift`).
```

- [ ] **Step 2: Regenerate + run the full test suite**

Run:
```bash
cd spike/seam1 && xcodegen generate && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd \
  -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache -only-testing:ShepherdModelTests test 2>&1 | tail -25
```
Expected: `** TEST SUCCEEDED **` (all model tests, including the new persistence + worktree-service ones).

- [ ] **Step 3: Full app build (sanity)**

Run:
```bash
cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  build 2>&1 | tail -10
```
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: workspace defaultPath, worktree tabs, shepherd config-comment convention

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 5: Hand off runtime verification to the user**

Do **not** relaunch the running app. Report that compile + unit tests pass and list what the user should eyeball at their next relaunch:
- Right-click a workspace folder → **Set Directory…**, pick a repo → new tabs (⌘T and the hover-`+` *New Tab*) open there.
- With the default dir a git repo, hover-`+` shows **New Worktree Tab…** → naming `feat` creates `~/.shepherd/worktrees/<repo>/feat` and opens a tab in it; a bad name surfaces git's error.
- **Clear Directory** removes the default; the setting survives a relaunch.

---

## Self-review

**Spec coverage:**
- §1 data model & persistence → Task 1. ✅
- §2 new tabs honor default path → Task 3 (steps 2-3). ✅
- §3 set/clear directory UI → Task 3 (`setWorkspaceDirectory`) + Task 4 (menu + `NSOpenPanel`). ✅
- §4 worktree tab (hover-`+` menu, git-repo gate, prompt, reuse-or-create branch, error surfacing) → Task 3 (`newWorktreeTab`) + Task 4 (menu + prompt). ✅
- §5 config override via `# shepherd:` comment → Task 2 (`parseShepherdConfig`) + Task 3 (`worktreeBaseDir`). ✅
- §6 WorktreeService pure/shell split → Task 2. ✅
- §7 testing (persistence round-trip + backward-compat, path, config parser) → Tasks 1 & 2. ✅
- Files-touched list, incl. `project.yml` + `CLAUDE.md` → Tasks 2 & 5. ✅

**Placeholder scan:** none — every code step shows full code; no TBD/TODO/"handle edge cases".

**Type consistency:** `defaultPath: String?` consistent across Workspace/PersistedWorkspace/tests. `worktreePath(base:repoDir:name:)`, `worktreeAddArgs(dest:name:branchExists:)`, `parseShepherdConfig(_:)`, `ShepherdConfig.worktreeBase`, `Git.isWorkTree/branchExists/addWorktree` used with identical signatures in Tasks 2/3/4. `newTab(inWorkspace:cwd:)` defined in Task 3, called in Tasks 3/4. ✅
