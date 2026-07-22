# Unified Settings + Worktree Hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a unified macOS Settings window (⌘,) that surfaces Appearance / Workspaces / Remote / Keybindings / General, and a per-workspace worktree hook — bash commands run immediately after `git worktree add` succeeds.

**Architecture:** A SwiftUI `Settings` scene hosts a themed `TabView`. Appearance round-trips theme/font into `~/.config/shepherd/config` via a new pure `ShepherdConfigWriter` + the existing `reloadConfig()`. The worktree hook is a `String?` on `Workspace` (persisted in `shepherd.workspaces.v1`), executed off-main by a new `WorktreeHookRunner` inside the existing `newWorktreeTab` provisioning flow; a non-zero exit warns but keeps the worktree.

**Tech Stack:** Swift, SwiftUI, AppKit, libghostty (via `GhosttyApp`), xcodegen, XCTest (`ShepherdModelTests`).

## Global Constraints

- **App target sources are globbed** (`- path: Sources` in `project.yml`) — new files under `Sources/` are auto-compiled into the app. New *source* files that the **test target** must see require an explicit `- path: Sources/<file>.swift` entry under `ShepherdModelTests.sources`. New *test* files under `Tests/` are auto-included via the `- path: Tests` glob.
- **`xcodegen generate` is required after adding/removing any source file** (before it, a new file isn't compiled).
- **Pure-model files compiled by the test target must be Foundation-only** — no `import AppKit`/`SwiftUI`, no reference to `GhosttyApp`, `AgentStore`, or other app-only types (mirror `WorktreeService.swift`, which puts a Foundation `Process` shell alongside its pure core).
- **libghostty C API calls happen on the main thread**; `reloadConfig()` is `@MainActor`.
- **Env var names are unprefixed:** `WORKTREE_DIR`, `WORKTREE_SRC`, `WORKTREE_BRANCH`, `WORKTREE_NAME`, `REPO_NAME`.
- **Config keys:** `theme` is a `# shepherd:`-comment key; `font-family` and `font-size` and `worktree-base` — note `worktree-base` is ALSO a `# shepherd:` key (see `parseShepherdConfig`), while `font-family`/`font-size` are native ghostty keys.
- **UI colors come from `Theme`** (`Theme.text`, `Theme.textDim`, `Theme.bg`, `Theme.divider`, `Theme.working`, etc.); chrome fonts via `.ui(_:_:)` / `.mono(_:_:)`.
- **Commit messages** end with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Do NOT relaunch the app** — verify by compile + unit tests only; runtime checks are deferred to the user (per project rules).

### Verification commands (referenced by tasks)

**Build** (run after `xcodegen generate` when files were added):
```bash
cd spike/seam1 && xcodegen generate && \
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -5
```

**Unit tests** (`ShepherdModelTests` only):
```bash
cd spike/seam1 && \
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  -only-testing:ShepherdModelTests test 2>&1 | tail -20
```

---

## File Structure

- `Sources/ShepherdConfigWriter.swift` (new) — pure `apply(contents:sets:)` config-line transform + `ConfigEdit`/`ConfigKeyKind` + Foundation file-IO `set(_:)`. Both targets.
- `Sources/WorktreeHookRunner.swift` (new) — pure `hookEnvironment(...)` + Foundation `Process` `run(...)`. Both targets.
- `Sources/Workspace.swift` (modify) — add `worktreeHook: String?`.
- `Sources/Persistence.swift` (modify) — persist `worktreeHook`.
- `Sources/AgentStore.swift` (modify) — run the hook in `newWorktreeTab`; add `setWorktreeHook(_:to:)`.
- `Sources/SettingsView.swift` (new) — the `TabView` + five tab subviews. App target only.
- `Sources/ShepherdApp.swift` (modify) — add the `Settings` scene.
- `project.yml` (modify) — add the two new Foundation sources to the test target.
- `Tests/ShepherdConfigWriterTests.swift` (new), `Tests/WorktreeHookRunnerTests.swift` (new), `Tests/PersistenceTests.swift` (modify).

---

## Task 1: ShepherdConfigWriter (pure config-line transform)

**Files:**
- Create: `spike/seam1/Sources/ShepherdConfigWriter.swift`
- Create: `spike/seam1/Tests/ShepherdConfigWriterTests.swift`
- Modify: `spike/seam1/project.yml` (add source to `ShepherdModelTests.sources`)

**Interfaces:**
- Produces:
  - `enum ConfigKeyKind { case native, shepherd }`
  - `struct ConfigEdit { let key: String; let kind: ConfigKeyKind; let value: String }`
  - `enum ShepherdConfigWriter { static func apply(contents: String, sets edits: [ConfigEdit]) -> String; static func set(_ edits: [ConfigEdit]) throws }`

- [ ] **Step 1: Add the new source to the test target in `project.yml`**

Under `ShepherdModelTests:` → `sources:`, after the `- path: Sources/WorktreeService.swift` line, add:
```yaml
      - path: Sources/ShepherdConfigWriter.swift
```

- [ ] **Step 2: Write the failing tests**

Create `spike/seam1/Tests/ShepherdConfigWriterTests.swift`:
```swift
import XCTest
@testable import Shepherd

final class ShepherdConfigWriterTests: XCTestCase {
    func testInsertNativeKeyIntoEmpty() {
        let out = ShepherdConfigWriter.apply(contents: "",
            sets: [ConfigEdit(key: "font-family", kind: .native, value: "JetBrains Mono")])
        XCTAssertEqual(out, "font-family = JetBrains Mono\n")
    }

    func testInsertShepherdKeyAsComment() {
        let out = ShepherdConfigWriter.apply(contents: "",
            sets: [ConfigEdit(key: "theme", kind: .shepherd, value: "light")])
        XCTAssertEqual(out, "# shepherd: theme = light\n")
    }

    func testUpdateExistingNativeKeyInPlace() {
        let src = "font-family = Menlo\nfont-size = 13\n"
        let out = ShepherdConfigWriter.apply(contents: src,
            sets: [ConfigEdit(key: "font-family", kind: .native, value: "JetBrains Mono")])
        XCTAssertEqual(out, "font-family = JetBrains Mono\nfont-size = 13\n")
    }

    func testUpdateExistingShepherdKeyInPlace() {
        let src = "# shepherd: theme = dark\nfont-size = 13\n"
        let out = ShepherdConfigWriter.apply(contents: src,
            sets: [ConfigEdit(key: "theme", kind: .shepherd, value: "warm")])
        XCTAssertEqual(out, "# shepherd: theme = warm\nfont-size = 13\n")
    }

    func testPreservesUnrelatedLinesAndComments() {
        let src = "# my notes\nkeybind = ctrl+a\n\n# shepherd: theme = dark\n"
        let out = ShepherdConfigWriter.apply(contents: src,
            sets: [ConfigEdit(key: "font-size", kind: .native, value: "14")])
        XCTAssertEqual(out,
            "# my notes\nkeybind = ctrl+a\n\n# shepherd: theme = dark\nfont-size = 14\n")
    }

    func testShepherdEditDoesNotMatchNativeKeyOfSameName() {
        // A native `theme = x` line must not be treated as the shepherd theme key.
        let src = "theme = dark\n"
        let out = ShepherdConfigWriter.apply(contents: src,
            sets: [ConfigEdit(key: "theme", kind: .shepherd, value: "light")])
        XCTAssertEqual(out, "theme = dark\n# shepherd: theme = light\n")
    }

    func testIdempotentReapply() {
        let edit = ConfigEdit(key: "theme", kind: .shepherd, value: "light")
        let once = ShepherdConfigWriter.apply(contents: "", sets: [edit])
        let twice = ShepherdConfigWriter.apply(contents: once, sets: [edit])
        XCTAssertEqual(once, twice)
    }
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run the **Unit tests** command. Expected: FAIL — "cannot find 'ShepherdConfigWriter' / 'ConfigEdit' in scope" (compile error).

- [ ] **Step 4: Write the implementation**

Create `spike/seam1/Sources/ShepherdConfigWriter.swift`:
```swift
import Foundation

// MARK: - Pure core (unit-tested)

/// A native ghostty key (`font-size = 13`) vs. a Shepherd key that rides a ghostty
/// comment line (`# shepherd: theme = dark`, ignored by libghostty).
enum ConfigKeyKind { case native, shepherd }

/// A single key to set in `~/.config/shepherd/config`.
struct ConfigEdit {
    let key: String
    let kind: ConfigKeyKind
    let value: String
}

/// Surgically updates specific keys in the ghostty-syntax config while preserving
/// every other line, comment, blank line, and ordering. Never clobbers a hand-written
/// file: an unknown key is appended, an existing one is rewritten in place.
enum ShepherdConfigWriter {
    static func apply(contents: String, sets edits: [ConfigEdit]) -> String {
        var lines = contents.components(separatedBy: "\n")
        // A trailing newline yields a final "" element; drop it so appends land on a
        // real line and the single trailing newline is re-added on join.
        if lines.last == "" { lines.removeLast() }
        for edit in edits {
            let rendered = render(edit)
            if let idx = lines.firstIndex(where: { matches($0, edit) }) {
                lines[idx] = rendered
            } else {
                lines.append(rendered)
            }
        }
        return lines.isEmpty ? "" : lines.joined(separator: "\n") + "\n"
    }

    private static func render(_ e: ConfigEdit) -> String {
        switch e.kind {
        case .native:   return "\(e.key) = \(e.value)"
        case .shepherd: return "# shepherd: \(e.key) = \(e.value)"
        }
    }

    private static func matches(_ line: String, _ edit: ConfigEdit) -> Bool {
        let t = line.trimmingCharacters(in: .whitespaces)
        switch edit.kind {
        case .native:
            guard !t.hasPrefix("#") else { return false }
            return keyOf(t) == edit.key
        case .shepherd:
            guard t.hasPrefix("#") else { return false }
            let afterHash = String(t.dropFirst()).trimmingCharacters(in: .whitespaces)
            guard afterHash.hasPrefix("shepherd:") else { return false }
            let body = afterHash.dropFirst("shepherd:".count).trimmingCharacters(in: .whitespaces)
            return keyOf(body) == edit.key
        }
    }

    private static func keyOf(_ s: String) -> String? {
        guard let eq = s.firstIndex(of: "=") else { return nil }
        return s[..<eq].trimmingCharacters(in: .whitespaces)
    }

    // MARK: - File IO shell (Foundation only)

    /// Read `~/.config/shepherd/config` (creating its dir if needed), apply the edits,
    /// and write it back atomically. Caller triggers `reloadConfig()` afterward.
    static func set(_ edits: [ConfigEdit]) throws {
        let path = (NSHomeDirectory() as NSString).appendingPathComponent(".config/shepherd/config")
        let dir = (path as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let existing = (try? String(contentsOfFile: path, encoding: .utf8)) ?? ""
        let updated = apply(contents: existing, sets: edits)
        try updated.write(toFile: path, atomically: true, encoding: .utf8)
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run the **Unit tests** command (it regenerates nothing — but since a source was added, run the **Build** command first to `xcodegen generate`, then the test command). Expected: all `ShepherdConfigWriterTests` PASS.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/ShepherdConfigWriter.swift \
        spike/seam1/Tests/ShepherdConfigWriterTests.swift \
        spike/seam1/project.yml
git commit -m "feat(settings): ShepherdConfigWriter — surgical config-key round-trip

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: WorktreeHookRunner (env builder + bash runner)

**Files:**
- Create: `spike/seam1/Sources/WorktreeHookRunner.swift`
- Create: `spike/seam1/Tests/WorktreeHookRunnerTests.swift`
- Modify: `spike/seam1/project.yml` (add source to `ShepherdModelTests.sources`)

**Interfaces:**
- Produces:
  - `enum WorktreeHookRunner`
  - `static func hookEnvironment(worktreeDir: String, src: String, branch: String, name: String, repoName: String) -> [String: String]`
  - `struct HookResult { let exitCode: Int32; let output: String }`
  - `static func run(script: String, cwd: String, env: [String: String]) -> HookResult`

- [ ] **Step 1: Add the new source to the test target in `project.yml`**

Under `ShepherdModelTests:` → `sources:`, after the line added in Task 1, add:
```yaml
      - path: Sources/WorktreeHookRunner.swift
```

- [ ] **Step 2: Write the failing tests**

Create `spike/seam1/Tests/WorktreeHookRunnerTests.swift`:
```swift
import XCTest
@testable import Shepherd

final class WorktreeHookRunnerTests: XCTestCase {
    func testHookEnvironmentMapsAllVars() {
        let env = WorktreeHookRunner.hookEnvironment(
            worktreeDir: "/wt/repo/feature",
            src: "/src/repo",
            branch: "feature",
            name: "feature",
            repoName: "repo")
        XCTAssertEqual(env["WORKTREE_DIR"], "/wt/repo/feature")
        XCTAssertEqual(env["WORKTREE_SRC"], "/src/repo")
        XCTAssertEqual(env["WORKTREE_BRANCH"], "feature")
        XCTAssertEqual(env["WORKTREE_NAME"], "feature")
        XCTAssertEqual(env["REPO_NAME"], "repo")
        XCTAssertEqual(env.count, 5)
    }
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run the **Build** command (adds the source via xcodegen), then the **Unit tests** command. Expected: FAIL — "cannot find 'WorktreeHookRunner' in scope".

- [ ] **Step 4: Write the implementation**

Create `spike/seam1/Sources/WorktreeHookRunner.swift`:
```swift
import Foundation

// MARK: - Pure core (unit-tested)

/// Runs a workspace's worktree-creation hook: user bash that fires right after
/// `git worktree add` succeeds, with the new worktree as cwd and the WORKTREE_* /
/// REPO_NAME vars in the environment.
enum WorktreeHookRunner {
    static func hookEnvironment(worktreeDir: String, src: String, branch: String,
                                name: String, repoName: String) -> [String: String] {
        ["WORKTREE_DIR": worktreeDir,
         "WORKTREE_SRC": src,
         "WORKTREE_BRANCH": branch,
         "WORKTREE_NAME": name,
         "REPO_NAME": repoName]
    }

    struct HookResult { let exitCode: Int32; let output: String }

    // MARK: - Process shell (Foundation only; runs off-main)

    /// Run `script` as one `bash -lc` invocation in `cwd` with `env` overlaid on the
    /// inherited environment. Captures merged stdout+stderr. Never throws — a launch
    /// failure returns exitCode -1 with the error text.
    static func run(script: String, cwd: String, env: [String: String]) -> HookResult {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = ["-lc", script]
        p.currentDirectoryURL = URL(fileURLWithPath: cwd)
        var environment = ProcessInfo.processInfo.environment
        for (k, v) in env { environment[k] = v }
        p.environment = environment
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        do {
            try p.run()
        } catch {
            return HookResult(exitCode: -1, output: "Failed to launch hook: \(error.localizedDescription)")
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return HookResult(exitCode: p.terminationStatus, output: String(data: data, encoding: .utf8) ?? "")
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run the **Unit tests** command. Expected: `WorktreeHookRunnerTests` PASS.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/WorktreeHookRunner.swift \
        spike/seam1/Tests/WorktreeHookRunnerTests.swift \
        spike/seam1/project.yml
git commit -m "feat(worktree): WorktreeHookRunner — env builder + bash runner

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Persist `Workspace.worktreeHook`

**Files:**
- Modify: `spike/seam1/Sources/Workspace.swift:5-30`
- Modify: `spike/seam1/Sources/Persistence.swift:11-58`
- Modify: `spike/seam1/Tests/PersistenceTests.swift`

**Interfaces:**
- Consumes: `Workspace`, `PersistedWorkspace`, `snapshotState`, `buildWorkspaces` (Task uses existing signatures).
- Produces: `Workspace.worktreeHook: String?` (init param, defaulted `nil`); `PersistedWorkspace.worktreeHook: String?`.

- [ ] **Step 1: Write the failing tests**

Append to `spike/seam1/Tests/PersistenceTests.swift` (inside the existing test class):
```swift
    func testWorktreeHookSurvivesRoundTrip() {
        let ws = Workspace(userTitle: "W", tabs: [Tab(pane: Pane())],
                           worktreeHook: "cp \"$WORKTREE_SRC/.env\" \"$WORKTREE_DIR/.env\"")
        let snap = snapshotState([ws], selectedWorkspaceID: ws.id)
        let rebuilt = buildWorkspaces(from: snap)
        XCTAssertEqual(rebuilt.first?.worktreeHook,
                       "cp \"$WORKTREE_SRC/.env\" \"$WORKTREE_DIR/.env\"")
    }

    func testOldBlobDecodesWithNilHook() throws {
        let json = #"{"selectedTabIndex":0,"tabs":[]}"#.data(using: .utf8)!
        let pw = try JSONDecoder().decode(PersistedWorkspace.self, from: json)
        XCTAssertNil(pw.worktreeHook)
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run the **Unit tests** command. Expected: FAIL — "extra argument 'worktreeHook' in call" (Workspace init) and "value of type 'PersistedWorkspace' has no member 'worktreeHook'".

- [ ] **Step 3: Add the field to `Workspace`**

In `spike/seam1/Sources/Workspace.swift`, after the `defaultPath` stored property (line 11) add:
```swift
    var worktreeHook: String? = nil   // bash run right after this workspace's worktrees are created; nil = none
```
Then extend the initializer — add the parameter after `defaultPath: String? = nil,` in the signature and assign it. The updated `init` signature:
```swift
    init(id: String = UUID().uuidString, userTitle: String? = nil,
         tabs: [Tab], selectedTabID: String? = nil, collapsed: Bool = false,
         defaultPath: String? = nil, worktreeHook: String? = nil,
         remoteHostID: String? = nil, remoteWorkspaceID: String? = nil) {
        self.id = id
        self.userTitle = userTitle
        self.tabs = tabs
        self.selectedTabID = selectedTabID ?? tabs.first?.tabID
        self.collapsed = collapsed
        self.defaultPath = defaultPath
        self.worktreeHook = worktreeHook
        self.remoteHostID = remoteHostID
        self.remoteWorkspaceID = remoteWorkspaceID
    }
```

- [ ] **Step 4: Persist the field**

In `spike/seam1/Sources/Persistence.swift`:

Add to `PersistedWorkspace` (after `defaultPath`):
```swift
    var worktreeHook: String?      // optional so pre-feature blobs still decode (nil = none)
```

In `snapshotState`, add to the `PersistedWorkspace(...)` initializer call (after `defaultPath: ws.defaultPath`):
```swift
            worktreeHook: ws.worktreeHook,
```
Wait — `defaultPath` is currently the last argument. Add `worktreeHook: ws.worktreeHook` as the new last argument:
```swift
        return PersistedWorkspace(
            userTitle: ws.userTitle,
            selectedTabIndex: selTab,
            tabs: ws.tabs.map { PersistedTab(userTitle: $0.userTitle, root: $0.root) },
            collapsed: ws.collapsed,
            defaultPath: ws.defaultPath,
            worktreeHook: ws.worktreeHook)
```

In `buildWorkspaces`, extend the `Workspace(...)` call to pass it:
```swift
        return Workspace(userTitle: pw.userTitle, tabs: tabs, selectedTabID: selID,
                         collapsed: pw.collapsed ?? false, defaultPath: pw.defaultPath,
                         worktreeHook: pw.worktreeHook)
```

- [ ] **Step 5: Run tests to verify they pass**

Run the **Unit tests** command. Expected: both new tests PASS; existing `PersistenceTests` still PASS.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/Workspace.swift spike/seam1/Sources/Persistence.swift \
        spike/seam1/Tests/PersistenceTests.swift
git commit -m "feat(workspace): persist per-workspace worktreeHook

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Run the hook in `newWorktreeTab` + `setWorktreeHook` store method

**Files:**
- Modify: `spike/seam1/Sources/AgentStore.swift:322-349` (`newWorktreeTab`), and add `setWorktreeHook` near `setWorkspaceDirectory` (line ~296).

**Interfaces:**
- Consumes: `WorktreeHookRunner.hookEnvironment`, `WorktreeHookRunner.run` (Task 2); `Workspace.worktreeHook` (Task 3); existing `Git.addWorktree`, `finishProvisioning`, `showWorktreeError`, `save`.
- Produces: `func setWorktreeHook(_ id: String, to script: String?)` on `AgentStore`.

- [ ] **Step 1: Add the `setWorktreeHook` store method**

In `spike/seam1/Sources/AgentStore.swift`, immediately after `setWorkspaceDirectory(_:to:)` (ends ~line 305), add:
```swift
    /// Set (or clear) the bash the workspace runs after creating a worktree. Local-only
    /// (remote/mirror worktree hooks are deferred). Empty/whitespace clears it.
    func setWorktreeHook(_ id: String, to script: String?) {
        guard let i = workspaces.firstIndex(where: { $0.id == id }) else { return }
        let trimmed = script?.trimmingCharacters(in: .whitespacesAndNewlines)
        workspaces[i].worktreeHook = (trimmed?.isEmpty ?? true) ? nil : script
        save()
    }
```

- [ ] **Step 2: Add the `tail` helper**

In `spike/seam1/Sources/AgentStore.swift`, next to `showWorktreeError` (line ~375), add:
```swift
    /// Last `n` non-empty-trimmed lines of hook output, for a compact error alert.
    private static func tail(_ s: String, lines n: Int) -> String {
        let all = s.split(separator: "\n", omittingEmptySubsequences: false)
        return all.suffix(n).joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }
```

- [ ] **Step 3: Run the hook inside the off-main block**

Replace the body of the `DispatchQueue.global(...)` closure in `newWorktreeTab` (lines 336-348) with:
```swift
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let result = Git.addWorktree(dest: dest, name: trimmed, in: repoDir)
            var hookFailure: String? = nil
            if result.ok {
                let hook = ws.worktreeHook?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if !hook.isEmpty {
                    let env = WorktreeHookRunner.hookEnvironment(
                        worktreeDir: dest, src: repoDir, branch: trimmed, name: trimmed,
                        repoName: (repoDir as NSString).lastPathComponent)
                    let r = WorktreeHookRunner.run(script: hook, cwd: dest, env: env)
                    if r.exitCode != 0 { hookFailure = r.output }
                }
            }
            DispatchQueue.main.async {
                guard let self else { return }
                if result.ok {
                    self.finishProvisioning(paneID: provisional.paneID)
                    if let out = hookFailure {
                        let tail = Self.tail(out, lines: 20)
                        self.showWorktreeError("Worktree hook reported an error",
                            detail: tail.isEmpty ? "The hook exited with a non-zero status." : tail)
                    }
                } else {
                    self.closeTab(provisional.tabID, inWorkspace: wsID)
                    self.showWorktreeError("Couldn't create worktree",
                                           detail: result.err.isEmpty ? "git worktree add failed." : result.err)
                }
            }
        }
```

- [ ] **Step 4: Build**

Run the **Build** command. Expected: `** BUILD SUCCEEDED **`. (No xcodegen needed — no files added; but running it is harmless.)

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/AgentStore.swift
git commit -m "feat(worktree): run per-workspace hook after worktree add (warn-keep on failure)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Settings scene + `SettingsView` shell

**Files:**
- Create: `spike/seam1/Sources/SettingsView.swift`
- Modify: `spike/seam1/Sources/ShepherdApp.swift:28-89` (add `Settings` scene)

**Interfaces:**
- Consumes: `AgentStore.shared`, `Theme`.
- Produces: `struct SettingsView: View` with an internal `enum SettingsTab`, and five subviews created empty here and filled in Tasks 6–10: `AppearanceSettings`, `WorkspaceSettings`, `RemoteSettings`, `KeybindingSettings`, `GeneralSettings`.

- [ ] **Step 1: Create the shell with stub tabs**

Create `spike/seam1/Sources/SettingsView.swift`:
```swift
import SwiftUI

/// The unified Settings window (⌘,). A themed TabView surfacing appearance, workspaces,
/// remote sharing, keybindings, and general behavior.
struct SettingsView: View {
    @EnvironmentObject var store: AgentStore

    var body: some View {
        TabView {
            AppearanceSettings()
                .tabItem { Label("Appearance", systemImage: "paintbrush") }
            WorkspaceSettings()
                .tabItem { Label("Workspaces", systemImage: "square.stack") }
            RemoteSettings()
                .tabItem { Label("Remote", systemImage: "antenna.radiowaves.left.and.right") }
            KeybindingSettings()
                .tabItem { Label("Keybindings", systemImage: "keyboard") }
            GeneralSettings()
                .tabItem { Label("General", systemImage: "gearshape") }
        }
        .frame(width: 640, height: 460)
    }
}

/// Shared chrome for a settings tab: a titled, padded, scrollable column.
struct SettingsPane<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text(title).font(.ui(15, .semibold)).foregroundStyle(Theme.text)
                content
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(24)
        }
    }
}

// Stubs — filled in later tasks.
struct AppearanceSettings: View { var body: some View { SettingsPane(title: "Appearance") { EmptyView() } } }
struct WorkspaceSettings: View { var body: some View { SettingsPane(title: "Workspaces") { EmptyView() } } }
struct RemoteSettings: View { var body: some View { SettingsPane(title: "Remote") { EmptyView() } } }
struct KeybindingSettings: View { var body: some View { SettingsPane(title: "Keybindings") { EmptyView() } } }
struct GeneralSettings: View { var body: some View { SettingsPane(title: "General") { EmptyView() } } }
```

- [ ] **Step 2: Add the `Settings` scene to `ShepherdApp`**

In `spike/seam1/Sources/ShepherdApp.swift`, after the `WindowGroup { ... }.windowStyle(...).commands { ... }` block closes (after line 88, before `body`'s closing brace on line 89), add a second scene:
```swift
        Settings {
            SettingsView()
                .environmentObject(AgentStore.shared)
                .preferredColorScheme(.dark)
        }
```

- [ ] **Step 3: Build**

Run the **Build** command (regenerates via xcodegen — `SettingsView.swift` is a new app-target file, picked up by the `Sources` glob). Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 4: Commit**

```bash
git add spike/seam1/Sources/SettingsView.swift spike/seam1/Sources/ShepherdApp.swift
git commit -m "feat(settings): Settings scene (⌘,) + five-tab SettingsView shell

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Appearance tab (theme / font / size → config + reload)

**Files:**
- Modify: `spike/seam1/Sources/SettingsView.swift` (replace `AppearanceSettings` stub)

**Interfaces:**
- Consumes: `ShepherdConfigWriter.set(_:)` + `ConfigEdit` (Task 1); `parseShepherdConfig` + `ShepherdConfig`/`ThemeMode` (existing, `WorktreeService.swift`); `GhosttyApp.shared.reloadConfig()` (existing); `Theme.monoFontName` (existing).

- [ ] **Step 1: Implement `AppearanceSettings`**

Replace the `AppearanceSettings` stub in `SettingsView.swift` with:
```swift
struct AppearanceSettings: View {
    @State private var theme: ThemeMode = .dark
    @State private var fontFamily: String = ""
    @State private var fontSize: Double = 13
    @State private var errorText: String?

    var body: some View {
        SettingsPane(title: "Appearance") {
            Picker("Theme", selection: $theme) {
                Text("Dark").tag(ThemeMode.dark)
                Text("Light").tag(ThemeMode.light)
                Text("Warm").tag(ThemeMode.warm)
            }
            .pickerStyle(.segmented)
            .onChange(of: theme) { _, new in
                writeEdits([ConfigEdit(key: "theme", kind: .shepherd, value: value(for: new))])
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Terminal font").font(.ui(12, .medium)).foregroundStyle(Theme.textDim)
                HStack {
                    TextField("Font family (e.g. JetBrains Mono)", text: $fontFamily)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit {
                            writeEdits([ConfigEdit(key: "font-family", kind: .native,
                                                   value: fontFamily.trimmingCharacters(in: .whitespaces))])
                        }
                    Stepper(value: $fontSize, in: 8...32, step: 1) {
                        Text("Size \(Int(fontSize))").font(.ui(12)).foregroundStyle(Theme.text)
                    }
                    .onChange(of: fontSize) { _, new in
                        writeEdits([ConfigEdit(key: "font-size", kind: .native, value: String(Int(new)))])
                    }
                }
                Text("Applies live. Chrome font updates on next relaunch.")
                    .font(.ui(11)).foregroundStyle(Theme.textDim)
            }

            if let e = errorText {
                Text(e).font(.ui(11)).foregroundStyle(Theme.error)
            }
        }
        .onAppear(perform: load)
    }

    private func value(for m: ThemeMode) -> String {
        switch m { case .dark: return "dark"; case .light: return "light"; case .warm: return "warm" }
    }

    private func load() {
        let path = (NSHomeDirectory() as NSString).appendingPathComponent(".config/shepherd/config")
        let contents = (try? String(contentsOfFile: path, encoding: .utf8)) ?? ""
        theme = parseShepherdConfig(contents).theme
        fontFamily = Theme.monoFontName ?? ""
        fontSize = Double(nativeInt(contents, key: "font-size") ?? 13)
    }

    private func nativeInt(_ contents: String, key: String) -> Int? {
        for raw in contents.split(whereSeparator: \.isNewline) {
            let t = raw.trimmingCharacters(in: .whitespaces)
            guard !t.hasPrefix("#"), let eq = t.firstIndex(of: "=") else { continue }
            if t[..<eq].trimmingCharacters(in: .whitespaces) == key {
                return Int(t[t.index(after: eq)...].trimmingCharacters(in: .whitespaces))
            }
        }
        return nil
    }

    private func writeEdits(_ edits: [ConfigEdit]) {
        do {
            try ShepherdConfigWriter.set(edits)
            GhosttyApp.shared.reloadConfig()
            errorText = nil
        } catch {
            errorText = "Couldn't write config: \(error.localizedDescription)"
        }
    }
}
```
> Note: this references `Theme.error`. If `Theme` has no `error` token, use `Theme.blocked` or the closest existing red token — check `Theme.swift` and substitute the real name.

- [ ] **Step 2: Build**

Run the **Build** command. Expected: `** BUILD SUCCEEDED **`. If it fails on `Theme.error`, replace with the real red token from `Theme.swift` and rebuild.

- [ ] **Step 3: Commit**

```bash
git add spike/seam1/Sources/SettingsView.swift
git commit -m "feat(settings): Appearance tab — theme/font round-trip + live reload

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Workspaces tab (default dir + worktree hook editor)

**Files:**
- Modify: `spike/seam1/Sources/SettingsView.swift` (replace `WorkspaceSettings` stub)

**Interfaces:**
- Consumes: `store.workspaces`, `store.selectedWorkspaceID`, `store.setWorkspaceDirectory(_:to:)` (existing), `store.setWorktreeHook(_:to:)` (Task 4), `Workspace.displayName(index:)`.

- [ ] **Step 1: Implement `WorkspaceSettings`**

Replace the `WorkspaceSettings` stub with:
```swift
struct WorkspaceSettings: View {
    @EnvironmentObject var store: AgentStore
    @State private var selectedID: String = ""
    @State private var dirText: String = ""
    @State private var hookText: String = ""

    private var current: Workspace? { store.workspaces.first { $0.id == selectedID } }

    var body: some View {
        SettingsPane(title: "Workspaces") {
            Picker("Workspace", selection: $selectedID) {
                ForEach(Array(store.workspaces.enumerated()), id: \.element.id) { idx, ws in
                    Text(ws.displayName(index: idx)).tag(ws.id)
                }
            }
            .onChange(of: selectedID) { _, _ in loadFields() }

            VStack(alignment: .leading, spacing: 6) {
                Text("Default directory").font(.ui(12, .medium)).foregroundStyle(Theme.textDim)
                TextField("~/path/to/repo", text: $dirText)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { store.setWorkspaceDirectory(selectedID, to: dirText) }
                Text("New tabs and worktrees in this workspace open here.")
                    .font(.ui(11)).foregroundStyle(Theme.textDim)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Worktree hook").font(.ui(12, .medium)).foregroundStyle(Theme.textDim)
                Text("Bash run right after a worktree is created (cwd = the new worktree). Available: $WORKTREE_DIR, $WORKTREE_SRC, $WORKTREE_BRANCH, $WORKTREE_NAME, $REPO_NAME.")
                    .font(.ui(11)).foregroundStyle(Theme.textDim)
                TextEditor(text: $hookText)
                    .font(.mono(12))
                    .frame(minHeight: 140)
                    .padding(6)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Theme.bg.opacity(0.5)))
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.divider, lineWidth: 1))
                    .onChange(of: hookText) { _, new in store.setWorktreeHook(selectedID, to: new) }
                Text("A non-zero exit warns but keeps the worktree.")
                    .font(.ui(11)).foregroundStyle(Theme.textDim)
            }
        }
        .onAppear {
            selectedID = store.selectedWorkspaceID ?? store.workspaces.first?.id ?? ""
            loadFields()
        }
    }

    private func loadFields() {
        dirText = current?.defaultPath ?? ""
        hookText = current?.worktreeHook ?? ""
    }
}
```
> Note: verify `store.selectedWorkspaceID` and `store.workspaces` are accessible (public/internal `@Published`). They are used across the app already; if `selectedWorkspaceID` is not directly readable, use `store.workspaces.first?.id`.

- [ ] **Step 2: Build**

Run the **Build** command. Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 3: Commit**

```bash
git add spike/seam1/Sources/SettingsView.swift
git commit -m "feat(settings): Workspaces tab — default dir + worktree hook editor

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Remote tab (surfaced)

