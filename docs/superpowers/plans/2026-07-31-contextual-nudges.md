# Contextual Nudges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the workbench's git features at the moment their condition is true — a conflict, a stopped rebase, an unreviewed diff, a branch with no PR — instead of requiring the user to already know `⌘G` exists.

**Architecture:** A pure `NudgeRegistry` maps per-pane facts to an ordered list of `Nudge` values. Facts come from `RepoSignals` (cheap git reads) kept live by a `RepoWatcher` on each repo's git dir. Two render surfaces consume the registry: a glyph + count chip in the sidebar row, and a one-line bar above the terminal. Nudges never write to `AgentState`; urgency joins the attention rollups through a second channel.

**Tech Stack:** Swift 5.9 / SwiftUI / AppKit, XCTest (`ShepherdModelTests`), `xcodegen`, `/usr/bin/git` via `Process`, `gh` CLI.

**Spec:** [`docs/superpowers/specs/2026-07-31-contextual-nudges-design.md`](../specs/2026-07-31-contextual-nudges-design.md)

## Global Constraints

- **Build**: `cd spike/seam1 && xcodegen generate` after **every** file add/remove, then
  `xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build`
- **Test**: **build first, then test** — in a cold `-derivedDataPath` the test target races
  the app target and dies with `unable to resolve module dependency: 'Shepherd'`.
  Test command: same as above with `test` instead of `build`, plus
  `-only-testing:ShepherdModelTests/<Suite>`.
- **`-only-testing:` on a suite the project does not know about reports `** TEST SUCCEEDED **`
  vacuously.** A pass counts only once the test count moves:
  `… test 2>&1 | grep -c "Test Case .* passed"`. Always `xcodegen generate` before the
  first run of a new test file.
- **A new compiled source must be added to `ShepherdModelTests`' explicit `sources:` list**
  in `project.yml` to be visible to tests. Test *files* under `Tests/` are picked up by
  the existing `- path: Tests` glob and need no entry.
- **Never `killall Shepherd` or relaunch the app.** The user runs Shepherd as their daily
  terminal. Verification is compile + unit tests; runtime checks are the user's to do.
- **No network calls anywhere in this feature.** `RepoWatcher` fires on every git write;
  a fetch there would hammer the remote. Specifically: **never call
  `Git.defaultBaseRef(in:)`** — it runs `git remote set-head origin --auto`, which hits
  the network.
- **Nudges never write to `Pane.state`.** The hook lifecycle map (`StopPolicy.applyEvent`)
  is the sole author of `AgentState`.
- **SourceKit lies in this repo.** "Cannot find type X" in an editor is stale; `xcodebuild`
  is ground truth.
- **Commit messages end with:** `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- **Comments:** non-obvious *why* only, one line where possible. Never narrate the change
  or recap the bug history.

## File Structure

**Created**

| File | Responsibility | Target |
|---|---|---|
| `Sources/Nudges/RepoSignals.swift` | The git-facts struct + its pure parsers | app + tests |
| `Sources/Nudges/RepoSignalsReader.swift` | The `Process` shell that fills it | app + tests |
| `Sources/Nudges/NudgeRegistry.swift` | `PaneFacts` → `[Nudge]`. The only decision point | app + tests |
| `Sources/Nudges/PaneChrome.swift` | Generic structural view: bar slot above pane content | app + tests |
| `Sources/Nudges/PRTemplate.swift` | Pure PR-template location | app + tests |
| `Sources/Nudges/RepoWatcher.swift` | git-dir vnode watch, debounce, refcount | app only |
| `Sources/Nudges/NudgeBarView.swift` | The concrete one-line bar | app only |
| `Sources/Nudges/PRCreateDialog.swift` | The `NSAlert` prompt + `gh pr create` | app only |
| `Tests/RepoSignalsTests.swift` | Pure parser coverage | tests |
| `Tests/RepoSignalsIntegrationTests.swift` | Real-git, four conflict flavours + worktree | tests |
| `Tests/NudgeRegistryTests.swift` | Facts → nudges, precedence, bar policy, suppressions | tests |
| `Tests/PRTemplateTests.swift` | Template location precedence | tests |
| `Tests/PaneChromeTests.swift` | The surface-remount guard | tests |

**Modified**

| File | Change |
|---|---|
| `Sources/Workbench/ConflictReader.swift:122` | `readState` `private` → internal |
| `Sources/WorktreeService.swift` | add `Git.gitDir(_:)` |
| `Sources/AgentStore.swift` | own `RepoWatcher`, publish `repoSignals`, build `PaneFacts`, nudge actions, re-read triggers |
| `Sources/Workspace.swift` | `totalAttentionCount` gains a nudge-attention term |
| `Sources/SidebarView.swift:476-505` | third glyph case + trailing count chip |
| `Sources/SplitContainer.swift:36-56` | wrap pane content in `PaneChrome` |
| `spike/seam1/project.yml` | test-target `sources:` entries |

**Deliberately not touched:** `StopPolicy`, `AgentState`, notification/chime/FCM routing, `WorkbenchSession`.

---

### Task 1: `RepoSignals` — the struct and its pure parsers

Pure only. No `Process`, no I/O. Reuses `MergeState` from `ConflictReader.swift` rather than
declaring a second "which operation is in progress" type — two types meaning that can
disagree, and `MergeState` is already tested by `ConflictContextTests`.

**Files:**
- Create: `spike/seam1/Sources/Nudges/RepoSignals.swift`
- Test: `spike/seam1/Tests/RepoSignalsTests.swift`
- Modify: `spike/seam1/project.yml` (test-target `sources:`)

**Interfaces:**
- Consumes: `MergeState` (from `Sources/Workbench/ConflictReader.swift`, already in the test target).
- Produces:
  - `struct RepoSignals: Equatable` with `state: MergeState`, `conflicts: Int`, `dirty: Int`, `ahead: Int`, `branch: String?`, `hasUpstream: Bool`, and `static let none`.
  - `RepoSignals.unmergedCount(lsFilesZ: String) -> Int`
  - `RepoSignals.dirtyCount(porcelain: String) -> Int`
  - `RepoSignals.revCount(_ out: String) -> Int`

- [ ] **Step 1: Write the failing test**

Create `spike/seam1/Tests/RepoSignalsTests.swift`:

```swift
import XCTest
@testable import Shepherd

final class RepoSignalsTests: XCTestCase {

    // MARK: unmergedCount

    /// `ls-files -u` prints one record PER STAGE, so a single conflicted file arrives as
    /// three records. Counting records instead of paths triples the number.
    func testUnmergedCountCollapsesStagesToPaths() {
        let z = "100644 aaa 1\tsrc/a.swift\0"
              + "100644 bbb 2\tsrc/a.swift\0"
              + "100644 ccc 3\tsrc/a.swift\0"
        XCTAssertEqual(RepoSignals.unmergedCount(lsFilesZ: z), 1)
    }

    func testUnmergedCountTwoPaths() {
        let z = "100644 aaa 1\tsrc/a.swift\0"
              + "100644 bbb 2\tsrc/a.swift\0"
              + "100644 ccc 2\tdocs/b.md\0"
              + "100644 ddd 3\tdocs/b.md\0"
        XCTAssertEqual(RepoSignals.unmergedCount(lsFilesZ: z), 2)
    }

    /// A delete/modify conflict has only two stages. It is still one conflicted path.
    func testUnmergedCountTwoStageConflict() {
        let z = "100644 aaa 1\tgone.txt\0100644 bbb 2\tgone.txt\0"
        XCTAssertEqual(RepoSignals.unmergedCount(lsFilesZ: z), 1)
    }

    func testUnmergedCountEmpty() {
        XCTAssertEqual(RepoSignals.unmergedCount(lsFilesZ: ""), 0)
    }

    /// A path containing a space or a tab must not be split further — the delimiter is the
    /// FIRST tab, and `-z` means the record ends at the NUL, not at a newline.
    func testUnmergedCountPathWithSpaceAndTab() {
        let z = "100644 aaa 2\tsrc/my file\twith tab.swift\0"
        XCTAssertEqual(RepoSignals.unmergedCount(lsFilesZ: z), 1)
    }

    // MARK: dirtyCount

    func testDirtyCountCountsPorcelainLines() {
        let p = " M src/a.swift\nA  src/b.swift\n?? untracked.txt\n"
        XCTAssertEqual(RepoSignals.dirtyCount(porcelain: p), 3)
    }

    /// A rename is one change, and git writes it on one line.
    func testDirtyCountRenameIsOneLine() {
        XCTAssertEqual(RepoSignals.dirtyCount(porcelain: "R  old.txt -> new.txt\n"), 1)
    }

    func testDirtyCountCleanTree() {
        XCTAssertEqual(RepoSignals.dirtyCount(porcelain: ""), 0)
        XCTAssertEqual(RepoSignals.dirtyCount(porcelain: "\n\n"), 0)
    }

    // MARK: revCount

    func testRevCountParsesTrimmedInteger() {
        XCTAssertEqual(RepoSignals.revCount("3\n"), 3)
        XCTAssertEqual(RepoSignals.revCount("  12  "), 12)
    }

    /// A repo with no commits makes `rev-list` fail and print nothing. Zero, not a crash.
    func testRevCountGarbageIsZero() {
        XCTAssertEqual(RepoSignals.revCount(""), 0)
        XCTAssertEqual(RepoSignals.revCount("fatal: bad revision"), 0)
    }

    // MARK: the struct

