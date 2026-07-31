# New-tab composer (⌘T) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the instant `⌘T` shell tab with a prompt-first composer that names the tab, picks its workspace, optionally creates a worktree, and hands a prompt to a freshly launched `claude`.

**Architecture:** All policy lives in one pure struct (`NewTabRequest`) that the SwiftUI card only draws; the prompt reaches the agent through a temp file read back by a single-line shell command seeded into libghostty's `initial_input`, reusing the exact seam `claude --resume` already uses.

**Tech Stack:** Swift 5.9 / SwiftUI / AppKit, xcodegen, XCTest (`ShepherdModelTests`), libghostty via `GhosttyKit.xcframework`.

**Spec:** [`docs/superpowers/specs/2026-07-31-new-tab-composer-design.md`](../specs/2026-07-31-new-tab-composer-design.md)

## Global Constraints

- All work happens in `spike/seam1/` (that directory *is* the app, despite the name). Paths below are relative to it unless stated otherwise.
- **`xcodegen generate` after adding or removing any source file**, or the file is not compiled and you get `cannot find X in scope` at build time.
- A **new compiled source** used by tests must be added to the `ShepherdModelTests` target's explicit `sources:` list in `project.yml`. Test files under `Tests/` are picked up by the `- path: Tests` glob and need no entry.
- **Build before test in a cold `-derivedDataPath`** — `ShepherdModelTests` declares no dependency on the `Shepherd` target, so a first `test` invocation can die with `unable to resolve module dependency: 'Shepherd'`.
- **`-only-testing:` on a suite the project does not know about reports `** TEST SUCCEEDED **` vacuously.** A pass only counts once the test count moves: `grep -c "Test Case .* passed"`.
- **Never `killall Shepherd`** — the user runs Shepherd as their daily terminal. Verify by compiling and running unit tests; leave runtime checks to the user (Task 7 hands them a checklist).
- Comments: only the non-obvious *why*, one line max. Never narrate the change or recap the bug history.
- Commit messages end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

**Canonical commands** (run from `spike/seam1/`):

```bash
# Build
xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build

# Test one suite
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  -only-testing:ShepherdModelTests/SUITE test 2>&1 | grep -E "Test Case|TEST (SUCCEEDED|FAILED)"
```

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `Sources/NewTabRequest.swift` | create | **Pure.** The composer's value + every rule about it: slugging, mirror-until-edited, `canCreate`, availability, hints. |
| `Sources/AgentLaunch.swift` | create | Pure `command(promptFile:program:)` + Foundation `prepare(prompt:)` / `launchCommand(prompt:)`. |
| `Sources/NewTabComposer.swift` | create | The SwiftUI card. Draws only — asks `NewTabRequest` every question. |
| `Tests/NewTabRequestTests.swift` | create | Slugging, detach, `canCreate` matrix, availability. |
| `Tests/AgentLaunchTests.swift` | create | Real-`bash` round-trip of the launch command. |
| `Sources/SplitTree.swift` | modify | `+ Pane.initialCommand` (transient — `CodingKeys` untouched). |
| `Sources/WorktreeService.swift` | modify | `ShepherdConfig.newTabWorktree` + its parse. |
| `Sources/AgentStore.swift` | modify | `promptingNewTab`, `newTabSeedWorkspaceID`, `create(_:)`, `newTabTargets()`, `newTabWorktreeDefault()`, `initialCommand` params, `takeResumeInput` → `takeInitialInput`. |
| `Sources/GhosttyTerminal.swift` | modify | Call `takeInitialInput`. |
| `Sources/ContentView.swift` | modify | Present the composer overlay. |
| `Sources/ShepherdApp.swift` | modify | `.newTab` opens the composer. |
| `Sources/SidebarView.swift` | modify | Folder hover-`+` opens the composer; delete the two-item menu and `promptNewWorktree`. |
| `Sources/WorkspaceEmptyView.swift` | modify | One button opens the composer; delete `promptNewWorktree` + the git probe. |
| `Tests/SplitTreeTests.swift` | modify | `initialCommand` does not persist. |
| `Tests/WorktreeServiceTests.swift` | modify | `new-tab-worktree` parse. |
| `project.yml` | modify | Two `sources:` entries on `ShepherdModelTests`. |

---

### Task 1: `NewTabRequest` — the pure model