**Files:**
- Modify: `spike/seam1/Sources/SettingsView.swift` (replace `RemoteSettings` stub)

**Interfaces:**
- Consumes: `store.isServing` (get), `store.setServing(_:)`, `store.showingRemoteDevices` (existing).

- [ ] **Step 1: Implement `RemoteSettings`**

Replace the `RemoteSettings` stub with:
```swift
struct RemoteSettings: View {
    @EnvironmentObject var store: AgentStore
    @State private var serving: Bool = false

    var body: some View {
        SettingsPane(title: "Remote") {
            Toggle("Serve to remote devices", isOn: $serving)
                .onChange(of: serving) { _, on in store.setServing(on) }
            Text("When on, paired devices can view and drive this Mac's sessions.")
                .font(.ui(11)).foregroundStyle(Theme.textDim)

            Button("Add remote device…") { store.showingRemoteDevices = true }

            Text("Pairing codes and the device list appear in the pairing sheet.")
                .font(.ui(11)).foregroundStyle(Theme.textDim)
        }
        .onAppear { serving = store.isServing }
    }
}
```
> Note: `store.isServing` reads UserDefaults each call and isn't `@Published`, so mirror it into local `@State` on appear (done above). This tab intentionally reuses the existing pairing sheet rather than re-implementing the device list.