    func testNoneIsIdleAndEmpty() {
        let s = RepoSignals.none
        XCTAssertEqual(s.state, .idle)
        XCTAssertEqual(s.conflicts, 0)
        XCTAssertEqual(s.dirty, 0)
        XCTAssertEqual(s.ahead, 0)
        XCTAssertFalse(s.hasUpstream)
        XCTAssertNil(s.branch)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd spike/seam1 && xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  -only-testing:ShepherdModelTests/RepoSignalsTests test 2>&1 | tail -30
```

Expected: compile failure, `cannot find 'RepoSignals' in scope`.

- [ ] **Step 3: Write the implementation**

Create `spike/seam1/Sources/Nudges/RepoSignals.swift`:

```swift
import Foundation

/// Cheap git facts about one pane's checkout — everything a nudge may need and nothing
/// that costs a blob read.
///
/// `state` is `MergeState` rather than a local operation enum on purpose: two types that
/// both mean "which operation is git part-way through" can disagree, and this one is
/// already read and tested by the merge resolver.
struct RepoSignals: Equatable {
    var state: MergeState = .idle
    /// Conflicted **paths**, not index records.
    var conflicts: Int = 0
    /// Lines of `git status --porcelain` — tracked edits, staged changes and untracked
    /// files alike. A file an agent just created is a change worth reviewing.
    var dirty: Int = 0
    /// Commits on this branch that the base does not have.
    var ahead: Int = 0
    var branch: String?
    var hasUpstream: Bool = false

    static let none = RepoSignals()
}

// MARK: - Pure parsers

extension RepoSignals {

    /// Unique paths in `git ls-files -u -z` output.
    ///
    /// git prints one record per index stage, so an ordinary content conflict arrives three
    /// times and a delete/modify twice. The path is everything after the first tab, and the
    /// record ends at the NUL — so a path containing a space, a tab or a newline is safe.
    static func unmergedCount(lsFilesZ: String) -> Int {
        var paths = Set<String>()
        for record in lsFilesZ.split(separator: "\0", omittingEmptySubsequences: true) {
            guard let tab = record.firstIndex(of: "\t") else { continue }
            paths.insert(String(record[record.index(after: tab)...]))
        }
        return paths.count
    }

    static func dirtyCount(porcelain: String) -> Int {
        porcelain.split(separator: "\n")
            .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            .count
    }

    /// `rev-list --count` output, or 0 for anything unparseable — an empty repo makes the
    /// command fail and print nothing.
    static func revCount(_ out: String) -> Int {
        Int(out.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
    }
}
```

- [ ] **Step 4: Add the source to the test target**

In `spike/seam1/project.yml`, in the `ShepherdModelTests` target's `sources:` list, after
the `- path: Sources/DiffReader.swift` line add:

```yaml
      - path: Sources/Nudges/RepoSignals.swift
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd spike/seam1 && xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  -only-testing:ShepherdModelTests/RepoSignalsTests test 2>&1 | grep -c "Test Case .* passed"
```

Expected: `13`. A `0` means the suite did not compile into the project — re-run `xcodegen generate`.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/Nudges/RepoSignals.swift spike/seam1/Tests/RepoSignalsTests.swift spike/seam1/project.yml
git commit -m "$(cat <<'EOF'
feat(nudges): RepoSignals — the cheap git facts a nudge reads

Reuses MergeState rather than declaring a second "which operation is in
progress" type, which could disagree with the merge resolver's.

ls-files -u prints one record per index stage, so the parser collapses to
unique paths — counting records triples an ordinary content conflict.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `RepoSignalsReader` — the git shell, with real-git coverage

**Files:**
- Create: `spike/seam1/Sources/Nudges/RepoSignalsReader.swift`
- Modify: `spike/seam1/Sources/Workbench/ConflictReader.swift:122` (`readState` visibility)
- Modify: `spike/seam1/Sources/WorktreeService.swift` (add `Git.gitDir`)
- Test: `spike/seam1/Tests/RepoSignalsIntegrationTests.swift`
- Modify: `spike/seam1/project.yml`

**Interfaces:**
- Consumes: `RepoSignals` + its parsers (Task 1); `GitStaging.run(_:cwd:stdin:env:)  -> GitResult` (`.ok(String)`/`.failed(String)`); `GitStaging.currentBranch(cwd:)`; `GitStaging.upstream(cwd:)`; `ConflictReader.readState(cwd:)`.
- Produces:
  - `RepoSignalsReader.read(cwd: String) -> RepoSignals?` — nil when `cwd` is not a work tree.
  - `RepoSignals.localDefaultBase(cwd: String) -> String?`
  - `Git.gitDir(_ dir: String) -> String?`

- [ ] **Step 1: Write the failing test**

Create `spike/seam1/Tests/RepoSignalsIntegrationTests.swift`:

```swift
import XCTest
@testable import Shepherd

/// Real `git`, real conflicts. The four ways a tree becomes unmerged leave DIFFERENT state
/// on disk, and a conflicted `stash apply` leaves no sequence record at all — the case that
/// shipped broken once already.
final class RepoSignalsIntegrationTests: XCTestCase {

    private var root: URL!

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("nudge-signals-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    // MARK: helpers

    /// Every call passes identity and disables signing: an unset `user.name` fails the
    /// commit, and GPG signing blocks on a passphrase prompt no test can answer.
    @discardableResult
    private func git(_ args: [String], in dir: String) -> GitResult {
        GitStaging.run(["-c", "user.name=T", "-c", "user.email=t@e",
                        "-c", "commit.gpgsign=false"] + args, cwd: dir)
    }

    private func write(_ text: String, _ name: String, in dir: String) throws {
        try text.write(toFile: (dir as NSString).appendingPathComponent(name),
                       atomically: true, encoding: .utf8)
    }

    /// A repo on `main` with `a.txt`, plus a `feature` branch whose `a.txt` conflicts.
    private func conflictingRepo() throws -> String {
        let dir = root.appendingPathComponent("repo").path
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        git(["init", "-b", "main"], in: dir)
        try write("base\n", "a.txt", in: dir)
        git(["add", "."], in: dir)
        git(["commit", "-m", "base"], in: dir)

        git(["checkout", "-b", "feature"], in: dir)
        try write("feature\n", "a.txt", in: dir)
        git(["commit", "-am", "feature"], in: dir)

        git(["checkout", "main"], in: dir)
        try write("main\n", "a.txt", in: dir)
        git(["commit", "-am", "main"], in: dir)
        return dir
    }

    // MARK: the four flavours

    func testMergeConflict() throws {
        let dir = try conflictingRepo()
        git(["merge", "feature"], in: dir)

        let s = try XCTUnwrap(RepoSignalsReader.read(cwd: dir))
        XCTAssertEqual(s.conflicts, 1)
        XCTAssertEqual(s.state.operation, .merge)
        XCTAssertEqual(s.branch, "main")
    }

    func testRebaseConflict() throws {
        let dir = try conflictingRepo()
        git(["checkout", "feature"], in: dir)
        git(["rebase", "main"], in: dir)

        let s = try XCTUnwrap(RepoSignalsReader.read(cwd: dir))
        XCTAssertEqual(s.conflicts, 1)
        XCTAssertEqual(s.state.operation, .rebase)
    }

    func testCherryPickConflict() throws {
        let dir = try conflictingRepo()
        git(["cherry-pick", "feature"], in: dir)

        let s = try XCTUnwrap(RepoSignalsReader.read(cwd: dir))
        XCTAssertEqual(s.conflicts, 1)
        XCTAssertEqual(s.state.operation, .cherryPick)
    }

    /// The `.loose` case: unmerged files with NO operation recorded anywhere.
    func testStashApplyConflictHasNoOperation() throws {
        let dir = try conflictingRepo()
        try write("stashed\n", "a.txt", in: dir)
        git(["stash"], in: dir)
        try write("other\n", "a.txt", in: dir)
        git(["commit", "-am", "other"], in: dir)
        git(["stash", "apply"], in: dir)

        let s = try XCTUnwrap(RepoSignalsReader.read(cwd: dir))
        XCTAssertEqual(s.conflicts, 1)
        XCTAssertEqual(s.state.operation, .none,
                       "a conflicted stash apply records no operation — this is the .loose case")
    }

    // MARK: a stopped sequence with nothing left conflicting

    func testResolvedButStillMidMerge() throws {
        let dir = try conflictingRepo()
        git(["merge", "feature"], in: dir)
        try write("resolved\n", "a.txt", in: dir)
        git(["add", "a.txt"], in: dir)

        let s = try XCTUnwrap(RepoSignalsReader.read(cwd: dir))
        XCTAssertEqual(s.conflicts, 0)
        XCTAssertEqual(s.state.operation, .merge,
                       "MERGE_HEAD survives resolving the last file — this is continueSequence")
    }

    // MARK: dirty / ahead / branch

    func testDirtyCountsUntrackedAndModified() throws {
        let dir = try conflictingRepo()
        try write("edited\n", "a.txt", in: dir)
        try write("new\n", "b.txt", in: dir)

        let s = try XCTUnwrap(RepoSignalsReader.read(cwd: dir))
        XCTAssertEqual(s.dirty, 2)
        XCTAssertEqual(s.conflicts, 0)
    }

    func testAheadOfUpstream() throws {
        let dir = try conflictingRepo()
        let originPath = root.appendingPathComponent("origin.git").path
        git(["init", "--bare", "-b", "main", originPath], in: dir)
        git(["remote", "add", "origin", originPath], in: dir)
        git(["push", "-u", "origin", "main"], in: dir)
        try write("more\n", "c.txt", in: dir)
        git(["add", "."], in: dir)
        git(["commit", "-m", "more"], in: dir)

        let s = try XCTUnwrap(RepoSignalsReader.read(cwd: dir))
        XCTAssertTrue(s.hasUpstream)
        XCTAssertEqual(s.ahead, 1)
    }

    /// No upstream and no `origin/HEAD` means there is no honest answer, so `ahead` stays 0.
    /// Counting all of `HEAD` instead would report every commit in history as unpushed.
    func testNoUpstreamAndNoOriginHeadReportsZeroAhead() throws {
        let dir = try conflictingRepo()
        let s = try XCTUnwrap(RepoSignalsReader.read(cwd: dir))
        XCTAssertFalse(s.hasUpstream)
        XCTAssertEqual(s.ahead, 0)
    }

    // MARK: not a repo

    func testNonRepoReturnsNil() throws {
        let plain = root.appendingPathComponent("plain").path
        try FileManager.default.createDirectory(atPath: plain, withIntermediateDirectories: true)
        XCTAssertNil(RepoSignalsReader.read(cwd: plain))
    }

    // MARK: worktrees

    /// In a linked worktree `.git` is a FILE pointing at `.git/worktrees/<name>`, and that
    /// directory is where MERGE_HEAD lives. `--absolute-git-dir` resolves it; watching the
    /// `.git` file itself would watch a pointer that never changes.
    func testLinkedWorktreeMidMergeIsSeen() throws {
        let dir = try conflictingRepo()
        let wt = root.appendingPathComponent("wt").path
        git(["worktree", "add", "-b", "wt-branch", wt, "main"], in: dir)
        git(["merge", "feature"], in: wt)

        let s = try XCTUnwrap(RepoSignalsReader.read(cwd: wt))
        XCTAssertEqual(s.conflicts, 1)
        XCTAssertEqual(s.state.operation, .merge)

        let gitDir = try XCTUnwrap(Git.gitDir(wt))
        XCTAssertTrue(gitDir.contains("worktrees/wt"),
                      "expected the per-worktree git dir, got \(gitDir)")
        XCTAssertTrue(FileManager.default
            .fileExists(atPath: (gitDir as NSString).appendingPathComponent("MERGE_HEAD")))
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd spike/seam1 && xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -20
```

Expected: compile failure, `cannot find 'RepoSignalsReader' in scope` and
`'readState' is inaccessible due to 'private' protection level`.

- [ ] **Step 3: Open up `ConflictReader.readState`**

In `spike/seam1/Sources/Workbench/ConflictReader.swift`, change line 122 from:

```swift
    private static func readState(cwd: String) -> MergeState {
```

to:

```swift
    /// Internal rather than private: `RepoSignalsReader` needs the operation without paying
    /// for `read`, which loads three blobs and diff3-merges every conflicted file.
    static func readState(cwd: String) -> MergeState {
```

- [ ] **Step 4: Add `Git.gitDir`**

In `spike/seam1/Sources/WorktreeService.swift`, inside `enum Git`, directly after the
`isWorkTree(_:)` function, add:

```swift
    /// The git dir backing `dir`, resolved. For a linked worktree this is
    /// `<common>/.git/worktrees/<name>` — where `MERGE_HEAD` and the sequence dirs
    /// actually live — not the `.git` *file* that points at it.
    static func gitDir(_ dir: String) -> String? {
        let r = run(["rev-parse", "--absolute-git-dir"], in: dir)
        guard r.code == 0 else { return nil }
        let path = r.out.trimmingCharacters(in: .whitespacesAndNewlines)
        return path.isEmpty ? nil : path
    }
```

- [ ] **Step 5: Write the reader**

Create `spike/seam1/Sources/Nudges/RepoSignalsReader.swift`:

```swift
import Foundation

/// Fills a `RepoSignals` from git.
///
/// Synchronous `Process` work — callers dispatch it off the main thread, like
/// `ConflictReader` and `DiffReader`. Every command here is local: this runs on each git
/// write in the repo, so a single fetch would turn a rebase into a network storm.
enum RepoSignalsReader {

    static func read(cwd: String) -> RepoSignals? {
        guard !cwd.isEmpty, case .ok = GitStaging.run(["rev-parse", "--is-inside-work-tree"],
                                                     cwd: cwd) else { return nil }
        var s = RepoSignals()
        s.state = ConflictReader.readState(cwd: cwd)
        s.branch = GitStaging.currentBranch(cwd: cwd)

        if case .ok(let z) = GitStaging.run(["ls-files", "-u", "-z"], cwd: cwd) {
            s.conflicts = RepoSignals.unmergedCount(lsFilesZ: z)
        }
        if case .ok(let porcelain) = GitStaging.run(["status", "--porcelain"], cwd: cwd) {
            s.dirty = RepoSignals.dirtyCount(porcelain: porcelain)
        }

        s.hasUpstream = GitStaging.upstream(cwd: cwd) != nil
        if let base = s.hasUpstream ? "@{upstream}" : RepoSignals.localDefaultBase(cwd: cwd),
           case .ok(let out) = GitStaging.run(["rev-list", "--count", "\(base)..HEAD"], cwd: cwd) {
            s.ahead = RepoSignals.revCount(out)
        }
        return s
    }
}

extension RepoSignals {

    /// origin's default branch, read **without touching the network**.
    ///
    /// Deliberately not `Git.defaultBaseRef`, which falls back to
    /// `git remote set-head origin --auto` — a remote round-trip, on a path that fires on
    /// every git write. No `origin/HEAD` locally ⇒ nil, and `ahead` stays 0: there is no
    /// honest count, and counting all of `HEAD` would report every commit ever made as
    /// unpushed.
    static func localDefaultBase(cwd: String) -> String? {
        guard case .ok(let out) = GitStaging.run(
            ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd: cwd) else { return nil }
        let ref = out.trimmingCharacters(in: .whitespacesAndNewlines)
        return ref.isEmpty ? nil : ref
    }
}
```

- [ ] **Step 6: Add the source to the test target**

In `spike/seam1/project.yml`, after the `RepoSignals.swift` entry from Task 1, add:

```yaml
      - path: Sources/Nudges/RepoSignalsReader.swift
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd spike/seam1 && xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  -only-testing:ShepherdModelTests/RepoSignalsIntegrationTests test 2>&1 \
  | grep -c "Test Case .* passed"
```

Expected: `10`.

- [ ] **Step 8: Commit**

```bash
git add spike/seam1/Sources/Nudges/RepoSignalsReader.swift \
        spike/seam1/Sources/Workbench/ConflictReader.swift \
        spike/seam1/Sources/WorktreeService.swift \
        spike/seam1/Tests/RepoSignalsIntegrationTests.swift spike/seam1/project.yml
git commit -m "$(cat <<'EOF'
feat(nudges): read RepoSignals from git, no network on the path

Reuses ConflictReader.readState (now internal) so there is one opinion about
which operation git is part-way through, without paying for read()'s blob
loads and diff3 merges.

Never calls Git.defaultBaseRef: its fallback runs `remote set-head --auto`,
and this reader fires on every git write. No origin/HEAD locally means ahead
stays 0 rather than reporting all of history as unpushed.

Real-git coverage for all four ways a tree becomes unmerged — merge, rebase,
cherry-pick and stash apply, the last recording no operation at all — plus a
linked worktree, where MERGE_HEAD lives in .git/worktrees/<name>.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `NudgeRegistry` — the only place that decides

**Files:**
- Create: `spike/seam1/Sources/Nudges/NudgeRegistry.swift`
- Test: `spike/seam1/Tests/NudgeRegistryTests.swift`
- Modify: `spike/seam1/project.yml`

**Interfaces:**
- Consumes: `RepoSignals` (Task 1); `AgentState` and `MergeState`; `WorkbenchScope` (declared in `Sources/DiffReader.swift:9`, already in the test target).
- Produces:
  - `enum NudgeID: String, CaseIterable { case resolveConflicts, continueSequence, reviewChanges, createPR }`
  - `enum NudgeBarPolicy { case always, firstFire, never }`
  - `enum NudgeUrgency { case attention, informational }`
  - `enum NudgeAction: Equatable { case openWorkbench(scope: WorkbenchScope), createPR }`
  - `struct NudgeGlyph` (`enum NudgeGlyph { case conflict, sequence, review, pullRequest }`)
  - `struct Nudge: Equatable` — `id`, `glyph`, `text`, `count: Int?`, `bar`, `urgency`, `action`
  - `struct PaneFacts` — `agentState`, `repo: RepoSignals?`, `hasPR: Bool`, `workbenchOpen: Bool`, `isRemote: Bool`, `provisioning: Bool`, `ghInstalled: Bool`, `onboarding: Bool`
  - `NudgeRegistry.nudges(for: PaneFacts) -> [Nudge]`
  - `NudgeRegistry.showsBar(_ nudge: Nudge, seen: Set<String>) -> Bool`

- [ ] **Step 1: Write the failing test**

Create `spike/seam1/Tests/NudgeRegistryTests.swift`:

```swift
import XCTest
@testable import Shepherd

final class NudgeRegistryTests: XCTestCase {

    // MARK: fixtures

    private func facts(conflicts: Int = 0,
                       operation: MergeState.Operation = .none,
                       dirty: Int = 0,
                       ahead: Int = 0,
                       agentState: AgentState = .idle,
                       hasPR: Bool = false,
                       workbenchOpen: Bool = false,
                       isRemote: Bool = false,
                       provisioning: Bool = false,
                       ghInstalled: Bool = true,
                       onboarding: Bool = false) -> PaneFacts {
        var repo = RepoSignals()
        repo.conflicts = conflicts
        repo.dirty = dirty
        repo.ahead = ahead
        repo.state = MergeState(operation: operation, oursLabel: "main",
                                theirsLabel: "feature", progress: nil)
        return PaneFacts(agentState: agentState, repo: repo, hasPR: hasPR,
                         workbenchOpen: workbenchOpen, isRemote: isRemote,
                         provisioning: provisioning, ghInstalled: ghInstalled,
                         onboarding: onboarding)
    }

    private func ids(_ f: PaneFacts) -> [NudgeID] {
        NudgeRegistry.nudges(for: f).map(\.id)
    }

    // MARK: resolveConflicts

    func testConflictsProduceResolveNudge() {
        let n = NudgeRegistry.nudges(for: facts(conflicts: 3, operation: .merge))
        let first = n.first
        XCTAssertEqual(first?.id, .resolveConflicts)
        XCTAssertEqual(first?.count, 3)
        XCTAssertEqual(first?.bar, .always)
        XCTAssertEqual(first?.urgency, .attention)
        XCTAssertEqual(first?.action, .openWorkbench(scope: .files))
    }

    /// A conflicted stash apply — conflicts with no operation. Still resolvable.
    func testLooseConflictsProduceResolveNudge() {
        XCTAssertEqual(ids(facts(conflicts: 1, operation: .none)).first, .resolveConflicts)
    }

    // MARK: continueSequence

    func testActiveSequenceWithNoConflictsProducesContinue() {
        let n = NudgeRegistry.nudges(for: facts(conflicts: 0, operation: .rebase))
        XCTAssertEqual(n.first?.id, .continueSequence)
        XCTAssertEqual(n.first?.bar, .always)
        XCTAssertEqual(n.first?.urgency, .attention)
        XCTAssertNil(n.first?.count, "there is nothing to count once conflicts are resolved")
    }

    func testResolveAndContinueAreMutuallyExclusive() {
        let both = ids(facts(conflicts: 2, operation: .rebase))
        XCTAssertTrue(both.contains(.resolveConflicts))
        XCTAssertFalse(both.contains(.continueSequence))
    }

    // MARK: reviewChanges

    func testDirtyIdlePaneProducesReviewNudge() {
        let n = NudgeRegistry.nudges(for: facts(dirty: 14, agentState: .idle))
        let review = n.first { $0.id == .reviewChanges }
        XCTAssertEqual(review?.count, 14)
        XCTAssertEqual(review?.bar, .firstFire)
        XCTAssertEqual(review?.urgency, .informational)
        XCTAssertEqual(review?.action, .openWorkbench(scope: .workingTree))
    }

    func testDirtyNeedsCheckPaneProducesReviewNudge() {
        XCTAssertTrue(ids(facts(dirty: 1, agentState: .needsCheck)).contains(.reviewChanges))
    }

    /// Mid-turn there is nothing settled to review.
    func testWorkingPaneProducesNoReviewNudge() {
        XCTAssertFalse(ids(facts(dirty: 9, agentState: .working)).contains(.reviewChanges))
    }

    func testCleanTreeProducesNoReviewNudge() {
        XCTAssertFalse(ids(facts(dirty: 0, agentState: .idle)).contains(.reviewChanges))
    }

    /// You are already looking at the diff.
    func testOpenWorkbenchSuppressesReviewNudge() {
        XCTAssertFalse(ids(facts(dirty: 4, agentState: .idle, workbenchOpen: true))
            .contains(.reviewChanges))
    }

    // MARK: createPR

    func testCommitsAheadWithNoPRProducesCreatePR() {
        let n = NudgeRegistry.nudges(for: facts(ahead: 3))
        let pr = n.first { $0.id == .createPR }
        XCTAssertEqual(pr?.count, 3)
        XCTAssertEqual(pr?.bar, .firstFire)
        XCTAssertEqual(pr?.urgency, .informational)
        XCTAssertEqual(pr?.action, .createPR)
    }

    func testExistingPRSuppressesCreatePR() {
        XCTAssertFalse(ids(facts(ahead: 3, hasPR: true)).contains(.createPR))
    }

    /// Every PR feature is gated on `gh`, since a GUI .app misses Homebrew's PATH.
    func testNoGhSuppressesCreatePR() {
        XCTAssertFalse(ids(facts(ahead: 3, ghInstalled: false)).contains(.createPR))
    }

    // MARK: precedence

    func testConflictOutranksReviewAndPR() {
        let order = ids(facts(conflicts: 1, operation: .merge, dirty: 5, ahead: 2))
        XCTAssertEqual(order.first, .resolveConflicts)
    }

    func testReviewOutranksCreatePR() {
        let order = ids(facts(dirty: 5, ahead: 2, agentState: .idle))
        XCTAssertEqual(order, [.reviewChanges, .createPR])
    }

    /// A waiting agent is more urgent than a conflict, so the pane offers no nudge glyph
    /// that could displace the blocked dot.
    func testBlockedAgentOutranksEverything() {
        XCTAssertTrue(NudgeRegistry.nudges(for: facts(conflicts: 2, operation: .merge,
                                                      agentState: .blocked)).isEmpty)
    }

    func testErrorAgentOutranksEverything() {
        XCTAssertTrue(NudgeRegistry.nudges(for: facts(conflicts: 2, operation: .merge,
                                                      agentState: .error)).isEmpty)
    }

    // MARK: suppressions

    func testOnboardingSuppressesEverything() {
        XCTAssertTrue(NudgeRegistry.nudges(for: facts(conflicts: 3, operation: .merge,
                                                      onboarding: true)).isEmpty)
    }

    func testRemoteWorkspaceSuppressesEverything() {
        XCTAssertTrue(NudgeRegistry.nudges(for: facts(conflicts: 3, operation: .merge,
                                                      isRemote: true)).isEmpty)
    }

    func testProvisioningPaneSuppressesEverything() {
        XCTAssertTrue(NudgeRegistry.nudges(for: facts(conflicts: 3, operation: .merge,
                                                      provisioning: true)).isEmpty)
    }

    func testNoRepoProducesNothing() {
        let f = PaneFacts(agentState: .idle, repo: nil, hasPR: false, workbenchOpen: false,
                          isRemote: false, provisioning: false, ghInstalled: true,
                          onboarding: false)
        XCTAssertTrue(NudgeRegistry.nudges(for: f).isEmpty)
    }

    // MARK: bar policy — independent of urgency

    func testAlwaysBarShowsEvenWhenSeen() {
        let n = NudgeRegistry.nudges(for: facts(conflicts: 1, operation: .merge))[0]
        XCTAssertTrue(NudgeRegistry.showsBar(n, seen: [NudgeID.resolveConflicts.rawValue]))
    }

    func testFirstFireBarShowsOnceThenNever() {
        let n = NudgeRegistry.nudges(for: facts(dirty: 2, agentState: .idle))[0]
        XCTAssertEqual(n.id, .reviewChanges)
        XCTAssertTrue(NudgeRegistry.showsBar(n, seen: []))
        XCTAssertFalse(NudgeRegistry.showsBar(n, seen: [NudgeID.reviewChanges.rawValue]))
    }

    /// `bar` and `urgency` are separate axes. Collapsing them is the obvious future
    /// regression, so it is pinned: an informational nudge can still be barred, and an
    /// attention nudge's bar policy says nothing about the badge.
    func testBarAndUrgencyAreIndependent() {
        let conflict = NudgeRegistry.nudges(for: facts(conflicts: 1, operation: .merge))[0]
        let review = NudgeRegistry.nudges(for: facts(dirty: 2, agentState: .idle))[0]
        XCTAssertEqual(conflict.urgency, .attention)
        XCTAssertEqual(conflict.bar, .always)
        XCTAssertEqual(review.urgency, .informational)
        XCTAssertEqual(review.bar, .firstFire)
    }

    // MARK: catalogue integrity

    func testEveryNudgeIDIsReachable() {
        var seen = Set<NudgeID>()
        seen.formUnion(ids(facts(conflicts: 1, operation: .merge)))
        seen.formUnion(ids(facts(operation: .rebase)))
        seen.formUnion(ids(facts(dirty: 3, ahead: 1, agentState: .idle)))
        XCTAssertEqual(seen, Set(NudgeID.allCases))
    }

    func testRawValuesAreStableAndUnique() {
        // These strings are persisted in `shepherd.nudge.seen` — renaming one silently
        // re-shows a tip the user already dismissed.
        XCTAssertEqual(Set(NudgeID.allCases.map(\.rawValue)).count, NudgeID.allCases.count)
        XCTAssertEqual(NudgeID.reviewChanges.rawValue, "reviewChanges")
        XCTAssertEqual(NudgeID.createPR.rawValue, "createPR")
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd spike/seam1 && xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -20
```

Expected: `cannot find 'NudgeRegistry' in scope`.

- [ ] **Step 3: Write the implementation**

Create `spike/seam1/Sources/Nudges/NudgeRegistry.swift`:

```swift
import Foundation

/// Which nudge. The raw values are persisted in `shepherd.nudge.seen`, so renaming one
/// re-shows a tip the user already dismissed.
enum NudgeID: String, CaseIterable {
    case resolveConflicts, continueSequence, reviewChanges, createPR
}

/// Whether this nudge is eligible for the pane bar, and how often. Orthogonal to
/// `NudgeUrgency`: this decides chrome, that decides the badge.
enum NudgeBarPolicy { case always, firstFire, never }

/// Whether this nudge joins the attention rollups (dock badge, folder dot, ⌘⇧A).
enum NudgeUrgency { case attention, informational }

/// The glyph, named rather than drawn — the registry is pure and must not import SwiftUI.
enum NudgeGlyph { case conflict, sequence, review, pullRequest }

enum NudgeAction: Equatable {
    case openWorkbench(scope: WorkbenchScope)
    case createPR
}

struct Nudge: Equatable {
    let id: NudgeID
    let glyph: NudgeGlyph
    let text: String
    let count: Int?
    let bar: NudgeBarPolicy
    let urgency: NudgeUrgency
    let action: NudgeAction
}

/// Everything a nudge may read about one pane. Assembled by `AgentStore`; nothing here is
/// an event, so the registry stays a function of the present.
struct PaneFacts {
    var agentState: AgentState
    var repo: RepoSignals?
    var hasPR: Bool
    var workbenchOpen: Bool
    var isRemote: Bool
    var provisioning: Bool
    var ghInstalled: Bool
    var onboarding: Bool
}

/// The single place that decides which nudges a pane has.
///
/// Adding one is a row here plus a case in `NudgeRegistryTests` — the shape
/// `ShortcutCatalog` and `StopPolicy` already have.
enum NudgeRegistry {

    static func nudges(for f: PaneFacts) -> [Nudge] {
        // The tour's sandbox stages a real merge conflict on purpose; a mirror workspace's
        // repo lives on the host; a provisioning pane has no directory yet.
        guard !f.onboarding, !f.isRemote, !f.provisioning, let repo = f.repo else { return [] }
        // A waiting or failed agent outranks anything git has to say, and its dot must not
        // be displaced by a nudge glyph.
        guard f.agentState != .blocked, f.agentState != .error else { return [] }

        var out: [Nudge] = []

        if repo.conflicts > 0 {
            out.append(Nudge(
                id: .resolveConflicts,
                glyph: .conflict,
                text: conflictText(repo),
                count: repo.conflicts,
                bar: .always,
                urgency: .attention,
                action: .openWorkbench(scope: .files)))
        } else if repo.state.isActive {
            // The sequence is half-applied with nothing left conflicting — one --continue
            // from done, and nothing else in Shepherd says so.
            out.append(Nudge(
                id: .continueSequence,
                glyph: .sequence,
                text: repo.state.summary ?? "Operation in progress",
                count: nil,
                bar: .always,
                urgency: .attention,
                action: .openWorkbench(scope: .files)))
        }

        // A finished turn is observable as the state it lands in, so this stays a predicate
        // over the present rather than a stored "a turn ended" flag.
        if repo.dirty > 0, f.agentState == .idle || f.agentState == .needsCheck,
           !f.workbenchOpen {
            out.append(Nudge(
                id: .reviewChanges,
                glyph: .review,
                text: "\(repo.dirty) file\(repo.dirty == 1 ? "" : "s") changed",
                count: repo.dirty,
                bar: .firstFire,
                urgency: .informational,
                action: .openWorkbench(scope: .workingTree)))
        }

        if repo.ahead > 0, !f.hasPR, f.ghInstalled {
            out.append(Nudge(
                id: .createPR,
                glyph: .pullRequest,
                text: "\(repo.ahead) commit\(repo.ahead == 1 ? "" : "s"), no PR",
                count: repo.ahead,
                bar: .firstFire,
                urgency: .informational,
                action: .createPR))
        }

        return out
    }

    /// Does this nudge draw the pane bar, given the ids already shown once?
    static func showsBar(_ nudge: Nudge, seen: Set<String>) -> Bool {
        switch nudge.bar {
        case .always:    return true
        case .never:     return false
        case .firstFire: return !seen.contains(nudge.id.rawValue)
        }
    }

    private static func conflictText(_ repo: RepoSignals) -> String {
        let n = repo.conflicts
        let count = "\(n) conflict\(n == 1 ? "" : "s")"
        switch repo.state.operation {
        case .merge:      return "Merge stopped · \(count)"
        case .rebase:     return "Rebase stopped · \(count)"
        case .cherryPick: return "Cherry-pick stopped · \(count)"
        // No operation recorded anywhere — a conflicted stash apply, `checkout -m` or
        // `apply -3`. git distinguishes none of the three, so neither does this.
        case .none:       return count
        }
    }
}
```

- [ ] **Step 4: Add the source to the test target**

In `spike/seam1/project.yml`, after the `RepoSignalsReader.swift` entry, add:

```yaml
      - path: Sources/Nudges/NudgeRegistry.swift
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd spike/seam1 && xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  -only-testing:ShepherdModelTests/NudgeRegistryTests test 2>&1 | grep -c "Test Case .* passed"
```

Expected: `24`.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/Nudges/NudgeRegistry.swift spike/seam1/Tests/NudgeRegistryTests.swift spike/seam1/project.yml
git commit -m "$(cat <<'EOF'
feat(nudges): NudgeRegistry — the only place that decides

Four nudges as data: resolveConflicts, continueSequence, reviewChanges,
createPR. Adding a fifth is a row plus a test case.

Every condition is a predicate over present facts, never an event — a
finished turn is observable as the state it lands in, so nothing needs a
stored "a turn ended" flag.

bar and urgency are separate axes (chrome vs badge) and a test pins that,
since collapsing them is the obvious future regression.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `PaneChrome` — the bar slot that cannot remount a surface

Structural only, and generic so it carries no `Theme`/`TablerIcon` dependency and can live
in the test target. The concrete bar arrives in Task 6.

**Files:**
- Create: `spike/seam1/Sources/Nudges/PaneChrome.swift`
- Test: `spike/seam1/Tests/PaneChromeTests.swift`
- Modify: `spike/seam1/project.yml`

**Interfaces:**
- Produces: `PaneChrome<Bar: View, Content: View>` with `init(bar: () -> Bar, content: () -> Content)`.

- [ ] **Step 1: Write the failing test**

Create `spike/seam1/Tests/PaneChromeTests.swift`:

```swift
import XCTest
import SwiftUI
@testable import Shepherd

/// A conditional that WRAPS a live surface tears it down: `if x { c.mod() } else { c }` is a
/// `_ConditionalContent`, so flipping x rebuilds the subtree — a new `ghostty_surface_t`, a
/// new PTY, and the old shell's `claude` hangs up. It shipped once via
/// `.onboardingAnchor(…, if:)` and was invisible, because a remounted plain shell looks
/// exactly like the original.
///
/// `PaneChrome` therefore keeps the content in ONE structural position and lets the bar's
/// own view decide whether it draws anything.
final class PaneChromeTests: XCTestCase {

    /// Counts how many backing views SwiftUI creates for it.
    private struct CountingRep: NSViewRepresentable {
        final class Box { var made = 0 }
        let box: Box
        func makeNSView(context: Context) -> NSView { box.made += 1; return NSView() }
        func updateNSView(_ view: NSView, context: Context) {}
    }

    private func flush() {
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    }

    func testTogglingTheBarDoesNotRemountTheContent() {
        let box = CountingRep.Box()

        func tree(showBar: Bool) -> some View {
            PaneChrome {
                if showBar { Color.red.frame(height: 26) }
            } content: {
                CountingRep(box: box)
            }
            .frame(width: 400, height: 300)
        }

        let host = NSHostingView(rootView: AnyView(tree(showBar: false)))
        host.frame = CGRect(x: 0, y: 0, width: 400, height: 300)
        let window = NSWindow(contentRect: host.frame, styleMask: [.titled],
                              backing: .buffered, defer: false)
        window.contentView = host
        flush()
        XCTAssertEqual(box.made, 1, "the surface should mount exactly once")

        host.rootView = AnyView(tree(showBar: true))
        flush()
        XCTAssertEqual(box.made, 1, "showing the bar must not rebuild the surface")

        host.rootView = AnyView(tree(showBar: false))
        flush()
        XCTAssertEqual(box.made, 1, "hiding the bar must not rebuild the surface either")
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd spike/seam1 && xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -20
```

Expected: `cannot find 'PaneChrome' in scope`.

- [ ] **Step 3: Write the implementation**

Create `spike/seam1/Sources/Nudges/PaneChrome.swift`:

```swift
import SwiftUI

/// A pane's chrome slot above its content.
///
/// The bar is **always** in the tree; whether it draws is the bar's own business. Making
/// the *content*'s position depend on a condition would put it inside a
/// `_ConditionalContent`, and a live libghostty surface cannot survive that: flipping the
/// flag rebuilds the subtree, `makeNSView` runs again, and the previous PTY — with whatever
/// was running in it — hangs up.
struct PaneChrome<Bar: View, Content: View>: View {
    @ViewBuilder var bar: () -> Bar
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(spacing: 0) {
            bar()
            content()
        }
    }
}
```

- [ ] **Step 4: Add the source to the test target**

In `spike/seam1/project.yml`, after the `NudgeRegistry.swift` entry, add:

```yaml
      - path: Sources/Nudges/PaneChrome.swift
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd spike/seam1 && xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  -only-testing:ShepherdModelTests/PaneChromeTests test 2>&1 | grep -c "Test Case .* passed"
```

Expected: `1`.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/Nudges/PaneChrome.swift spike/seam1/Tests/PaneChromeTests.swift spike/seam1/project.yml
git commit -m "$(cat <<'EOF'
feat(nudges): PaneChrome — a bar slot that can't remount the surface

The bar is always in the tree and decides for itself whether it draws. Making
the content's position conditional would put a live libghostty surface inside
a _ConditionalContent, which rebuilds it — new surface, new PTY, and the old
shell's agent hangs up. Pinned by counting makeNSView calls across a toggle.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `RepoWatcher` + store wiring

The first task with no pure component: it is a `DispatchSource` and a dictionary. Verified
by compiling and by the store's facts feeding the already-tested registry.

**Files:**
- Create: `spike/seam1/Sources/Nudges/RepoWatcher.swift`
- Modify: `spike/seam1/Sources/AgentStore.swift`

**Interfaces:**
- Consumes: `RepoSignals`, `RepoSignalsReader.read(cwd:)`, `Git.gitDir(_:)`, `NudgeRegistry`, `PaneFacts`.
- Produces:
  - `final class RepoWatcher` — `@MainActor`, `init(onChange: @escaping (String) -> Void)`, `watch(paneID: String, cwd: String)`, `unwatch(paneID: String)`, `refresh(paneID: String)`, `signals(forPane:) -> RepoSignals?`.
  - `AgentStore.repoSignals: [String: RepoSignals]` (published)
  - `AgentStore.nudges(forPane paneID: String) -> [Nudge]`
  - `AgentStore.barNudge(forPane paneID: String) -> Nudge?`
  - `AgentStore.markNudgeSeen(_ id: NudgeID)`
  - `AgentStore.run(_ action: NudgeAction, forPane paneID: String)`

- [ ] **Step 1: Write the watcher**

Create `spike/seam1/Sources/Nudges/RepoWatcher.swift`:

```swift
import Foundation

/// Keeps `RepoSignals` current for every pane whose cwd is a git work tree.
///
/// One vnode watch per **git dir**, refcounted across panes — several panes normally sit in
/// one repo, and one watch per pane would open the same directory a dozen times. Reads are
/// debounced because a single `git merge` writes the dir many times.
@MainActor
final class RepoWatcher {

    private struct Watch {
        let source: DispatchSourceFileSystemObject
        let descriptor: Int32
        var paneIDs: Set<String>
    }

    /// Keyed by git dir.
    private var watches: [String: Watch] = [:]
    /// paneID → (cwd, git dir), so `unwatch` can find its watch without a git call.
    private var panes: [String: (cwd: String, gitDir: String)] = [:]
    private var signalsByPane: [String: RepoSignals] = [:]
    private var pending: [String: DispatchWorkItem] = [:]

    private let onChange: (String) -> Void

    init(onChange: @escaping (String) -> Void) {
        self.onChange = onChange
    }

    func signals(forPane paneID: String) -> RepoSignals? { signalsByPane[paneID] }

    /// Begin tracking `paneID` at `cwd`. Idempotent for an unchanged cwd; a changed cwd
    /// (the pane was told to `cd`) rebinds it.
    func watch(paneID: String, cwd: String) {
        if let existing = panes[paneID], existing.cwd == cwd { return }
        unwatch(paneID: paneID)
        guard !cwd.isEmpty else { return }

        let dir = cwd
        Task.detached(priority: .utility) {
            let gitDir = Git.gitDir(dir)
            await MainActor.run { [weak self] in
                guard let self, let gitDir else { return }
                // The pane may have been closed or moved while git ran.
                guard self.panes[paneID] == nil else { return }
                self.panes[paneID] = (cwd: dir, gitDir: gitDir)
                self.attach(gitDir: gitDir, paneID: paneID)
                self.refresh(paneID: paneID)
            }
        }
    }

    func unwatch(paneID: String) {
        pending.removeValue(forKey: paneID)?.cancel()
        signalsByPane.removeValue(forKey: paneID)
        guard let entry = panes.removeValue(forKey: paneID) else { return }
        guard var watch = watches[entry.gitDir] else { return }
        watch.paneIDs.remove(paneID)
        if watch.paneIDs.isEmpty {
            watch.source.cancel()          // its cancel handler closes the descriptor
            watches.removeValue(forKey: entry.gitDir)
        } else {
            watches[entry.gitDir] = watch
        }
    }

    func unwatchAll() {
        for paneID in panes.keys { unwatch(paneID: paneID) }
    }

    /// Re-read one pane now, debounced.
    func refresh(paneID: String) {
        guard let entry = panes[paneID] else { return }
        pending.removeValue(forKey: paneID)?.cancel()
        let item = DispatchWorkItem { [weak self] in
            let fresh = RepoSignalsReader.read(cwd: entry.cwd)
            Task { @MainActor [weak self] in
                guard let self, self.panes[paneID]?.cwd == entry.cwd else { return }
                guard self.signalsByPane[paneID] != fresh else { return }
                self.signalsByPane[paneID] = fresh
                self.onChange(paneID)
            }
        }
        pending[paneID] = item
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 0.2, execute: item)
    }

    // MARK: - private

    private func attach(gitDir: String, paneID: String) {
        if var existing = watches[gitDir] {
            existing.paneIDs.insert(paneID)
            watches[gitDir] = existing
            return
        }
        let fd = open(gitDir, O_EVTONLY)
        guard fd >= 0 else { return }
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .rename, .delete],
            queue: .main)
        source.setEventHandler { [weak self] in
            guard let self, let watch = self.watches[gitDir] else { return }
            for pane in watch.paneIDs { self.refresh(paneID: pane) }
        }
        source.setCancelHandler { close(fd) }
        watches[gitDir] = Watch(source: source, descriptor: fd, paneIDs: [paneID])
        source.resume()
    }
}
```

- [ ] **Step 2: Wire it into `AgentStore`**

In `spike/seam1/Sources/AgentStore.swift`, beside the `prStatuses` declaration (around
line 45), add:

```swift
    /// Live git facts per pane, kept current by `repoWatcher`. Transient — never persisted.
    @Published private(set) var repoSignals: [String: RepoSignals] = [:]
    /// Nudge ids whose first-fire bar has been shown. Persisted so a tip appears once.
    private var nudgesSeen: Set<String> =
        Set(UserDefaults.standard.stringArray(forKey: "shepherd.nudge.seen") ?? [])
    /// Pane+nudge pairs whose bar the user dismissed for this occurrence.
    private var barsDismissed: Set<String> = []

    private lazy var repoWatcher = RepoWatcher { [weak self] paneID in
        guard let self else { return }
        self.repoSignals[paneID] = self.repoWatcher.signals(forPane: paneID)
        self.updateBadge()
    }
```

Then add this section near `workbenchSession(forPane:)` (around line 1085):

```swift
    // MARK: - Nudges

    /// Start/stop watching every pane's checkout. Cheap and idempotent — call it after any
    /// mutation that adds, removes or moves a pane.
    func syncRepoWatches() {
        var live = Set<String>()
        for ws in workspaces where !ws.isRemote {
            for tab in ws.tabs {
                for pane in tab.root.panes where !pane.provisioning {
                    live.insert(pane.paneID)
                    repoWatcher.watch(paneID: pane.paneID, cwd: pane.cwd)
                }
            }
        }
        for paneID in repoSignals.keys where !live.contains(paneID) {
            repoWatcher.unwatch(paneID: paneID)
            repoSignals.removeValue(forKey: paneID)
        }
    }

    func refreshRepoSignals(forPane paneID: String) {
        repoWatcher.refresh(paneID: paneID)
    }

    func facts(forPane paneID: String) -> PaneFacts? {
        guard let found = locatePane(paneID, in: workspaces) else { return nil }
        let pane = found.pane
        return PaneFacts(
            agentState: pane.state,
            repo: repoSignals[paneID],
            hasPR: prStatuses[paneID] != nil,
            workbenchOpen: workbenchVisiblePaneIDs.contains(paneID),
            isRemote: workspaces[found.workspaceIndex].isRemote,
            provisioning: pane.provisioning,
            ghInstalled: GH.isInstalled,
            onboarding: onboarding != nil)
    }

    func nudges(forPane paneID: String) -> [Nudge] {
        guard let facts = facts(forPane: paneID) else { return [] }
        return NudgeRegistry.nudges(for: facts)
    }

    /// The nudge whose bar this pane should draw, if any.
    func barNudge(forPane paneID: String) -> Nudge? {
        nudges(forPane: paneID).first {
            NudgeRegistry.showsBar($0, seen: nudgesSeen)
                && !barsDismissed.contains("\(paneID)|\($0.id.rawValue)")
        }
    }

    /// A first-fire bar is spent once drawn.
    func markNudgeSeen(_ id: NudgeID) {
        guard nudgesSeen.insert(id.rawValue).inserted else { return }
        UserDefaults.standard.set(Array(nudgesSeen), forKey: "shepherd.nudge.seen")
    }

    /// Hide this pane's bar until the condition goes away and comes back. The sidebar glyph
    /// is untouched: it reports a state, and a conflict you dismissed is still a conflict.
    func dismissBar(_ id: NudgeID, forPane paneID: String) {
        barsDismissed.insert("\(paneID)|\(id.rawValue)")
        objectWillChange.send()
    }

    func run(_ action: NudgeAction, forPane paneID: String) {
        switch action {
        case .openWorkbench(let scope):
            revealPane(paneID)
            setWorkbenchVisible(true, forPane: paneID)
            workbenchSession(forPane: paneID)?.setScope(scope)
        case .createPR:
            presentPRCreateDialog(forPane: paneID)
        }
    }
```

> **Adapt to what exists.** `workbenchVisiblePaneIDs`, `setWorkbenchVisible(_:forPane:)` and
> `locatePane`'s exact return shape are named for how the store already tracks workbench
> visibility and resolves panes (`⌘G` is `ShortcutID.toggleWorkbench`). Read
> `AgentStore.swift` and `ShortcutActions.run(_:)` first and use the real names — do not add
> a second way to open the workbench. `presentPRCreateDialog` arrives in Task 9; until then
> make that case `break` with a `// Task 9` marker so the build stays green.

- [ ] **Step 3: Call `syncRepoWatches` from the mutation points**

Add a `syncRepoWatches()` call at the end of each of: `newTab`, `closeTab`, `split`,
`closePane`, `moveTab`, `select(tabID:inWorkspace:)`, the persistence-restore path, and
wherever a pane's `cwd` is updated from libghostty's `PWD` action. Add
`refreshRepoSignals(forPane:)` at:

- the end of `didFocus(_:)` — so focusing a pane re-reads its repo;
- inside `applyTransition` where the transition's `turnFinished` is already consulted, next
  to the existing PR refresh.

> `turnFinished`, not `state == .needsCheck` — a turn that finishes while you watch lands
> `idle` and would be missed.

- [ ] **Step 4: Verify it compiles**

```bash
cd spike/seam1 && xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -5
```

Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 5: Re-run every existing suite to confirm nothing regressed**

```bash
cd spike/seam1
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache test 2>&1 \
  | grep -E "Test Case .* failed|TEST (SUCCEEDED|FAILED)" | tail -20
```

Expected: `** TEST SUCCEEDED **` and no `failed` lines.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/Nudges/RepoWatcher.swift spike/seam1/Sources/AgentStore.swift
git commit -m "$(cat <<'EOF'
feat(nudges): watch each repo's git dir and publish RepoSignals

One vnode watch per git dir, refcounted across panes — panes normally share a
repo — debounced 200ms because a single merge writes the dir many times. The
watch is on `rev-parse --absolute-git-dir`, so a linked worktree is followed to
.git/worktrees/<name> where MERGE_HEAD actually lives.

Re-reads also on focus and on turnFinished (not state == .needsCheck, which
misses a turn that finished while you were watching).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: The two render surfaces

**Files:**
- Create: `spike/seam1/Sources/Nudges/NudgeBarView.swift`
- Modify: `spike/seam1/Sources/SidebarView.swift:476-505` and `SidebarView.swift` (icon map)
- Modify: `spike/seam1/Sources/SplitContainer.swift:36-56`

**Interfaces:**
- Consumes: `Nudge`, `NudgeGlyph`, `AgentStore.barNudge(forPane:)`, `AgentStore.run(_:forPane:)`, `AgentStore.markNudgeSeen(_:)`, `AgentStore.dismissBar(_:forPane:)`, `PaneChrome`, `TablerIcon`/`Tabler` (both in `SidebarView.swift`), `Theme`.
- Produces: `NudgeBarView`, `NudgeChip`, `Tabler.paths(for: NudgeGlyph) -> [String]`.

- [ ] **Step 1: Map glyphs to the icon set**

In `spike/seam1/Sources/SidebarView.swift`, inside `enum Tabler`, add:

```swift
    static func paths(for glyph: NudgeGlyph) -> [String] {
        switch glyph {
        case .conflict, .sequence: return gitMerge
        case .review:              return file
        case .pullRequest:         return pullRequest
        }
    }
```

- [ ] **Step 2: Write the bar**

Create `spike/seam1/Sources/Nudges/NudgeBarView.swift`:

```swift
import SwiftUI

/// The one-line strip above a pane: what is true, and the one thing to do about it.
///
/// Renders nothing at all when there is no nudge, so the pane's content keeps a single
/// structural position (see `PaneChrome`).
struct NudgeBarView: View {
    @EnvironmentObject var store: AgentStore
    let paneID: String

    private var nudge: Nudge? { store.barNudge(forPane: paneID) }

    var body: some View {
        Group {
            if let nudge {
                HStack(spacing: 8) {
                    TablerIcon(paths: Tabler.paths(for: nudge.glyph), size: 12)
                        .foregroundStyle(tint(nudge))
                    Text(nudge.text)
                        .font(.ui(11))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    Button(label(nudge)) { store.run(nudge.action, forPane: paneID) }
                        .buttonStyle(.plain)
                        .font(.ui(11, .medium))
                        .foregroundStyle(tint(nudge))
                        .focusable(false)
                    Button {
                        store.dismissBar(nudge.id, forPane: paneID)
                    } label: {
                        TablerIcon(paths: Tabler.squareMinus, size: 10)
                            .foregroundStyle(Theme.textDim)
                    }
                    .buttonStyle(.plain)
                    .focusable(false)
                }
                .padding(.horizontal, 10)
                .frame(height: 26)
                .background(Theme.panel)
                .overlay(alignment: .bottom) {
                    Rectangle().fill(Theme.hairline).frame(height: 1)
                }
                // A first-fire bar is spent the moment it is drawn.
                .onAppear { store.markNudgeSeen(nudge.id) }
            }
        }
    }

    private func tint(_ n: Nudge) -> Color {
        switch n.urgency {
        case .attention:     return Theme.blocked
        case .informational: return Theme.textDim
        }
    }

    private func label(_ n: Nudge) -> String {
        switch n.id {
        case .resolveConflicts: return "Resolve"
        case .continueSequence: return "Continue"
        case .reviewChanges:    return "Review ⌘G"
        case .createPR:         return "Create PR"
        }
    }
}
```

> Check the real token names in `Theme.swift` (`panel`, `hairline`, `blocked`, `textDim`,
> `textPrimary`, `.ui(_:_:)`) and use whatever exists — do not add new tokens.

- [ ] **Step 3: Mount it in the pane leaf**

In `spike/seam1/Sources/SplitContainer.swift`, replace the leaf's `Group { … }` (lines
36-48) with:

```swift
                        PaneChrome {
                            // Only the pane you are looking at gets the bar; a starved
                            // sibling is 0×0 and a background tab's bar would draw nothing
                            // useful.
                            if isVisible { NudgeBarView(paneID: pane.paneID) }
                        } content: {
                            // A provisioning pane has no directory yet — show the loading
                            // view and hold off mounting the surface until it clears.
                            if pane.provisioning {
                                WorktreeProvisioningView(name: pane.displayTitle)
                            } else {
                                GhosttyTerminal(paneID: pane.paneID,
                                                isVisible: isVisible,
                                                isSelected: isTabSelected && isFocused,
                                                focusTick: focusTick)
                            }
                        }
```

Leave every modifier after it (`.opacity`, `.overlay`, `.allowsHitTesting`) exactly as it is.

- [ ] **Step 4: Add the sidebar glyph and chip**

In `spike/seam1/Sources/SidebarView.swift`, in `TabRow`'s `body`, replace the
`if state == .idle, let pr = … } else { LeadingIcon(…) }` block (lines 476-486) with:

```swift
                if let nudge = store.nudges(forPane: tab.focusedPaneID).first {
                    Button { store.run(nudge.action, forPane: tab.focusedPaneID) } label: {
                        TablerIcon(paths: Tabler.paths(for: nudge.glyph), size: 13)
                            .foregroundStyle(nudge.urgency == .attention
                                             ? Theme.blocked : Theme.textDim)
                    }
                    .buttonStyle(.plain)
                    .focusable(false)
                    .frame(width: 14, height: 14)
                    .help(nudge.text)
                } else if state == .idle, let pr = store.prStatuses[tab.focusedPaneID],
                          let kind = store.prKind(forPane: tab.focusedPaneID) {
                    PRStatusIcon(status: pr, kind: kind,
                                 unresolvedCount: PRThreads.unresolvedCount(store.reviewThreads[tab.focusedPaneID] ?? [])) {
                        store.openPR(forPane: tab.focusedPaneID)
                    }
                } else {
                    LeadingIcon(state: state)
                        .onboardingAnchor(.stateDot(0), shape: .pill,
                                          if: store.onboarding?.demoTabID == tab.tabID)
                }
```

Then, immediately **after** the `Spacer(minLength: 6)` in that same non-editing branch, add
the count chip:

```swift
                if let count = store.nudges(forPane: tab.focusedPaneID).first?.count {
                    Text("\(count)")
                        .font(.ui(10, .medium))
                        .foregroundStyle(Theme.textDim)
                        .padding(.horizontal, 4)
                        .padding(.vertical, 1)
                        .background(RoundedRectangle(cornerRadius: 3).fill(Theme.panel))
                }
```

> **Row height must not change.** `.frame(height: Self.height)` stays; the chip's own height
> is smaller than the row's, so it fits inside. Do not add a second line, and do not key any
> size or layout change off `state.wantsAttention` — that was tried and reverted.

- [ ] **Step 5: Verify it compiles and nothing regressed**

```bash
cd spike/seam1 && xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -5
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache test 2>&1 \
  | grep -E "Test Case .* failed|TEST (SUCCEEDED|FAILED)" | tail -10
```

Expected: `** BUILD SUCCEEDED **`, then `** TEST SUCCEEDED **` with no `failed` lines —
`PaneChromeTests` in particular.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/Nudges/NudgeBarView.swift spike/seam1/Sources/SidebarView.swift spike/seam1/Sources/SplitContainer.swift
git commit -m "$(cat <<'EOF'
feat(nudges): render nudges in the sidebar glyph slot and a pane bar

The sidebar uses the slot LeadingIcon and PRStatusIcon already share plus the
empty space after the row's Spacer, so row height is unchanged and nothing is
keyed off wantsAttention.

The pane bar mounts through PaneChrome, whose content keeps one structural
position — a conditional wrapping the surface would rebuild its PTY.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: The attention channel

**Files:**
- Modify: `spike/seam1/Sources/Workspace.swift:87-91`
- Modify: `spike/seam1/Sources/AgentStore.swift` (`attentionCount`, the `⌘⇧A` walk)
- Test: `spike/seam1/Tests/WorkspaceTests.swift` (extend)

**Interfaces:**
- Consumes: `Nudge`, `NudgeUrgency`.
- Produces: `func totalAttentionCount(in workspaces: [Workspace], nudgedPaneIDs: Set<String>) -> Int`

- [ ] **Step 1: Write the failing test**

Append to `spike/seam1/Tests/WorkspaceTests.swift` (inside the existing test class):

```swift
    /// A nudged pane counts once even though its AgentState is not an attention state —
    /// that is the whole point of the second channel.
    func testNudgedPaneCountsTowardAttention() {
        var pane = Pane(cwd: "/tmp")
        pane.state = .idle
        let tab = Tab(root: .leaf(pane), focusedPaneID: pane.paneID)
        let ws = Workspace(userTitle: nil, tabs: [tab], selectedTabID: tab.tabID)

        XCTAssertEqual(totalAttentionCount(in: [ws], nudgedPaneIDs: []), 0)
        XCTAssertEqual(totalAttentionCount(in: [ws], nudgedPaneIDs: [pane.paneID]), 1)
    }

    /// A pane already counted by its state must not be counted twice for also being nudged.
    func testNudgedAndBlockedPaneCountsOnce() {
        var pane = Pane(cwd: "/tmp")
        pane.state = .blocked
        let tab = Tab(root: .leaf(pane), focusedPaneID: pane.paneID)
        let ws = Workspace(userTitle: nil, tabs: [tab], selectedTabID: tab.tabID)

        XCTAssertEqual(totalAttentionCount(in: [ws], nudgedPaneIDs: [pane.paneID]), 1)
    }
```

> Use the real `Pane`/`Tab`/`Workspace` initialisers as the existing tests in this file call
> them — copy the construction from a neighbouring test rather than the sketch above.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd spike/seam1
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -10
```

Expected: `extra argument 'nudgedPaneIDs' in call`.

- [ ] **Step 3: Extend the counter**

In `spike/seam1/Sources/Workspace.swift`, replace `totalAttentionCount` with:

```swift
/// Count panes that want attention across every workspace (dock-badge source).
///
/// `nudgedPaneIDs` is the second channel: a repo condition is not an `AgentState`, so a pane
/// mid-merge reaches the badge this way rather than by having `.blocked` written onto it,
/// which would corrupt the hook lifecycle map. The union means a pane that is both blocked
/// and nudged counts once.
func totalAttentionCount(in workspaces: [Workspace],
                         nudgedPaneIDs: Set<String> = []) -> Int {
    workspaces.flatMap { $0.tabs }.flatMap { $0.root.panes }
        .filter { $0.state.wantsAttention || nudgedPaneIDs.contains($0.paneID) }
        .count
}
```

- [ ] **Step 4: Feed it from the store**

In `spike/seam1/Sources/AgentStore.swift`, add:

```swift
    /// Panes whose nudge is urgent enough to reach the badge, the folder dot and ⌘⇧A.
    var attentionNudgedPaneIDs: Set<String> {
        var out = Set<String>()
        for ws in workspaces where !ws.isRemote {
            for tab in ws.tabs {
                for pane in tab.root.panes
                where nudges(forPane: pane.paneID).contains(where: { $0.urgency == .attention }) {
                    out.insert(pane.paneID)
                }
            }
        }
        return out
    }
```

and change `attentionCount` (line 1570) to:

```swift
    var attentionCount: Int {
        totalAttentionCount(in: workspaces, nudgedPaneIDs: attentionNudgedPaneIDs)
            + ephemeralAttentionCount(ephemeralPanes)
    }
```

Then extend the `⌘⇧A` walk so a pane in `attentionNudgedPaneIDs` is a valid stop, and
`Workspace.aggregateState`'s caller (the folder dot in `SidebarView`) treats a
nudged-for-attention pane as `.blocked` for colour purposes only.

> Find the `⌘⇧A` implementation via `ShortcutID.nextAttention` in `ShortcutActions.run(_:)`
> and follow it to the store method it calls. Do **not** change `Workspace.aggregateState`
> itself — it is pure and knows nothing about nudges; combine at the call site.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd spike/seam1 && xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  -only-testing:ShepherdModelTests/WorkspaceTests test 2>&1 | grep -c "Test Case .* passed"
```

Expected: the previous count for this suite **plus 2**.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/Workspace.swift spike/seam1/Sources/AgentStore.swift spike/seam1/Tests/WorkspaceTests.swift
git commit -m "$(cat <<'EOF'
feat(nudges): attention nudges reach the badge, folder dot and ⌘⇧A

A repo condition is not an AgentState, so it arrives as a second channel
unioned at the rollup rather than by writing .blocked onto a pane, which would
corrupt the hook lifecycle map. A pane both blocked and nudged counts once.

No notification, chime or push: a conflict is a condition, not an event, and
is always downstream of an action that already alerted.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `PRTemplate` — pure

**Files:**
- Create: `spike/seam1/Sources/Nudges/PRTemplate.swift`
- Test: `spike/seam1/Tests/PRTemplateTests.swift`
- Modify: `spike/seam1/project.yml`

**Interfaces:**
- Produces:
  - `PRTemplate.searchOrder: [String]`
  - `PRTemplate.pick(from names: [String]) -> String?` — pure: given every path present in the repo, the template to use.
  - `PRTemplate.body(inRepo cwd: String) -> String?` — the Foundation shell.

- [ ] **Step 1: Write the failing test**

Create `spike/seam1/Tests/PRTemplateTests.swift`:

```swift
import XCTest
@testable import Shepherd

final class PRTemplateTests: XCTestCase {

    func testFindsRootTemplate() {
        XCTAssertEqual(PRTemplate.pick(from: ["README.md", "pull_request_template.md"]),
                       "pull_request_template.md")
    }

    func testFindsDocsTemplate() {
        XCTAssertEqual(PRTemplate.pick(from: ["docs/pull_request_template.md"]),
                       "docs/pull_request_template.md")
    }

    func testFindsGithubTemplate() {
        XCTAssertEqual(PRTemplate.pick(from: [".github/pull_request_template.md"]),
                       ".github/pull_request_template.md")
    }

    /// Root beats docs beats .github — GitHub's own order.
    func testPrecedence() {
        let all = [".github/pull_request_template.md",
                   "docs/pull_request_template.md",
                   "pull_request_template.md"]
        XCTAssertEqual(PRTemplate.pick(from: all), "pull_request_template.md")
        XCTAssertEqual(PRTemplate.pick(from: Array(all.prefix(2))),
                       "docs/pull_request_template.md")
    }

    /// GitHub matches these case-insensitively, and SHOUTING is the common spelling.
    func testCaseInsensitive() {
        XCTAssertEqual(PRTemplate.pick(from: [".github/PULL_REQUEST_TEMPLATE.md"]),
                       ".github/PULL_REQUEST_TEMPLATE.md")
        XCTAssertEqual(PRTemplate.pick(from: ["Pull_Request_Template.md"]),
                       "Pull_Request_Template.md")
    }

    /// A directory of templates is selectable only via GitHub's ?template= parameter.
    /// Picking one would silently apply the wrong convention.
    func testMultiTemplateDirectoryIsNotGuessed() {
        XCTAssertNil(PRTemplate.pick(from: [".github/PULL_REQUEST_TEMPLATE/bug.md",
                                            ".github/PULL_REQUEST_TEMPLATE/feature.md"]))
    }

    /// A single-file template still wins even if a directory exists beside it.
    func testSingleFileBeatsDirectory() {
        XCTAssertEqual(PRTemplate.pick(from: [".github/PULL_REQUEST_TEMPLATE/bug.md",
                                              "pull_request_template.md"]),
                       "pull_request_template.md")
    }

    func testNoTemplate() {
        XCTAssertNil(PRTemplate.pick(from: ["README.md", "src/main.swift"]))
        XCTAssertNil(PRTemplate.pick(from: []))
    }

    /// Not a template — the substring match must be anchored to the whole filename.
    func testUnrelatedFileNamedSimilarly() {
        XCTAssertNil(PRTemplate.pick(from: ["docs/pull_request_template_guide.md"]))
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd spike/seam1 && xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -10
```

Expected: `cannot find 'PRTemplate' in scope`.

- [ ] **Step 3: Write the implementation**

Create `spike/seam1/Sources/Nudges/PRTemplate.swift`:

```swift
import Foundation

/// Finds the repo's pull-request template, so the create-PR prompt opens pre-filled with
/// the form a human would have got on GitHub.
enum PRTemplate {

    /// GitHub's documented locations, in GitHub's order.
    static let searchOrder = ["pull_request_template.md",
                              "docs/pull_request_template.md",
                              ".github/pull_request_template.md"]

    /// The template to use, given every path in the repo. nil when there is none — or when
    /// there are several in a `PULL_REQUEST_TEMPLATE/` directory, which GitHub selects only
    /// through its `?template=` parameter. Guessing one there would silently apply the wrong
    /// convention.
    static func pick(from names: [String]) -> String? {
        for candidate in searchOrder {
            if let hit = names.first(where: { $0.lowercased() == candidate }) { return hit }
        }
        return nil
    }

    /// The template's contents, or nil.
    static func body(inRepo cwd: String) -> String? {
        // `ls-files` rather than a directory walk: it is already the repo's own view of what
        // exists, and it costs one process instead of three stats.
        guard case .ok(let listing) = GitStaging.run(
            ["ls-files", "--", "pull_request_template.md", "PULL_REQUEST_TEMPLATE.md",
             "docs/", ".github/"], cwd: cwd) else { return nil }
        let names = listing.split(separator: "\n").map(String.init)
        guard let pick = pick(from: names) else { return nil }
        let path = (cwd as NSString).appendingPathComponent(pick)
        return try? String(contentsOfFile: path, encoding: .utf8)
    }
}
```

- [ ] **Step 4: Add the source to the test target**

In `spike/seam1/project.yml`, after the `PaneChrome.swift` entry, add:

```yaml
      - path: Sources/Nudges/PRTemplate.swift
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd spike/seam1 && xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  -only-testing:ShepherdModelTests/PRTemplateTests test 2>&1 | grep -c "Test Case .* passed"
```

Expected: `9`.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/Nudges/PRTemplate.swift spike/seam1/Tests/PRTemplateTests.swift spike/seam1/project.yml
git commit -m "$(cat <<'EOF'
feat(nudges): locate a repo's PR template

GitHub's three documented locations in GitHub's order, matched
case-insensitively. A PULL_REQUEST_TEMPLATE/ directory of several templates is
deliberately not guessed — GitHub selects those only via ?template=, so
picking one would silently apply the wrong convention.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: The create-PR prompt

**Files:**
- Create: `spike/seam1/Sources/Nudges/PRCreateDialog.swift`
- Modify: `spike/seam1/Sources/AgentStore.swift` (`presentPRCreateDialog`, replacing Task 5's `break`)

**Interfaces:**
- Consumes: `PRTemplate.body(inRepo:)`, `GitStaging.run(_:cwd:stdin:env:)`, `GitStaging.currentBranch(cwd:)`, `GitStaging.upstream(cwd:)`, `GH.executablePath`, `AgentStore.refreshPR(forPane:)`, `AgentStore.openPRInWorkbench` (real name to be read from `AgentStore.swift:649`).
- Produces:
  - `struct PRDraft { var title: String; var body: String; var draft: Bool }`
  - `PRCreateDialog.prefill(cwd: String) -> PRDraft`
  - `PRCreateDialog.prompt(_ draft: PRDraft, branch: String?, ahead: Int) -> PRDraft?`
  - `PRCreateDialog.create(_ draft: PRDraft, cwd: String) -> Result<String, String>`

- [ ] **Step 1: Write the dialog**

Create `spike/seam1/Sources/Nudges/PRCreateDialog.swift`:

```swift
import AppKit

struct PRDraft {
    var title: String
    var body: String
    var draft: Bool
}

/// Asks for a PR's title and body, then creates it.
///
/// Shepherd asks rather than passing `gh pr create --fill`, whose multi-commit title falls
/// back to a heuristic off the branch name — creating a PR is outward-facing and hard to
/// undo, so nothing is published that the user did not see. `--editor` is not an option
/// either: an app-spawned `Process` has no tty, so it would not fail, it would hang.
enum PRCreateDialog {

    /// Title from the commits, body from the repo's template.
    static func prefill(cwd: String) -> PRDraft {
        var title = ""
        if case .ok(let subject) = GitStaging.run(["log", "-1", "--format=%s"], cwd: cwd) {
            title = subject.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return PRDraft(title: title,
                       body: PRTemplate.body(inRepo: cwd) ?? "",
                       draft: false)
    }

    /// nil when cancelled. Must run on the main thread.
    static func prompt(_ initial: PRDraft, branch: String?, ahead: Int) -> PRDraft? {
        let alert = NSAlert()
        alert.messageText = "Create pull request"
        alert.informativeText = "\(ahead) commit\(ahead == 1 ? "" : "s") on "
            + "\(branch ?? "this branch") with no pull request."
        alert.addButton(withTitle: "Create")
        alert.addButton(withTitle: "Cancel")

        let title = NSTextField(string: initial.title)
        title.placeholderString = "Title"

        // A template is routinely 40+ lines, so the body scrolls rather than growing the
        // alert past the screen.
        let bodyView = NSTextView()
        bodyView.string = initial.body
        bodyView.isRichText = false
        bodyView.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        scroll.documentView = bodyView
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.heightAnchor.constraint(equalToConstant: 120).isActive = true

        let draftBox = NSButton(checkboxWithTitle: "Draft", target: nil, action: nil)
        draftBox.state = initial.draft ? .on : .off

        let stack = NSStackView(views: [title, scroll, draftBox])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.frame = NSRect(x: 0, y: 0, width: 420, height: 180)
        title.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        scroll.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        alert.accessoryView = stack
        alert.window.initialFirstResponder = title

        guard alert.runModal() == .alertFirstButtonReturn else { return nil }
        let text = title.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        return PRDraft(title: text, body: bodyView.string, draft: draftBox.state == .on)
    }

    /// Push if the branch has no upstream, then create. Returns the PR's URL.
    ///
    /// Synchronous — callers dispatch it off the main thread.
    static func create(_ draft: PRDraft, cwd: String) -> Result<String, String> {
        guard let gh = GH.executablePath else { return .failure("gh is not installed") }

        if GitStaging.upstream(cwd: cwd) == nil {
            guard let branch = GitStaging.currentBranch(cwd: cwd) else {
                return .failure("detached HEAD — check out a branch first")
            }
            let push = GitStaging.run(["push", "-u", "origin", branch], cwd: cwd)
            if let err = push.errorText { return .failure(err) }
        }

        var args = ["pr", "create", "--title", draft.title, "--body-file", "-"]
        if draft.draft { args.append("--draft") }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: gh)
        p.arguments = args
        p.currentDirectoryURL = URL(fileURLWithPath: cwd)
        let input = Pipe(), out = Pipe(), err = Pipe()
        p.standardInput = input
        p.standardOutput = out
        p.standardError = err
        do { try p.run() } catch { return .failure("\(error)") }

        // The body reaches gh on stdin, not argv: a template is markdown full of backticks
        // and quotes, and there is no length to worry about this way.
        input.fileHandleForWriting.write(Data(draft.body.utf8))
        input.fileHandleForWriting.closeFile()
        // Drain before waiting — a full pipe deadlocks the child.
        let stdout = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let stderr = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        p.waitUntilExit()

        guard p.terminationStatus == 0 else {
            return .failure(stderr.isEmpty ? stdout : stderr)
        }
        let url = stdout.split(separator: "\n")
            .last { $0.hasPrefix("http") }
            .map(String.init) ?? ""
        return .success(url)
    }
}
```

- [ ] **Step 2: Replace the store's placeholder**

In `spike/seam1/Sources/AgentStore.swift`, replace the `case .createPR: break // Task 9`
left by Task 5 with a call to:

```swift
    func presentPRCreateDialog(forPane paneID: String) {
        guard let found = locatePane(paneID, in: workspaces),
              !workspaces[found.workspaceIndex].isRemote else { return }
        let cwd = found.pane.cwd
        guard !cwd.isEmpty, let signals = repoSignals[paneID] else { return }

        Task.detached(priority: .userInitiated) {
            let prefill = PRCreateDialog.prefill(cwd: cwd)
            guard let draft = await MainActor.run(body: {
                PRCreateDialog.prompt(prefill, branch: signals.branch, ahead: signals.ahead)
            }) else { return }

            let result = PRCreateDialog.create(draft, cwd: cwd)
            await MainActor.run { [weak self] in
                guard let self else { return }
                switch result {
                case .success:
                    self.refreshPR(forPane: paneID)
                    self.refreshRepoSignals(forPane: paneID)
                    self.openPRInWorkbench(forPane: paneID)
                case .failure(let message):
                    let alert = NSAlert()
                    alert.alertStyle = .warning
                    alert.messageText = "Could not create the pull request"
                    alert.informativeText = message
                    alert.runModal()
                }
            }
        }
    }
```

> `openPRInWorkbench` is named for what `AgentStore.swift:649` actually calls it — read that
> function and use the real name. The `gh pr view` refresh must happen **before** opening the
> workbench PR band, or the band has nothing to show.

- [ ] **Step 3: Verify it compiles and nothing regressed**

```bash
cd spike/seam1 && xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -5
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache test 2>&1 \
  | grep -E "Test Case .* failed|TEST (SUCCEEDED|FAILED)" | tail -10
```

Expected: `** BUILD SUCCEEDED **` then `** TEST SUCCEEDED **`, no `failed` lines.

- [ ] **Step 4: Commit**

```bash
git add spike/seam1/Sources/Nudges/PRCreateDialog.swift spike/seam1/Sources/AgentStore.swift
git commit -m "$(cat <<'EOF'
feat(nudges): create a PR from the nudge, asking before publishing

Prompt prefilled with the last commit's subject and the repo's PR template,
then push -u if needed and `gh pr create --body-file -`. The body goes on
stdin because a template is markdown full of backticks and quotes.

Shepherd asks rather than using --fill, whose multi-commit title falls back to
a branch-name heuristic; creating a PR is outward-facing and hard to undo.
--editor is unusable here: no tty means it hangs rather than failing.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Document the feature**

In `CLAUDE.md`, add to the "App source files" list, after the workbench section:

```markdown
- **Contextual nudges** (`Sources/Nudges/`) — surface a git feature when its condition is
  true. `RepoSignals` (**pure** parsers + `RepoSignalsReader`'s `Process` shell: conflicts,
  dirty, ahead, `MergeState`), `RepoWatcher` (one refcounted vnode watch per **git dir**,
  200ms debounce; re-reads on `turnFinished` + `focusPane`), `NudgeRegistry` (**pure**, the
  only decision point: `PaneFacts` → `[Nudge]` for `resolveConflicts` / `continueSequence` /
  `reviewChanges` / `createPR`), `PaneChrome` (**pure** structural bar slot), `NudgeBarView`,
  `PRTemplate` (**pure**), `PRCreateDialog`. In `ShepherdModelTests` +
  `RepoSignalsIntegrationTests` (real git). [Design](docs/superpowers/specs/2026-07-31-contextual-nudges-design.md).
```

- [ ] **Step 2: Add the gotchas**

In `CLAUDE.md`'s "Critical gotchas" section, add:

```markdown
- **There is no git hook for a conflicted merge/rebase/cherry-pick.** `post-merge` and
  `post-rewrite` fire only on *success* and cherry-pick fires nothing, so conflicts are the
  one path with no hook. Nudges detect them by watching the git dir instead — which needs
  nothing installed in the user's repo and also catches conflicts created outside Shepherd.
- **Nudges must never call `Git.defaultBaseRef`.** Its fallback runs
  `git remote set-head origin --auto`, a network round-trip, and `RepoWatcher` fires on every
  git write. `RepoSignals.localDefaultBase` is the read-only replacement; no `origin/HEAD`
  locally means `ahead` stays 0 rather than counting all of history as unpushed.
- **A nudge never writes to `AgentState`.** Urgency reaches the dock badge, folder dot and
  ⌘⇧A as a second channel unioned inside `totalAttentionCount(in:nudgedPaneIDs:)`. Writing
  `.blocked` onto a pane because git is mid-merge would corrupt the hook lifecycle map, whose
  ordering guard depends on nothing else touching it. And no notification/chime/push: a
  conflict is a condition, not an event, and is always downstream of something that alerted.
- **The pane bar goes through `PaneChrome`, and its content position is not conditional.**
  `if hasNudge { VStack { bar; surface } } else { surface }` is a `_ConditionalContent`, so it
  rebuilds the surface — new `ghostty_surface_t`, new PTY, dead `claude` — the same bug
  `.onboardingAnchor(…, if:)` shipped. `PaneChromeTests` counts `makeNSView` across a toggle.
- **`git ls-files -u` prints one record per index stage**, so an ordinary content conflict
  appears three times and a delete/modify twice. Count unique **paths**
  (`RepoSignals.unmergedCount`), never records.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: record the nudge system and its five traps

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| §"Not a git hook" | Task 2 (watch), Task 10 (recorded) |
| §1 `RepoSignals` | Tasks 1, 2 |
| §2 `RepoWatcher` incl. worktree pointer | Tasks 2 (`Git.gitDir` + test), 5 |
| §3 `NudgeRegistry`, four nudges, precedence, bar policy, suppressions | Task 3 |
| §4 sidebar glyph + chip, no row-height change | Task 6 |
| §4 pane bar + remount guard | Tasks 4, 6 |
| §4 dismissal | Tasks 5 (`dismissBar`), 6 |
| §5 attention channel, no alerts | Task 7 |
| §6 `NudgeAction`, scroll-not-press for Continue | Tasks 3, 5 |
| §7 `createPR`, prompt, template, stdin, no `--editor` | Tasks 8, 9 |
| §8 all four test groups | Tasks 1, 2, 3, 4, 8 |
| §9 what does not change | enforced by Global Constraints |

## What execution actually changed (filled in after the fact)

The plan's expected test counts were **assertion** counts, not test-case counts. Real numbers:
Task 1 → 11, Task 2 → 10, Task 3 → 25, Task 4 → 2, Task 8 → 9. Full suite 903 → 914.

Seven places where the plan was wrong about the codebase, all found by the compiler:

1. **`Pane.cwd` is `String?`**, not `String` — `syncRepoWatches` needs `?? ""`.
2. **`locatePane` returns `(ws: Int, tab: Int)`**, not the pane — the pane comes from
   `workspaces[w].tabs[t].root.pane(paneID)`.
3. **There is no `workbenchVisiblePaneIDs`/`setWorkbenchVisible`.** Workbench visibility is
   `diffPanelOpen` + `diffPanelPaneID`, and opening it is the four-line funnel `openPR` uses.
4. **`updateDockBadge()`**, not `updateBadge()`. **`openPR(forPane:)`** is the open-in-workbench
   function (the doc comment sits at `:649`, the func at `:659`).
5. **No `Theme.panel`** — the tokens are `surface1/2/3`.
6. **`Result<String, String>` does not compile**: a `Result`'s failure type must be an `Error`.
   Replaced with a `GitResult`-shaped `PRCreateResult`, which is the local idiom anyway.
7. **`didFocus` early-returns for anything but `.needsCheck`**, so the repo re-read had to go
   *above* its guards, not at the end as written.

Two designed-in-flight changes:

- **`RepoWatcher.onChange` carries the fresh signals.** The planned `(String) -> Void` made the
  store's `lazy var` closure read `self.repoWatcher` — a **circular reference**, and a build
  error.
- **Registration is a 30s timer plus focus**, not a call at each of a dozen mutation sites. One
  missed site there is a pane that silently never reports a conflict; this converges instead.
  It needed its own timer because `startPRRefreshTimer` returns early without `gh`, and nudges
  must work on a machine that has never installed it.

Two improvements over the plan:

- **`PaneChromeTests` gained a control** asserting the conditional-wrapping shape *does*
  remount. Without it the guard test could pass while guarding nothing.
- **`.sequence` uses `Tabler.gitBranch`, not `gitMerge` again.** The plan reused one glyph for
  two different states; `gitBranch` is `gitMerge` mirrored, so they read as siblings.

**Deviations from the spec, deliberate**

1. **`MergeState` instead of a new `SequenceOp`.** The spec sketched `operation: SequenceOp?`;
   `ConflictReader` already declares `MergeState` with the same information plus real ref
   labels and progress, and it is already in the test target. A second type meaning "which
   operation is in progress" is exactly the kind of thing this codebase refuses.
2. **`rev-parse --absolute-git-dir` instead of parsing `.git`-as-a-file.** `ConflictReader`
   already resolves paths this way (`--git-path`). Same outcome, no hand-rolled pointer
   following.
3. **`behind` dropped.** No nudge reads it. YAGNI — it can be added with its own consumer.
4. **`unresolvedThreads` dropped from `PaneFacts`.** Its nudge is deferred, so the field would
   be unread.

**Placeholder scan:** clean. Every code step carries real code; every "adapt to what exists"
note names the file and symbol to read and the specific hazard, rather than deferring a
decision.

**Type consistency:** `RepoSignals` fields (`state`/`conflicts`/`dirty`/`ahead`/`branch`/
`hasUpstream`) are identical across Tasks 1, 2, 3, 5, 9. `NudgeRegistry.nudges(for:)` /
`showsBar(_:seen:)`, `PaneFacts`' eight fields, `NudgeAction`'s two cases, and
`totalAttentionCount(in:nudgedPaneIDs:)` are used with the same names and arities everywhere
they appear. `GitResult` is matched as `.ok(String)` / `.failed(String)` throughout, per
`GitStaging.swift:6`.