**Files:**
- Create: `Sources/NewTabRequest.swift`
- Create: `Tests/NewTabRequestTests.swift`
- Modify: `project.yml` (add `- path: Sources/NewTabRequest.swift` to `ShepherdModelTests` `sources:`, after `- path: Sources/WorktreeService.swift`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `struct NewTabTarget: Equatable { let workspaceID: String; let name: String; let isRemote: Bool; let isGitRepo: Bool }` with `init(workspaceID:name:isRemote:isGitRepo:)`
  - `struct NewTabRequest: Equatable` with `var target: NewTabTarget`, `var title: String`, `var prompt: String`, `var worktree: Bool`, `private(set) var branchEdited: Bool`, `private(set) var typedBranch: String`
  - `init(target: NewTabTarget, worktree: Bool = false)`
  - `mutating func setBranch(_ s: String)`, `mutating func retarget(_ t: NewTabTarget)`
  - computed: `var branch: String`, `var worktreeAvailable: Bool`, `var promptAvailable: Bool`, `var usesWorktree: Bool`, `var canCreate: Bool`, `var effectiveTitle: String?`, `var effectivePrompt: String`, `var worktreeHint: String?`, `var promptHint: String?`, `var createHint: String?`
  - `static func slug(_ s: String) -> String`

- [ ] **Step 1: Write the failing tests**

Create `Tests/NewTabRequestTests.swift`:

```swift
import XCTest
@testable import Shepherd

private func localRepo() -> NewTabTarget {
    NewTabTarget(workspaceID: "w1", name: "shepherd", isRemote: false, isGitRepo: true)
}
private func localPlain() -> NewTabTarget {
    NewTabTarget(workspaceID: "w2", name: "notes", isRemote: false, isGitRepo: false)
}
private func mirror() -> NewTabTarget {
    NewTabTarget(workspaceID: "w3", name: "mac-mini", isRemote: true, isGitRepo: true)
}

final class NewTabRequestTests: XCTestCase {

    // MARK: slug

    func testSlugLowercasesAndHyphenatesSpaces() {
        XCTAssertEqual(NewTabRequest.slug("Fix Auth Bug"), "fix-auth-bug")
    }

    func testSlugDropsCharactersGitRefusesInARefName() {
        XCTAssertEqual(NewTabRequest.slug("wip: ~caret^ [x] q?"), "wip-caret-x-q")
    }

    func testSlugCollapsesRunsAndTrimsEdges() {
        XCTAssertEqual(NewTabRequest.slug("  --hello   world--  "), "hello-world")
    }

    func testSlugKeepsSlashesAndDotsGitAllows() {
        XCTAssertEqual(NewTabRequest.slug("feature/new.tab"), "feature/new.tab")
    }

    func testSlugRemovesDoubleDotsAndLockSuffix() {
        XCTAssertEqual(NewTabRequest.slug("a..b.lock"), "a-b")
    }

    func testSlugOfEmptyIsEmpty() {
        XCTAssertEqual(NewTabRequest.slug("   "), "")
    }

    // MARK: mirroring

    func testBranchMirrorsSluggedTitleUntilEdited() {
        var r = NewTabRequest(target: localRepo())
        r.title = "Fix Auth"
        XCTAssertEqual(r.branch, "fix-auth")
    }

    func testEditingBranchDetachesItFromTheTitle() {
        var r = NewTabRequest(target: localRepo())
        r.title = "Fix Auth"
        r.setBranch("auth-v2")
        r.title = "Something Else"
        XCTAssertEqual(r.branch, "auth-v2")
    }

    func testDetachIsOneWayEvenWhenClearedToEmpty() {
        var r = NewTabRequest(target: localRepo())
        r.title = "Fix Auth"
        r.setBranch("")
        XCTAssertEqual(r.branch, "")
    }

    // MARK: availability

    func testWorktreeUnavailableWithoutAGitRepo() {
        var r = NewTabRequest(target: localPlain(), worktree: true)
        r.title = "x"
        XCTAssertFalse(r.worktreeAvailable)
        XCTAssertFalse(r.usesWorktree)          // the toggle cannot force it on
        XCTAssertNotNil(r.worktreeHint)
    }

    func testWorktreeAvailableOnAMirrorWithAWiredPath() {
        let r = NewTabRequest(target: mirror())
        XCTAssertTrue(r.worktreeAvailable)
        XCTAssertNil(r.worktreeHint)
    }

    func testPromptUnavailableOnAMirror() {
        var r = NewTabRequest(target: mirror())
        r.prompt = "do the thing"
        XCTAssertFalse(r.promptAvailable)
        XCTAssertEqual(r.effectivePrompt, "")   // never sent where it cannot run
        XCTAssertNotNil(r.promptHint)
    }

    func testRetargetRecomputesAvailability() {
        var r = NewTabRequest(target: localRepo(), worktree: true)
        r.title = "x"
        XCTAssertTrue(r.usesWorktree)
        r.retarget(localPlain())
        XCTAssertFalse(r.usesWorktree)
    }

    // MARK: canCreate

    func testCanCreateWithEverythingEmpty() {
        XCTAssertTrue(NewTabRequest(target: localPlain()).canCreate)
    }

    func testCannotCreateWithWorktreeOnAndNoBranch() {
        var r = NewTabRequest(target: localRepo(), worktree: true)
        XCTAssertFalse(r.canCreate)
        XCTAssertNotNil(r.createHint)
        r.title = "Fix Auth"
        XCTAssertTrue(r.canCreate)
        XCTAssertNil(r.createHint)
    }

    func testCanCreateWithWorktreeOnButUnavailable() {
        let r = NewTabRequest(target: localPlain(), worktree: true)
        XCTAssertTrue(r.canCreate)              // it degrades to a plain tab
    }

    func testTitleWhitespaceOnlyIsNoTitle() {
        var r = NewTabRequest(target: localPlain())
        r.title = "   "
        XCTAssertNil(r.effectiveTitle)
        r.title = "  Notes "
        XCTAssertEqual(r.effectiveTitle, "Notes")
    }

    func testEffectivePromptIsTrimmed() {
        var r = NewTabRequest(target: localPlain())
        r.prompt = "\n  ship it \n"
        XCTAssertEqual(r.effectivePrompt, "ship it")
    }
}
```

- [ ] **Step 2: Add the file to the test target and regenerate**

In `project.yml`, under `ShepherdModelTests:` → `sources:`, add after the `Sources/WorktreeService.swift` line:

```yaml
      - path: Sources/NewTabRequest.swift
```

Then run `xcodegen generate`.

- [ ] **Step 3: Run the tests to verify they fail**

Run the build command, then the test command with `SUITE=NewTabRequestTests`.
Expected: FAIL — `cannot find 'NewTabRequest' in scope` at compile time.

- [ ] **Step 4: Write the implementation**

Create `Sources/NewTabRequest.swift`:

```swift
import Foundation

/// Where a composed tab is headed and what that destination allows. `isGitRepo` is
/// resolved by the caller (local: the default dir is a work tree; mirror: a path is
/// wired), so this stays pure.
struct NewTabTarget: Equatable {
    let workspaceID: String
    let name: String
    let isRemote: Bool
    let isGitRepo: Bool
}

/// Everything the ⌘T composer collects, and every rule about it. The view draws this
/// and decides nothing itself.
struct NewTabRequest: Equatable {
    var target: NewTabTarget
    var title: String = ""
    var prompt: String = ""
    var worktree: Bool = false

    private(set) var branchEdited = false
    private(set) var typedBranch = ""

    init(target: NewTabTarget, worktree: Bool = false) {
        self.target = target
        self.worktree = worktree
    }

    /// The branch mirrors a slugged title until the field is touched; after that it is
    /// the user's, even when they clear it.
    var branch: String { branchEdited ? typedBranch.trimmed : Self.slug(title) }

    mutating func setBranch(_ s: String) {
        typedBranch = s
        branchEdited = true
    }

    mutating func retarget(_ t: NewTabTarget) { target = t }

    var worktreeAvailable: Bool { target.isGitRepo }
    var promptAvailable: Bool { !target.isRemote }
    var usesWorktree: Bool { worktree && worktreeAvailable }

    var canCreate: Bool { usesWorktree ? !branch.isEmpty : true }

    var effectiveTitle: String? { title.trimmed.isEmpty ? nil : title.trimmed }
    var effectivePrompt: String { promptAvailable ? prompt.trimmed : "" }

    var worktreeHint: String? {
        worktreeAvailable ? nil : "set a directory for this workspace"
    }
    var promptHint: String? {
        promptAvailable ? nil : "prompts run on the host — not yet supported"
    }
    var createHint: String? { canCreate ? nil : "name the worktree" }

    /// A title turned into something `git check-ref-format` accepts: lowercase, runs of
    /// anything git refuses folded to one `-`, and the edge cases git rejects outright
    /// (`..`, a `.lock` suffix, leading/trailing punctuation) removed.
    static func slug(_ s: String) -> String {
        let allowed = Set("abcdefghijklmnopqrstuvwxyz0123456789-./_")
        var out = ""
        for ch in s.lowercased() {
            out.append(allowed.contains(ch) ? (ch == "_" ? "-" : ch) : "-")
        }
        while out.contains("..") { out = out.replacingOccurrences(of: "..", with: "-") }
        while out.contains("--") { out = out.replacingOccurrences(of: "--", with: "-") }
        while out.hasSuffix(".lock") { out.removeLast(5) }
        let edges = CharacterSet(charactersIn: "-./")
        return out.trimmingCharacters(in: edges)
    }
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
```

> If `String.trimmed` already exists in the module, the compiler will say so — delete this extension and keep the existing one.

- [ ] **Step 5: Run the tests to verify they pass**

Run the test command with `SUITE=NewTabRequestTests`.
Expected: PASS, and `grep -c "Test Case .* passed"` reports **18**.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/NewTabRequest.swift spike/seam1/Tests/NewTabRequestTests.swift spike/seam1/project.yml
git commit -m "$(cat <<'EOF'
feat(new-tab): NewTabRequest — the composer's rules, as a pure model

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `AgentLaunch` — the prompt's route to the agent

**Files:**
- Create: `Sources/AgentLaunch.swift`
- Create: `Tests/AgentLaunchTests.swift`
- Modify: `project.yml` (add `- path: Sources/AgentLaunch.swift`)

**Interfaces:**
- Consumes: `AppMode.supportPath(_:)` (already in the test target's sources).
- Produces:
  - `enum AgentLaunch`
  - `static func command(promptFile: String, program: String = "claude") -> String`
  - `static func prepare(prompt: String, dir: String = AppMode.supportPath("prompts")) -> String?`
  - `static func launchCommand(prompt: String, dir: String = AppMode.supportPath("prompts")) -> String?`

Why a file at all: a typed newline is an Enter press (`initial_input` is typed into the PTY), so a multi-line prompt typed directly would submit its first line and scatter the rest. `program:` exists so a test can substitute something that is not `claude`.

- [ ] **Step 1: Write the failing tests**

Create `Tests/AgentLaunchTests.swift`:

```swift
import XCTest
@testable import Shepherd

final class AgentLaunchTests: XCTestCase {

    private func tmpDir() -> String {
        let d = NSTemporaryDirectory() + "agentlaunch-" + UUID().uuidString
        try? FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
        return d
    }

    /// Run the generated command in a real shell with `printf` standing in for `claude`,
    /// so the assertion is what the agent's argv would actually receive.
    private func runThroughShell(_ command: String) -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = ["-c", command]
        let pipe = Pipe()
        p.standardOutput = pipe
        try? p.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(data: data, encoding: .utf8) ?? ""
    }

    func testPromptSurvivesTheShellVerbatim() {
        let dir = tmpDir()
        let prompt = "Fix the bug in `main`\n\nIt's \"urgent\" — cost is $500 and 100% mine."
        let file = AgentLaunch.prepare(prompt: prompt, dir: dir)
        XCTAssertNotNil(file)
        let cmd = AgentLaunch.command(promptFile: file!, program: "printf %s")
        XCTAssertEqual(runThroughShell(cmd), prompt)
    }

    func testCommandDeletesThePromptFileBeforeTheAgentStarts() {
        let dir = tmpDir()
        let file = AgentLaunch.prepare(prompt: "hello", dir: dir)!
        XCTAssertTrue(FileManager.default.fileExists(atPath: file))
        _ = runThroughShell(AgentLaunch.command(promptFile: file, program: "printf %s"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: file))
    }

    func testCommandIsASingleTypedLine() {
        let cmd = AgentLaunch.command(promptFile: "/tmp/p.txt")
        XCTAssertEqual(cmd.filter { $0 == "\n" }.count, 1)   // only the trailing Enter
        XCTAssertTrue(cmd.hasSuffix("\n"))
        XCTAssertTrue(cmd.contains("claude \"$p\""))
    }

    func testBlankPromptYieldsNoCommand() {
        let dir = tmpDir()
        XCTAssertNil(AgentLaunch.launchCommand(prompt: "   \n ", dir: dir))
        XCTAssertNil(AgentLaunch.prepare(prompt: "", dir: dir))
    }

    func testLaunchCommandWritesAFileTheCommandNames() {
        let dir = tmpDir()
        let cmd = AgentLaunch.launchCommand(prompt: "ship it", dir: dir)
        XCTAssertNotNil(cmd)
        XCTAssertTrue(cmd!.contains(dir))
    }
}
```

- [ ] **Step 2: Add the file to the test target and regenerate**

In `project.yml`, under `ShepherdModelTests:` → `sources:`:

```yaml
      - path: Sources/AgentLaunch.swift
```

Then `xcodegen generate`.

- [ ] **Step 3: Run the tests to verify they fail**

Run build, then test with `SUITE=AgentLaunchTests`.
Expected: FAIL — `cannot find 'AgentLaunch' in scope`.

- [ ] **Step 4: Write the implementation**

Create `Sources/AgentLaunch.swift`:

```swift
import Foundation

/// Starting an agent with a prompt already in hand. The prompt is written to a file and
/// read back by the shell rather than typed, because a typed newline is an Enter press.
enum AgentLaunch {

    /// One line: read the file into a variable, delete it, hand it to the agent as a
    /// single quoted argv entry. `file` is a path Shepherd owns, so the single-quoting
    /// never wraps user input.
    static func command(promptFile file: String, program: String = "claude") -> String {
        "p=$(cat '\(file)'); rm -f '\(file)'; \(program) \"$p\"\n"
    }

    /// Write the prompt somewhere the shell can read it back. nil if it is blank.
    static func prepare(prompt: String, dir: String = AppMode.supportPath("prompts")) -> String? {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        let fm = FileManager.default
        try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let path = (dir as NSString).appendingPathComponent(UUID().uuidString + ".txt")
        guard (try? text.write(toFile: path, atomically: true, encoding: .utf8)) != nil
        else { return nil }
        return path
    }

    /// The `initial_input` that launches an agent already working on `prompt`, or nil for
    /// a plain shell.
    static func launchCommand(prompt: String,
                              dir: String = AppMode.supportPath("prompts")) -> String? {
        guard let file = prepare(prompt: prompt, dir: dir) else { return nil }
        return command(promptFile: file)
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run the test command with `SUITE=AgentLaunchTests`.
Expected: PASS, test count **5**.

If `testPromptSurvivesTheShellVerbatim` fails on trailing whitespace: `$(…)` strips trailing newlines, which is why the fixture prompt does not end in one. Do not "fix" it by adding one.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/AgentLaunch.swift spike/seam1/Tests/AgentLaunchTests.swift spike/seam1/project.yml
git commit -m "$(cat <<'EOF'
feat(new-tab): hand a prompt to claude through a file, not the keyboard

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The `new-tab-worktree` config key

**Files:**
- Modify: `Sources/WorktreeService.swift` (the `ShepherdConfig` struct and `parseShepherdConfig`)
- Modify: `Tests/WorktreeServiceTests.swift`

**Interfaces:**
- Produces: `ShepherdConfig.newTabWorktree: Bool` (default `false`).

Shepherd keys ride ghostty comment lines (`# shepherd: key = value`) because libghostty parses this file and would error on a bare unknown key.

- [ ] **Step 1: Write the failing tests**

Append to `Tests/WorktreeServiceTests.swift` (inside the existing `final class` — match its name; do not create a second class):

```swift
    func testNewTabWorktreeDefaultsOff() {
        XCTAssertFalse(parseShepherdConfig("# shepherd: theme = dark").newTabWorktree)
    }

    func testNewTabWorktreeParsesTrue() {
        XCTAssertTrue(parseShepherdConfig("#   shepherd:  new-tab-worktree  =  true ").newTabWorktree)
    }

    func testNewTabWorktreeAnythingElseIsOff() {
        XCTAssertFalse(parseShepherdConfig("# shepherd: new-tab-worktree = yes").newTabWorktree)
        XCTAssertFalse(parseShepherdConfig("# shepherd: new-tab-worktree = false").newTabWorktree)
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run build, then test with `SUITE=WorktreeServiceTests`.
Expected: FAIL — `value of type 'ShepherdConfig' has no member 'newTabWorktree'`.

- [ ] **Step 3: Write the implementation**

In `Sources/WorktreeService.swift`, add to `struct ShepherdConfig` after `editorWrapLines`:

```swift
    /// Whether ⌘T's composer opens with the worktree toggle already on.
    var newTabWorktree: Bool = false
```

and inside `parseShepherdConfig`'s loop, next to the other key checks:

```swift
        if key == "new-tab-worktree" { cfg.newTabWorktree = value.lowercased() == "true" }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run the test command with `SUITE=WorktreeServiceTests`.
Expected: PASS, and the test count is **3 higher** than before this task.

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/WorktreeService.swift spike/seam1/Tests/WorktreeServiceTests.swift
git commit -m "$(cat <<'EOF'
feat(config): new-tab-worktree flips the composer's worktree default

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `Pane.initialCommand` and the one `initial_input` seam

**Files:**
- Modify: `Sources/SplitTree.swift:29` (the `Pane` struct)
- Modify: `Sources/AgentStore.swift:1323` (`takeResumeInput`)
- Modify: `Sources/GhosttyTerminal.swift:272` (its one call site)
- Modify: `Tests/SplitTreeTests.swift`

**Interfaces:**
- Consumes: nothing.
- Produces: `Pane.initialCommand: String?`; `AgentStore.takeInitialInput(forPane: String) -> String?` (replaces `takeResumeInput` — same shape, same one-shot semantics).

`Pane.CodingKeys` lists only `userTitle, cwd, sessionID`, so a new field is non-persisted for free — the test below pins that, because a persisted `initialCommand` would re-run the prompt on every relaunch.

- [ ] **Step 1: Write the failing test**

Append to `Tests/SplitTreeTests.swift` (inside the existing class):

```swift
    func testInitialCommandNeverPersists() throws {
        var pane = Pane()
        pane.userTitle = "composed"
        pane.initialCommand = "p=$(cat '/tmp/x'); rm -f '/tmp/x'; claude \"$p\"\n"
        let data = try JSONEncoder().encode(SplitNode.leaf(pane))
        let back = try JSONDecoder().decode(SplitNode.self, from: data)
        let restored = try XCTUnwrap(back.firstLeafID.flatMap { back.pane($0) })
        XCTAssertEqual(restored.userTitle, "composed")
        XCTAssertNil(restored.initialCommand)
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run build, then test with `SUITE=SplitTreeTests`.
Expected: FAIL — `value of type 'Pane' has no member 'initialCommand'`.

- [ ] **Step 3: Add the field**

In `Sources/SplitTree.swift`, in `struct Pane` after the `provisioning` line:

```swift
    var initialCommand: String? = nil // typed into the PTY once on mount (transient, never persisted)
```

- [ ] **Step 4: Run the test to verify it passes**

Run the test command with `SUITE=SplitTreeTests`. Expected: PASS, count up by 1.

- [ ] **Step 5: Widen the seam**

In `Sources/AgentStore.swift`, rename `takeResumeInput(forPane:)` to `takeInitialInput(forPane:)` and make it return the composed command when there is one. Replace the whole function body with:

```swift
    /// The one-shot `initial_input` for a pane: the command that launches a composed
    /// agent, else the line that resumes a restored session. Consumed on read (cleared
    /// async so published state is not mutated mid-view-build).
    func takeInitialInput(forPane paneID: String) -> String? {
        let pane: Pane?
        if let (w, t) = locatePane(paneID, in: workspaces) {
            pane = workspaces[w].tabs[t].root.pane(paneID)
        } else {
            pane = ephemeralPanes.first { $0.id == paneID }?.pane
        }
        guard let pane else { return nil }
        let composed = pane.initialCommand
        let sid = pane.sessionID
        guard composed != nil || (sid?.isEmpty == false) else { return nil }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if let (w, t) = locatePane(paneID, in: self.workspaces) {
                _ = self.workspaces[w].tabs[t].root.updatePane(paneID) {
                    $0.sessionID = nil
                    $0.initialCommand = nil
                }
            } else if let i = self.ephemeralPanes.firstIndex(where: { $0.id == paneID }) {
                self.ephemeralPanes[i].pane.sessionID = nil
                self.ephemeralPanes[i].pane.initialCommand = nil
            }
            self.save()
        }
        if let composed { return composed }
        return claudeResumeInput(sessionID: sid!)
    }
```

In `Sources/GhosttyTerminal.swift`, change the call site:

```swift
            if let input = AgentStore.shared.takeInitialInput(forPane: paneID) {
                cfg.initial_input = dup(input)
            }
```

Update its comment to one line: `// One-shot: a composed prompt's launch command, else a restored session's resume line.`

- [ ] **Step 6: Verify the build and the whole suite**

Run the build command, then the test command with `SUITE` replaced by nothing (drop `-only-testing:` entirely) to run all three test targets.
Expected: `** TEST SUCCEEDED **` with no drop in test count. Also confirm no `takeResumeInput` references remain:

```bash
grep -rn "takeResumeInput" spike/seam1/Sources spike/seam1/Tests
```
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add spike/seam1/Sources/SplitTree.swift spike/seam1/Sources/AgentStore.swift \
        spike/seam1/Sources/GhosttyTerminal.swift spike/seam1/Tests/SplitTreeTests.swift
git commit -m "$(cat <<'EOF'
feat(panes): one initial_input seam — a launch command or a resume line

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Store plumbing — `create(_:)`

**Files:**
- Modify: `Sources/AgentStore.swift` (published flags near `promptingNewWorkspace:66`; `newWorktreeTab:400`; `addProvisioningTab:446`; `newTab(inWorkspace:):974`)

**Interfaces:**
- Consumes: `NewTabRequest`, `NewTabTarget`, `AgentLaunch.launchCommand(prompt:)`, `Pane.initialCommand`, `parseShepherdConfig`.
- Produces:
  - `@Published var promptingNewTab: Bool`
  - `var newTabSeedWorkspaceID: String?`
  - `func newTabTargets() -> [NewTabTarget]`
  - `func newTabWorktreeDefault() -> Bool`
  - `func create(_ request: NewTabRequest)`
  - `newTab(inWorkspace:cwd:sessionID:initialCommand:)` and `newWorktreeTab(inWorkspace:name:title:initialCommand:)`

There is no unit test here — `AgentStore` is the AppKit shell and is not in the test target. Every decision it makes was tested in Tasks 1–2; this task's gate is a clean build plus the manual checklist in Task 7.

- [ ] **Step 1: Add the published state**

In `Sources/AgentStore.swift`, next to `@Published var promptingNewWorkspace = false`:

```swift
    @Published var promptingNewTab = false
    /// Which workspace the composer opens aimed at; nil = the current one.
    var newTabSeedWorkspaceID: String? = nil
```

- [ ] **Step 2: Thread `initialCommand` through both creation paths**

Change the plain path's signature and pane setup:

```swift
    @discardableResult
    func newTab(inWorkspace wsID: String, cwd: String? = nil, sessionID: String? = nil,
                initialCommand: String? = nil) -> String {
        guard let w = workspaces.firstIndex(where: { $0.id == wsID }) else { return "" }
        selectedWorkspaceID = wsID
        if let (c, wid) = remoteTarget(forWorkspace: wsID) { c.send(.cmdNewTab(workspaceID: wid)); return "" }
        var pane = Pane()
        pane.cwd = cwd ?? expandedDefaultPath(workspaces[w])
        pane.sessionID = sessionID   // set ⇒ GhosttyTerminal seeds `claude --resume` on mount
        pane.initialCommand = initialCommand
        ...
```

(leave the rest of the body untouched).

Change the worktree path's signature to carry the tab title and the command, and pass both down:

```swift
    func newWorktreeTab(inWorkspace wsID: String, name: String,
                        title: String? = nil, initialCommand: String? = nil) {
```

and inside it, the provisioning call:

```swift
        guard let provisional = addProvisioningTab(inWorkspace: wsID, name: trimmed, title: title,
                                                   dest: dest, initialCommand: initialCommand)
        else { return }
```

Then `addProvisioningTab`:

```swift
    private func addProvisioningTab(inWorkspace wsID: String, name: String, title: String?,
                                    dest: String, initialCommand: String?) -> (tabID: String, paneID: String)? {
        guard let w = workspaces.firstIndex(where: { $0.id == wsID }) else { return nil }
        selectedWorkspaceID = wsID
        var pane = Pane()
        pane.provisioning = true
        pane.userTitle = name
        pane.cwd = dest
        pane.initialCommand = initialCommand
        var tab = Tab(pane: pane)
        tab.userTitle = title
        workspaces[w].tabs.append(tab)
        workspaces[w].selectedTabID = tab.tabID
        save()
        return (tab.tabID, pane.paneID)
    }
```

`tab.userTitle` wins over the pane's in `Tab.displayTitle`, so a composed title beats the branch name while the branch still names the pane.

- [ ] **Step 3: Add the composer's entry points into the store**

Add near `newTab(inWorkspace:)`:

```swift
    /// Every workspace as a composer destination. `isGitRepo` is left false — the view
    /// resolves it off-main for the selected target only (`Git.isWorkTree` shells out).
    func newTabTargets() -> [NewTabTarget] {
        workspaces.enumerated().map { i, ws in
            NewTabTarget(workspaceID: ws.id, name: ws.displayName(index: i),
                         isRemote: ws.isRemote,
                         isGitRepo: ws.isRemote ? (ws.defaultPath?.isEmpty == false) : false)
        }
    }

    /// `# shepherd: new-tab-worktree = true` ⇒ the composer opens with worktree on.
    func newTabWorktreeDefault() -> Bool {
        let path = (NSHomeDirectory() as NSString).appendingPathComponent(".config/shepherd/config")
        guard let contents = try? String(contentsOfFile: path, encoding: .utf8) else { return false }
        return parseShepherdConfig(contents).newTabWorktree
    }

    /// Make the tab the composer describes.
    func create(_ request: NewTabRequest) {
        let cmd = AgentLaunch.launchCommand(prompt: request.effectivePrompt)
        if request.usesWorktree {
            newWorktreeTab(inWorkspace: request.target.workspaceID, name: request.branch,
                           title: request.effectiveTitle, initialCommand: cmd)
        } else {
            let tabID = newTab(inWorkspace: request.target.workspaceID, initialCommand: cmd)
            if let t = request.effectiveTitle, !tabID.isEmpty {
                rename(tabID: tabID, to: t, inWorkspace: request.target.workspaceID)
            }
        }
    }
```

- [ ] **Step 4: Verify the build**

Run the build command. Expected: `** BUILD SUCCEEDED **`.

Fix any call site the signature changes broke:

```bash
grep -rn "addProvisioningTab\|newWorktreeTab(" spike/seam1/Sources
```
All existing callers pass the new parameters by default, so this should compile untouched — but check `applyRemoteCommand`'s `cmdNewWorktreeTab` case.

- [ ] **Step 5: Run the full suite**

Run the test command without `-only-testing:`. Expected: `** TEST SUCCEEDED **`, no drop in count.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/AgentStore.swift
git commit -m "$(cat <<'EOF'
feat(new-tab): store side of the composer — create(_:) and its two paths

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: The composer card

**Files:**
- Create: `Sources/NewTabComposer.swift`
- Modify: `Sources/ContentView.swift:87-94` (beside the `NewWorkspaceModal` overlay)

**Interfaces:**
- Consumes: `NewTabRequest`, `NewTabTarget`, `AgentStore.newTabTargets()`, `.newTabWorktreeDefault()`, `.create(_:)`, `.promptingNewTab`, `.newTabSeedWorkspaceID`, `Git.isWorkTree(_:)`, `Theme`.
- Produces: `struct NewTabComposer: View` with `init(isPresented: Binding<Bool>)`.

The card is a self-drawn `Theme` card over a dimmed backdrop — the `NewWorkspaceModal` idiom, not a native sheet. Sidebar-adjacent SwiftUI controls stay `.focusable(false)` in this codebase so focus stays on the terminal; inside a modal overlay that rule is inverted — the fields *must* take focus, and the overlay releases it on dismiss.

- [ ] **Step 1: Write the view**

Create `Sources/NewTabComposer.swift`:

```swift
import SwiftUI

/// ⌘T. One card: a title, a destination, an optional worktree, and a prompt that
/// launches an agent. Prompt-first — the settings are chrome around it. Every
/// enable/disable question is `NewTabRequest`'s; this file only draws.
struct NewTabComposer: View {
    @EnvironmentObject var store: AgentStore
    @Binding var isPresented: Bool

    @State private var request: NewTabRequest?
    @State private var targets: [NewTabTarget] = []
    @FocusState private var focus: Field?

    private enum Field: Hashable { case title, prompt, branch }

    var body: some View {
        ZStack {
            Color.black.opacity(0.35)
                .ignoresSafeArea()
                .onTapGesture { isPresented = false }

            if let r = request {
                card(r)
                    .frame(width: 560)
                    .background(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(Theme.ground)
                            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .strokeBorder(Theme.hairline, lineWidth: 1))
                    )
                    .shadow(color: .black.opacity(0.55), radius: 30, x: 0, y: 16)
            }
        }
        .onAppear(perform: seed)
    }

    // MARK: card

    @ViewBuilder
    private func card(_ r: NewTabRequest) -> some View {
        VStack(spacing: 0) {
            header(r)
            Rectangle().fill(Theme.hairline).frame(height: 1)
            promptArea(r)
            Rectangle().fill(Theme.hairline).frame(height: 1)
            footer(r)
        }
    }

    private func header(_ r: NewTabRequest) -> some View {
        HStack(spacing: 10) {
            TextField("Untitled tab", text: binding(\.title))
                .textFieldStyle(.plain)
                .font(.ui(15, .medium))
                .foregroundStyle(Theme.textPrimary)
                .focused($focus, equals: .title)
                .onSubmit(create)

            Spacer(minLength: 8)

            Menu {
                ForEach(targets, id: \.workspaceID) { t in
                    Button(t.name) { retarget(t) }
                }
            } label: {
                Text(r.target.name).font(.ui(12, .medium))
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .foregroundStyle(Theme.textSecondary)
        }
        .padding(.horizontal, 16)
        .frame(height: 46)
    }

    private func promptArea(_ r: NewTabRequest) -> some View {
        ZStack(alignment: .topLeading) {
            TextField("", text: binding(\.prompt), axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(6...6)
                .font(.ui(13))
                .foregroundStyle(Theme.textPrimary)
                .focused($focus, equals: .prompt)
                .disabled(!r.promptAvailable)

            if r.prompt.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    Text(r.promptHint ?? "Ask Claude to do something…")
                        .foregroundStyle(Theme.textSecondary)
                    if r.promptAvailable {
                        Text("leave empty for a plain shell")
                            .foregroundStyle(Theme.textDim)
                    }
                }
                .font(.ui(13))
                .allowsHitTesting(false)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .contentShape(Rectangle())
        .onTapGesture { if r.promptAvailable { focus = .prompt } }
    }

    private func footer(_ r: NewTabRequest) -> some View {
        HStack(spacing: 10) {
            Toggle("", isOn: binding(\.worktree))
                .toggleStyle(.switch)
                .controlSize(.mini)
                .labelsHidden()
                .disabled(!r.worktreeAvailable)

            Text("Worktree")
                .font(.ui(12))
                .foregroundStyle(r.worktreeAvailable ? Theme.textSecondary : Theme.textDim)

            if let hint = r.worktreeHint {
                Text(hint).font(.ui(11)).foregroundStyle(Theme.textDim)
            } else if r.worktree {
                TextField("branch", text: Binding(
                    get: { r.branch },
                    set: { request?.setBranch($0) }))
                    .textFieldStyle(.plain)
                    .font(.ui(12))
                    .foregroundStyle(Theme.textPrimary)
                    .focused($focus, equals: .branch)
                    .frame(width: 180)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(Theme.raised))
                    .onSubmit(create)
            }

            Spacer(minLength: 8)

            if let hint = r.createHint {
                Text(hint).font(.ui(11)).foregroundStyle(Theme.textDim)
            }

            Button(action: create) {
                HStack(spacing: 6) {
                    Text("Create").font(.ui(12, .semibold))
                    Text("⏎").font(.ui(11)).opacity(0.7)
                }
                .foregroundStyle(Theme.textPrimary)
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .background(RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(r.canCreate ? Theme.working : Theme.raised))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!r.canCreate)

            Button("") { isPresented = false }
                .keyboardShortcut(.cancelAction)
                .opacity(0)
                .frame(width: 0, height: 0)
        }
        .padding(.horizontal, 16)
        .frame(height: 52)
    }

    // MARK: wiring

    /// One writable binding into the optional request, so the fields stay declarative.
    private func binding<V>(_ key: WritableKeyPath<NewTabRequest, V>) -> Binding<V> {
        Binding(
            get: { request?[keyPath: key] ?? (NewTabRequest(target: targets.first ?? fallbackTarget))[keyPath: key] },
            set: { request?[keyPath: key] = $0 })
    }

    private var fallbackTarget: NewTabTarget {
        NewTabTarget(workspaceID: "", name: "Workspace", isRemote: false, isGitRepo: false)
    }

    private func seed() {
        targets = store.newTabTargets()
        let wanted = store.newTabSeedWorkspaceID ?? store.selectedWorkspaceID
        let target = targets.first { $0.workspaceID == wanted } ?? targets.first ?? fallbackTarget
        request = NewTabRequest(target: target, worktree: store.newTabWorktreeDefault())
        store.newTabSeedWorkspaceID = nil
        focus = .title
        resolveGitStatus(for: target)
    }

    private func retarget(_ t: NewTabTarget) {
        request?.retarget(t)
        resolveGitStatus(for: t)
    }

    /// `Git.isWorkTree` shells out, so only the selected target is resolved, off-main.
    private func resolveGitStatus(for t: NewTabTarget) {
        guard !t.isRemote,
              let ws = store.workspaces.first(where: { $0.id == t.workspaceID }),
              let p = ws.defaultPath, !p.isEmpty else { return }
        let dir = (p as NSString).expandingTildeInPath
        DispatchQueue.global(qos: .userInitiated).async {
            let ok = Git.isWorkTree(dir)
            DispatchQueue.main.async {
                guard request?.target.workspaceID == t.workspaceID else { return }
                request?.retarget(NewTabTarget(workspaceID: t.workspaceID, name: t.name,
                                               isRemote: t.isRemote, isGitRepo: ok))
            }
        }
    }

    private func create() {
        guard let r = request, r.canCreate else { return }
        store.create(r)
        isPresented = false
    }
}
```

- [ ] **Step 2: Present it from `ContentView`**

In `Sources/ContentView.swift`, directly after the `NewWorkspaceModal` overlay block and its `.animation(...)` line, add:

```swift
        // The ⌘T composer (also the folder `+` and the empty-workspace button).
        .overlay {
            if store.promptingNewTab {
                NewTabComposer(isPresented: $store.promptingNewTab)
                    .environmentObject(store)
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.12), value: store.promptingNewTab)
```

- [ ] **Step 3: Regenerate and build**

```bash
xcodegen generate
```
then the build command. Expected: `** BUILD SUCCEEDED **`.

Ignore SourceKit "cannot find type" noise in the editor — `xcodebuild` is ground truth here.

- [ ] **Step 4: Run the full suite**

Run the test command without `-only-testing:`. Expected: `** TEST SUCCEEDED **`.

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/NewTabComposer.swift spike/seam1/Sources/ContentView.swift
git commit -m "$(cat <<'EOF'
feat(new-tab): the composer card

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Route every human entry point through it

**Files:**
- Modify: `Sources/ShepherdApp.swift:113` (`case .newTab`)
- Modify: `Sources/SidebarView.swift:233-249` (the folder hover-`+` `Menu`) and its `promptNewWorktree()` (around `:334`)
- Modify: `Sources/WorkspaceEmptyView.swift` (the button row, `promptNewWorktree`, `refreshGitStatus`, `isGitRepo`, `worktreeEnabled`)

**Interfaces:**
- Consumes: `AgentStore.promptingNewTab`, `.newTabSeedWorkspaceID`.
- Produces: nothing new.

The control CLI's `tab new` (`applyRemoteCommand` / `controlRoute`) is deliberately **untouched** — a script cannot fill in a dialog.

- [ ] **Step 1: Point ⌘T at the composer**

In `Sources/ShepherdApp.swift`, in `ShortcutActions.run`:

```swift
        case .newTab:        s.promptingNewTab = true
```

- [ ] **Step 2: Collapse the folder `+` menu into a button**

In `Sources/SidebarView.swift`, replace the whole `Menu { … } label: { … }` block (the one containing `Button("New Tab")` and `Button("New Worktree Tab…")`) with:

```swift
                    Button(action: {
                        store.newTabSeedWorkspaceID = ws.id
                        store.promptingNewTab = true
                    }) {
                        Image(systemName: "plus")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Theme.textDim)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .focusable(false)
                    .help("New tab in this workspace")
```

Then delete the now-unused `promptNewWorktree()` from that view. Leave `worktreeEnabled`, `isGitRepo` and `refreshGitStatus` alone if anything else in the file reads them — check first:

```bash
grep -n "worktreeEnabled\|isGitRepo" spike/seam1/Sources/SidebarView.swift
```
Delete only what has no remaining readers.

- [ ] **Step 3: Simplify the empty-workspace view**

In `Sources/WorkspaceEmptyView.swift`, replace the `HStack` of buttons with:

```swift
            Button("New Tab") { store.promptingNewTab = true }
                .buttonStyle(.borderedProminent)
                .focusable(false)
                .padding(.top, 4)
```

and delete `promptNewWorktree()`, `refreshGitStatus()`, `worktreeEnabled`, `@State private var isGitRepo`, and the `.onAppear` / `.onChange` modifiers that drove them. The composer resolves the repo itself now.

- [ ] **Step 4: Build and run the full suite**

Run the build command, then the test command without `-only-testing:`.
Expected: `** BUILD SUCCEEDED **` then `** TEST SUCCEEDED **`.

Confirm nothing still reaches the deleted alert path:

```bash
grep -rn "promptNewWorktree" spike/seam1/Sources
```
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/ShepherdApp.swift spike/seam1/Sources/SidebarView.swift \
        spike/seam1/Sources/WorkspaceEmptyView.swift
git commit -m "$(cat <<'EOF'
feat(new-tab): ⌘T, the folder + and the empty view all open the composer

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Hand the user a verification checklist**

Do **not** relaunch Shepherd yourself — it is the user's daily terminal. Report that the branch builds and the suite is green, and ask them to check, in a dev build (`scripts/dev.sh`):

1. `⌘T` then `⏎` → a plain shell tab in the current workspace, as before.
2. `⌘T`, type a title, `⏎` → the tab carries that name in the sidebar.
3. `⌘T`, type a multi-line prompt (**confirm which key inserts a newline** — `⇧⏎` is expected for `TextField(axis: .vertical)`; if it submits instead, that is the one thing this plan could not verify without running the app), `⏎` → `claude` starts and the whole prompt arrives as one message.
4. `⌘T` in a workspace with no directory set → the worktree row is greyed with its hint.
5. `⌘T` in a repo workspace, worktree on, empty branch → Create is dead with "name the worktree"; typing a title fills the branch as a slug; editing the branch detaches it.
6. Worktree on + a prompt → the tab shows the provisioning state, then `claude` starts **inside the new worktree** with the prompt.
7. `⎋` and a backdrop click both dismiss with nothing created.
8. `ls ~/.shepherd/prompts` (or `~/.shepherd/dev/prompts` for a dev build) is empty afterwards — the command deletes each file.

---

## Self-Review

**Spec coverage**

| Spec requirement | Task |
|---|---|
| Composer card, `NewWorkspaceModal` idiom, presented on `promptingNewTab` | 6 |
| Title field, autofocused, empty ⇒ existing naming | 1, 5, 6 |
| Workspace picker, defaults to current | 5, 6 |
| Prompt body, empty ⇒ plain shell | 1, 2, 6 |
| Worktree toggle, config default | 1, 3, 5, 6 |
| Branch mirrors slugged title, detaches on edit | 1, 6 |
| Create disabled only for worktree-on-with-empty-branch | 1, 6 |
| `⏎` / `⇧⏎` / `⎋` / backdrop | 6 (⇧⏎ flagged for manual confirmation in 7) |
| Nothing sticky between opens | 6 (`seed()` runs on every `onAppear`) |
| Temp-file launch command, `rm` before `claude` | 2 |
| Worktree ordering composes via provisioning | 5 |
| `Pane.initialCommand` transient | 4 |
| One `takeInitialInput` seam | 4 |
| Entry points: ⌘T, folder `+`, empty view; CLI untouched | 7 |
| Unavailable states shown disabled with a reason | 1, 6 |
| Title wins over branch name | 5 |
| `NewTabRequestTests`, `AgentLaunchTests` | 1, 2 |

**Placeholders:** none — every code step carries the code.

**Type consistency:** `NewTabTarget(workspaceID:name:isRemote:isGitRepo:)`, `NewTabRequest(target:worktree:)`, `setBranch(_:)`, `retarget(_:)`, `usesWorktree`, `effectiveTitle`, `effectivePrompt`, `canCreate`, `AgentLaunch.command(promptFile:program:)` / `prepare(prompt:dir:)` / `launchCommand(prompt:dir:)`, `takeInitialInput(forPane:)`, `create(_:)`, `newTabTargets()`, `newTabWorktreeDefault()`, `newTabSeedWorkspaceID` — used identically everywhere they appear.

## Deferred (not in this plan)

- A Settings → Workspaces toggle for `new-tab-worktree` (config key only for now).
- Prompts on mirror workspaces (needs a prompt field on `cmdNewTab` in `RemoteProtocol`).
- A model / agent picker chip, attachments, "create more".