- [ ] **Step 2: Build**

Run the **Build** command. Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 3: Commit**

```bash
git add spike/seam1/Sources/SettingsView.swift
git commit -m "feat(settings): Remote tab — serve toggle + add-device (surfaced)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Keybindings tab (read-only, TBD)

**Files:**
- Modify: `spike/seam1/Sources/SettingsView.swift` (replace `KeybindingSettings` stub)

**Interfaces:**
- Consumes: `ShortcutCatalog.all` → `[ShortcutCommand]` (`.title`, `.display`, `.category`); `ShortcutCategory` (`CaseIterable`, `.rawValue`).

- [ ] **Step 1: Implement `KeybindingSettings`**

Replace the `KeybindingSettings` stub with:
```swift
struct KeybindingSettings: View {
    var body: some View {
        SettingsPane(title: "Keybindings") {
            Text("Rebinding coming soon. These are the current defaults.")
                .font(.ui(11)).foregroundStyle(Theme.textDim)

            ForEach(ShortcutCategory.allCases, id: \.self) { category in
                let cmds = ShortcutCatalog.all.filter { $0.category == category }
                if !cmds.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(category.rawValue).font(.ui(12, .semibold)).foregroundStyle(Theme.text)
                        ForEach(cmds) { cmd in
                            HStack {
                                Text(cmd.title).font(.ui(12)).foregroundStyle(Theme.text)
                                Spacer()
                                Text(cmd.display).font(.mono(12)).foregroundStyle(Theme.textDim)
                            }
                        }
                    }
                }
            }
        }
    }
}
```

- [ ] **Step 2: Build**

Run the **Build** command. Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 3: Commit**

```bash
git add spike/seam1/Sources/SettingsView.swift
git commit -m "feat(settings): Keybindings tab — read-only ShortcutCatalog (rebinding TBD)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: General tab (Stay Awake + worktree base + panes + open config)

**Files:**
- Modify: `spike/seam1/Sources/SettingsView.swift` (replace `GeneralSettings` stub)

**Interfaces:**
- Consumes: `SleepGuard.shared` (`.mode: CaffeinateMode`, `.thermalAutoSleep: Bool`) (existing); `ShepherdConfigWriter.set(_:)` + `GhosttyApp.shared.reloadConfig()`; `parseShepherdConfig(_:).worktreeBase`; UserDefaults key `shepherd.panes.defaultCollapsed`; `NSWorkspace` to open the config file.

- [ ] **Step 1: Implement `GeneralSettings`**

Replace the `GeneralSettings` stub with:
```swift
struct GeneralSettings: View {
    @ObservedObject private var sleep = SleepGuard.shared
    @State private var worktreeBase: String = ""
    @State private var panesCollapsed: Bool = UserDefaults.standard.bool(forKey: "shepherd.panes.defaultCollapsed")

    private var configPath: String {
        (NSHomeDirectory() as NSString).appendingPathComponent(".config/shepherd/config")
    }

    var body: some View {
        SettingsPane(title: "General") {
            VStack(alignment: .leading, spacing: 6) {
                Text("Stay awake").font(.ui(12, .medium)).foregroundStyle(Theme.textDim)
                Picker("Mode", selection: Binding(get: { sleep.mode }, set: { sleep.mode = $0 })) {
                    Text("Off").tag(CaffeinateMode.off)
                    Text("While agents working").tag(CaffeinateMode.whileAgents)
                    Text("Always (app open)").tag(CaffeinateMode.always)
                }
                .pickerStyle(.inline)
                Toggle("Sleep if running hot under a closed lid",
                       isOn: Binding(get: { sleep.thermalAutoSleep }, set: { sleep.thermalAutoSleep = $0 }))
            }

            Toggle("New split panes start collapsed in the sidebar", isOn: $panesCollapsed)
                .onChange(of: panesCollapsed) { _, on in
                    UserDefaults.standard.set(on, forKey: "shepherd.panes.defaultCollapsed")
                }

            VStack(alignment: .leading, spacing: 6) {
                Text("Worktree base directory").font(.ui(12, .medium)).foregroundStyle(Theme.textDim)
                TextField("~/.shepherd/worktrees", text: $worktreeBase)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit {
                        let v = worktreeBase.trimmingCharacters(in: .whitespaces)
                        if !v.isEmpty {
                            try? ShepherdConfigWriter.set([ConfigEdit(key: "worktree-base", kind: .shepherd, value: v)])
                        }
                    }
            }

            Button("Open config file") {
                NSWorkspace.shared.open(URL(fileURLWithPath: configPath))
            }
        }
        .onAppear {
            let contents = (try? String(contentsOfFile: configPath, encoding: .utf8)) ?? ""
            worktreeBase = parseShepherdConfig(contents).worktreeBase ?? ""
        }
    }
}
```
> Note: import AppKit is already transitively available via SwiftUI on macOS for `NSWorkspace`; if the build complains, add `import AppKit` at the top of `SettingsView.swift`.

- [ ] **Step 2: Build**

Run the **Build** command. Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 3: Run the full unit-test suite (regression)**

Run the **Unit tests** command. Expected: all `ShepherdModelTests` PASS (nothing regressed).

- [ ] **Step 4: Commit**

```bash
git add spike/seam1/Sources/SettingsView.swift
git commit -m "feat(settings): General tab — stay-awake, worktree base, panes, open config

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Docs — update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (repo layout / done-vs-deferred / app source files list)

**Interfaces:** none (docs only).

- [ ] **Step 1: Update the source-file list and feature summary**

In `CLAUDE.md`, add bullets under "App source files" for `SettingsView.swift`, `ShepherdConfigWriter.swift`, `WorktreeHookRunner.swift`; note the `Settings` scene + ⌘, in the `ShepherdApp.swift` bullet; and add a "unified Settings window + per-workspace worktree hook" line under "Done". Keep entries terse and in the established voice.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: note Settings window + worktree hook in CLAUDE.md

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Settings window shell + ⌘, → Task 5. ✓
- Appearance (theme/font write-back + reload) → Task 6. ✓
- Workspaces (default dir + worktree hook editor) → Task 7. ✓
- Remote (surfaced) → Task 8. ✓
- Keybindings (read-only, TBD) → Task 9. ✓
- General (stay-awake, worktree-base, panes, open-config) → Task 10. ✓
- Worktree hook subsystem: `ShepherdConfigWriter` isn't the hook — the hook is `WorktreeHookRunner` (Task 2) + `Workspace.worktreeHook` persistence (Task 3) + `newWorktreeTab` wiring + `setWorktreeHook` (Task 4). ✓
- Env vars (`WORKTREE_*`, `REPO_NAME`) → Task 2. ✓
- Warn-but-keep failure semantics → Task 4 (`finishProvisioning` always; non-fatal alert). ✓
- Persistence optional-field back-compat → Task 3 (`testOldBlobDecodesWithNilHook`). ✓
- Config round-trip preserves hand-written file → Task 1 (`testPreservesUnrelatedLinesAndComments`). ✓

**Placeholder scan:** No "TBD/TODO" in executable steps. The Keybindings "Rebinding coming soon" text is intended UI copy (a scoped deferral), not a plan placeholder. Two `> Note:` call-outs (Theme.error token name; `selectedWorkspaceID` accessibility) instruct the implementer to verify a real symbol against the codebase and substitute — these are guardrails, not gaps.

**Type consistency:** `ConfigEdit`/`ConfigKeyKind`/`ShepherdConfigWriter.apply`/`.set` consistent across Tasks 1, 6, 10. `WorktreeHookRunner.hookEnvironment`/`.run`/`HookResult` consistent across Tasks 2, 4. `Workspace.worktreeHook` + `PersistedWorkspace.worktreeHook` consistent across Tasks 3, 4, 7. `setWorktreeHook(_:to:)` defined Task 4, used Task 7. Subview type names (`AppearanceSettings` etc.) defined as stubs Task 5, replaced 6–10.

**Ordering:** Backend (Tasks 1–4) precedes UI (5–10); the worktree hook is functionally complete after Task 4 (settable via UI at Task 7). Each task ends with an independently buildable/testable, committed deliverable.
