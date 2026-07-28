# Workbench W5a (History) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the branch's commit history to the workbench — a `Commits (n)` scope whose commits open as diffs in the same buffer, a blame lane in the gutter, and a Continue control that finishes a stopped rebase / cherry-pick / merge.

**Architecture:** A commit is a document whose text is not on disk, which is the shape W3 already solved for conflicted files — so the commit view extends that provenance (a new `HighlightVariant` plus a blob cache) instead of adding a source type, and `RowPlanner` is untouched. Blame is two pure models feeding a new lane in the existing `DiffGutterView`, which already has real per-row layout geometry. The sequence seam is one git command plus the state around it; W3 already reads the operation, its progress and its ref names.

**Tech Stack:** Swift 5, SwiftUI + AppKit, xcodegen, vendored CodeEditTextView/CodeEditSourceEditor, XCTest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-28-workbench-w5a-history-design.md`. Every task's requirements implicitly include it.
- Deployment target macOS 13.0; `SWIFT_VERSION: "5.0"`.
- **Run `xcodegen generate` after adding or removing ANY source file.** Otherwise the file is not compiled and you get `cannot find X in scope` at *build* time, not edit time.
- **Every new pure model must be added to `ShepherdModelTests`' explicit `sources:` list in `project.yml`** (around lines 155–200). Files under `Tests/` are picked up by the `- path: Tests` glob; compiled sources are not.
- **This shell resets cwd between calls.** Always `cd` with an absolute path inside each command. A compound `xcodegen && xcodebuild` without it silently tests a *stale* project — a passing run right after adding a file is suspicious until the test count moves.
- **SourceKit lies in this repo.** "Cannot find type" from the editor is stale noise; `xcodebuild` is ground truth.
- Pure models contain **no AppKit import**. That is what makes them testable.
- **Never run `killall Shepherd`** — the user runs Shepherd as their daily terminal. Verify by compile + unit tests; hand runtime checks to the user via `scripts/dev.sh`.
- BSD `sed` has no `\b`; use `[[:<:]]` / `[[:>:]]`.
- Commit messages end with: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- Build command (used by every task):
  ```bash
  cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
    xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
    -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
    CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -20
  ```
- Test command:
  ```bash
  cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
    xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
    -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
    CLANG_MODULE_CACHE_PATH=./build/ModuleCache test 2>&1 | tail -30
  ```
- Single-test filter: append `-only-testing:ShepherdModelTests/<ClassName>/<testName>` to the test command.

## Verified git behaviour (probed against git 2.55 — do not re-derive)

These were measured, not assumed. W3 lost time to assuming the opposite kind of thing.

| Fact | Consequence |
|---|---|
| `git show -M --format= <merge-sha>` prints **nothing at all** | `readCommit` MUST pass `-m --first-parent`, or drilling into a merge commit shows a silently blank diff |
| Pending message: rebase → `rebase-merge/message`; merge → `MERGE_MSG`; cherry-pick → `MERGE_MSG` | `SequencePolicy.messageFileName` maps these; resolve through `rev-parse --git-path` so linked worktrees work |
| All three message files end with a `# Conflicts:` comment block git strips at commit time | `SequencePolicy.displayMessage` strips `#` lines for display |
| `GIT_EDITOR="cp '<file>'"` + `git rebase --continue` exits 0 and the commit carries the supplied subject | This is the reword path; it relies only on documented `GIT_EDITOR` behaviour (a command string with the file path appended) |
| `git log --format=%H%x00%h%x00%an%x00%at%x00%s%x1e` emits NUL-separated fields and `\036`-terminated records | `CommitHistory.parse` splits on those two separators |

## File structure

| File | Responsibility |
|---|---|
| `Sources/Workbench/CommitHistory.swift` (new, **pure**) | `Commit`; `git log` / `git show <sha>:<path>` argument builders; log parse; relative-age formatting |
| `Sources/Workbench/HighlightVariant.swift` (new, **pure**) | `HighlightVariant`, moved out of `MultiHighlighter.swift` so the provenance model can be tested without AppKit |
| `Sources/Workbench/DocumentProvenance.swift` (new, **pure**) | The three provenance decisions: a row's highlight variant, where a non-diff row's text comes from, whether the document is editable |
| `Sources/Workbench/BlobCache.swift` (new) | `(sha, path)` → blob text; lazy, off-main, redraw callback |
| `Sources/Workbench/BlameParse.swift` (new, **pure**) | `--porcelain` output → line→sha map + per-sha metadata |
| `Sources/Workbench/BlameLane.swift` (new, **pure**) | Rows → lane runs; timestamp → shade bucket |
| `Sources/Workbench/SequencePolicy.swift` (new, **pure**) | Verb/args/message-file mapping, comment stripping, can-continue + reason |
| `Sources/Workbench/SequenceRunner.swift` (new) | Pending-message read; `--continue` spawn incl. the `GIT_EDITOR` choice |
| `Sources/DiffReader.swift` (modify) | `readCommit(cwd:sha:)`; `WorkbenchScope.commits` |
| `Sources/Workbench/GitStaging.swift` (modify) | `run(...)` gains an `env:` parameter |
| `Sources/Workbench/MultiHighlighter.swift` (modify) | `HighlightVariant` moves out; `.commit(sha:)` handled |
| `Sources/Workbench/WorkbenchSession.swift` (modify) | `selectedCommit`, `loadCommit`, the two provenance points, blame cache, `continueOperation`, widened lock |
| `Sources/Workbench/DiffGutter.swift` (modify) | Blame lane draw + width + hover tracking area + x-range hit test |
| `Sources/Workbench/WorkbenchView.swift` (modify) | Commits rail + breadcrumb, blame annotation in the header, sequence panel |
| `Sources/Theme.swift` (modify) | `Diff.blameHeat`, `Diff.blameUncommitted` |
| `Sources/ShortcutCatalog.swift` (modify) | `⌃4` scope row (display-only) |
| `Tests/*` (new) | `CommitHistoryTests`, `DocumentProvenanceTests`, `BlameParseTests`, `BlameLaneTests`, `SequencePolicyTests`, `CommitDiffIntegrationTests`, `SequenceIntegrationTests` |

---

### Task 1: `CommitHistory` — the pure commit model

**Files:**
- Create: `spike/seam1/Sources/Workbench/CommitHistory.swift`
- Create: `spike/seam1/Tests/CommitHistoryTests.swift`
- Modify: `spike/seam1/project.yml` (add to `ShepherdModelTests` `sources:`)

**Interfaces:**
- Consumes: nothing.
- Produces: `struct Commit { let sha, shortSha, subject, author: String; let timestamp: Date; var id: String }`; `CommitHistory.logArguments(base: String) -> [String]`; `CommitHistory.parse(_ output: String) -> [Commit]`; `CommitHistory.blobArguments(sha: String, path: String) -> [String]`; `CommitHistory.relativeAge(_ date: Date, now: Date) -> String`.

- [ ] **Step 1: Write the failing test**

Create `spike/seam1/Tests/CommitHistoryTests.swift`:

```swift
import XCTest
@testable import Shepherd

/// The log parse is NUL-delimited on purpose: a commit subject can contain anything,
/// including `|` and (via `%s` of a malformed commit) leading whitespace.
final class CommitHistoryTests: XCTestCase {

    /// Exactly what `git log --format=%H%x00%h%x00%an%x00%at%x00%s%x1e` emits: NUL between
    /// fields, \u{1e} ending each record, newline after it.
    private func record(sha: String, short: String, author: String,
                        epoch: Int, subject: String) -> String {
        "\(sha)\u{0}\(short)\u{0}\(author)\u{0}\(epoch)\u{0}\(subject)\u{1e}\n"
    }

    func testParsesOneCommit() {
        let out = record(sha: "1271110aaaa", short: "1271110", author: "Eshaan Shah",
                         epoch: 1_785_235_121, subject: "feat: side-by-side diff")
        let commits = CommitHistory.parse(out)
        XCTAssertEqual(commits.count, 1)
        XCTAssertEqual(commits[0].sha, "1271110aaaa")
        XCTAssertEqual(commits[0].shortSha, "1271110")
        XCTAssertEqual(commits[0].author, "Eshaan Shah")
        XCTAssertEqual(commits[0].subject, "feat: side-by-side diff")
        XCTAssertEqual(commits[0].timestamp, Date(timeIntervalSince1970: 1_785_235_121))
    }

    func testParsesSeveralInOrder() {
        let out = record(sha: "aaa", short: "aaa", author: "A", epoch: 3, subject: "third")
            + record(sha: "bbb", short: "bbb", author: "B", epoch: 2, subject: "second")
            + record(sha: "ccc", short: "ccc", author: "C", epoch: 1, subject: "first")
        XCTAssertEqual(CommitHistory.parse(out).map(\.subject), ["third", "second", "first"])
    }

    /// The whole reason for NUL fields and \u{1e} records.
    func testSubjectContainingPipesAndBrackets() {
        let subject = "fix(x): a|b — [wip] 100% \"quoted\""
        let out = record(sha: "aaa", short: "aaa", author: "A", epoch: 1, subject: subject)
        XCTAssertEqual(CommitHistory.parse(out).first?.subject, subject)
    }

    func testEmptyOutputIsNoCommits() {
        XCTAssertTrue(CommitHistory.parse("").isEmpty)
        XCTAssertTrue(CommitHistory.parse("\n").isEmpty)
    }

    /// A truncated record is dropped rather than producing a commit with empty fields —
    /// a half-parsed sha would drive `git show` at nothing.
    func testMalformedRecordIsDropped() {
        XCTAssertTrue(CommitHistory.parse("aaa\u{0}aaa\u{1e}\n").isEmpty)
        XCTAssertTrue(CommitHistory.parse("aaa\u{0}aaa\u{0}A\u{0}notanumber\u{0}s\u{1e}\n").isEmpty)
    }

    func testLogArgumentsCarryBaseRange() {
        let args = CommitHistory.logArguments(base: "master")
        XCTAssertEqual(args.first, "log")
        XCTAssertTrue(args.contains("master..HEAD"))
        XCTAssertTrue(args.contains { $0.hasPrefix("--format=") })
    }

    /// The blob read must use `<sha>:<path>` — a path is never joined onto cwd here.
    func testBlobArguments() {
        XCTAssertEqual(CommitHistory.blobArguments(sha: "abc", path: "Sources/A.swift"),
                       ["show", "abc:Sources/A.swift"])
    }

    func testRelativeAge() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertEqual(CommitHistory.relativeAge(now.addingTimeInterval(-30), now: now), "now")
        XCTAssertEqual(CommitHistory.relativeAge(now.addingTimeInterval(-600), now: now), "10m")
        XCTAssertEqual(CommitHistory.relativeAge(now.addingTimeInterval(-7200), now: now), "2h")
        XCTAssertEqual(CommitHistory.relativeAge(now.addingTimeInterval(-172800), now: now), "2d")
        XCTAssertEqual(CommitHistory.relativeAge(now.addingTimeInterval(-1209600), now: now), "2w")
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test \
  -only-testing:ShepherdModelTests/CommitHistoryTests 2>&1 | tail -20
```
Expected: FAIL — `cannot find 'CommitHistory' in scope`.

- [ ] **Step 3: Write minimal implementation**

Create `spike/seam1/Sources/Workbench/CommitHistory.swift`:

```swift
import Foundation

/// One commit on the branch. `id` is the full sha so a list selection survives a reload.
struct Commit: Equatable, Identifiable {
    let sha: String
    let shortSha: String
    let subject: String
    let author: String
    let timestamp: Date

    var id: String { sha }
}

/// The branch's commits, and the git argument lists that read history.
///
/// Pure: the argument builders and the parse are the parts that can be wrong in a way a
/// test can see. The `Process` work lives in the session, like `WorktreeService`.
enum CommitHistory {

    /// NUL between fields, \u{1e} ending each record.
    ///
    /// A subject can contain any byte a terminal can print — `|`, brackets, quotes — so a
    /// human-readable delimiter would eventually split one. These two are the only
    /// characters git will not emit from `%s` or `%an`.
    private static let fieldSeparator = "\u{0}"
    private static let recordSeparator = "\u{1e}"

    /// `<base>..HEAD` — what this branch has done, which is the question the Commits scope
    /// answers. `%at` is the author date as a UNIX timestamp, so nothing has to parse a
    /// locale-dependent date string.
    static func logArguments(base: String) -> [String] {
        ["log", "--format=%H\(fieldSeparator)%h\(fieldSeparator)%an\(fieldSeparator)%at\(fieldSeparator)%s\(recordSeparator)",
         "\(base)..HEAD"]
    }

    /// A file's whole text as of a commit. `<sha>:<path>` takes a **repo-relative** path.
    static func blobArguments(sha: String, path: String) -> [String] {
        ["show", "\(sha):\(path)"]
    }

    static func parse(_ output: String) -> [Commit] {
        output.components(separatedBy: recordSeparator).compactMap { record in
            let trimmed = record.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return nil }
            let fields = trimmed.components(separatedBy: fieldSeparator)
            // A short record is dropped rather than filled with blanks: a half-parsed sha
            // would drive `git show` at nothing.
            guard fields.count >= 5, let epoch = Double(fields[3]) else { return nil }
            return Commit(sha: fields[0], shortSha: fields[1], subject: fields[4],
                          author: fields[2],
                          timestamp: Date(timeIntervalSince1970: epoch))
        }
    }

    /// Compact age for a one-line row: `now` / `10m` / `2h` / `2d` / `2w`.
    static func relativeAge(_ date: Date, now: Date) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        switch seconds {
        case ..<60:     return "now"
        case ..<3600:   return "\(Int(seconds / 60))m"
        case ..<86400:  return "\(Int(seconds / 3600))h"
        case ..<604800: return "\(Int(seconds / 86400))d"
        default:        return "\(Int(seconds / 604800))w"
        }
    }
}
```

- [ ] **Step 4: Register the file, regenerate, run the tests**

Add to `spike/seam1/project.yml` in `ShepherdModelTests`' `sources:` list (after `- path: Sources/Workbench/EditMap.swift`):
```yaml
      - path: Sources/Workbench/CommitHistory.swift
```

Run:
```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && xcodegen generate
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test \
  -only-testing:ShepherdModelTests/CommitHistoryTests 2>&1 | tail -20
```
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd && \
git add spike/seam1/Sources/Workbench/CommitHistory.swift \
        spike/seam1/Tests/CommitHistoryTests.swift spike/seam1/project.yml && \
git commit -m "$(cat <<'EOF'
feat(workbench): CommitHistory — the branch's commits, parsed

NUL fields and \036 records because a subject can contain anything a
terminal can print. A short record is dropped rather than filled with
blanks: a half-parsed sha would drive `git show` at nothing.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `DiffReader.readCommit` + the `.commits` scope

**Files:**
- Modify: `spike/seam1/Sources/DiffReader.swift:9-26` (scope enum), and add `readCommit` beside `read`
- Create: `spike/seam1/Tests/CommitDiffIntegrationTests.swift`

**Interfaces:**
- Consumes: `Commit` (Task 1); existing `DiffReadResult`, `DiffParser.parse`.
- Produces: `DiffReader.readCommit(cwd: String, sha: String) -> DiffReadResult`; `WorkbenchScope.commits`.

- [ ] **Step 1: Write the failing test**

Create `spike/seam1/Tests/CommitDiffIntegrationTests.swift`. This is a **real-git** test on the `ConflictIntegrationTests` pattern — a unit test cannot catch `git show` printing nothing for a merge commit, which is the defect this guards.

```swift
import XCTest
@testable import Shepherd

/// `DiffReader.readCommit` against real git.
///
/// The load-bearing case is the merge commit: `git show -M --format= <merge>` prints
/// **nothing** (it defaults to a combined `@@@` diff, which is suppressed without `-m`),
/// so drilling into a merge would render a silently blank buffer. Only real git can say.
final class CommitDiffIntegrationTests: XCTestCase {

    private var repo: String!

    override func setUpWithError() throws {
        try super.setUpWithError()
        repo = NSTemporaryDirectory() + "shepherd-w5a-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: repo, withIntermediateDirectories: true)
        git("init", "-b", "main")
        git("config", "user.email", "test@example.com")
        git("config", "user.name", "Test")
    }

    override func tearDownWithError() throws {
        if let repo { try? FileManager.default.removeItem(atPath: repo) }
        try super.tearDownWithError()
    }

    @discardableResult
    private func git(_ args: String...) -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["-C", repo] + args
        let out = Pipe(), err = Pipe()
        process.standardOutput = out
        process.standardError = err
        try? process.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        _ = err.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(data: data, encoding: .utf8) ?? ""
    }

    private func write(_ path: String, _ contents: String) {
        try? contents.write(toFile: (repo as NSString).appendingPathComponent(path),
                            atomically: true, encoding: .utf8)
    }

    private func head() -> String {
        git("rev-parse", "HEAD").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func testReadsAnOrdinaryCommitAsADiff() {
        write("f.txt", "a\nb\nc\n")
        git("add", "-A"); git("commit", "-m", "base")
        write("f.txt", "a\nCHANGED\nc\n")
        git("commit", "-am", "change b")

        let result = DiffReader.readCommit(cwd: repo, sha: head())
        XCTAssertTrue(result.isRepo)
        XCTAssertEqual(result.files.map(\.path), ["f.txt"])
        XCTAssertEqual(result.files.first?.addedCount, 1)
        XCTAssertEqual(result.files.first?.removedCount, 1)
        // Nothing is staged in a historical view — the rail must render no stage buttons.
        XCTAssertTrue(result.stagedFiles.isEmpty)
    }

    /// The regression this task exists to prevent.
    func testMergeCommitIsNotBlank() {
        write("f.txt", "a\nb\nc\n")
        git("add", "-A"); git("commit", "-m", "base")
        git("checkout", "-b", "side")
        write("f.txt", "a\nSIDE\nc\n")
        git("commit", "-am", "side")
        git("checkout", "main")
        write("g.txt", "new\n")
        git("add", "-A"); git("commit", "-m", "main")
        git("merge", "side", "-m", "merge side")

        let result = DiffReader.readCommit(cwd: repo, sha: head())
        XCTAssertFalse(result.files.isEmpty,
                       "a merge commit must not read as an empty diff")
        XCTAssertTrue(result.files.contains { $0.path == "f.txt" })
    }

    /// A root commit has no `^`, so the old-side label cannot be assumed resolvable.
    func testRootCommitReadsAsAllAdditions() {
        write("f.txt", "a\nb\n")
        git("add", "-A"); git("commit", "-m", "root")

        let result = DiffReader.readCommit(cwd: repo, sha: head())
        XCTAssertEqual(result.files.map(\.path), ["f.txt"])
        XCTAssertEqual(result.files.first?.addedCount, 2)
    }

    func testNotARepoIsReportedNotCrashed() {
        let empty = NSTemporaryDirectory() + "shepherd-w5a-norepo-" + UUID().uuidString
        try? FileManager.default.createDirectory(atPath: empty, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: empty) }
        XCTAssertFalse(DiffReader.readCommit(cwd: empty, sha: "HEAD").isRepo)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test \
  -only-testing:ShepherdModelTests/CommitDiffIntegrationTests 2>&1 | tail -20
```
Expected: FAIL — `type 'DiffReader' has no member 'readCommit'`.

- [ ] **Step 3: Add the scope case**

In `spike/seam1/Sources/DiffReader.swift`, replace the `WorkbenchScope` enum body (lines 9–26) with:

```swift
enum WorkbenchScope: Equatable {
    case workingTree, vsBase, threads, files, commits

    /// The **live tree comparison** behind this scope, or nil for a scope that is not one.
    ///
    /// Conflicts come from the unmerged index and a commit comes from `git show`; neither
    /// is a comparison of the working tree. Mapping them onto a `DiffMode` anyway — which a
    /// two-case ternary silently did — makes `WorkbenchView`'s `.onChange(of: session.mode)`
    /// fire a full tree diff every time you enter the scope, and neither document is that
    /// diff to begin with.
    var mode: DiffMode? {
        switch self {
        case .workingTree:      return .workingTree
        case .vsBase, .threads: return .branchVsBase
        // Neither the unmerged index, a hand-opened file, nor a commit is a tree diff.
        case .files, .commits:  return nil
        }
    }
}
```

- [ ] **Step 4: Add `readCommit`**

In `spike/seam1/Sources/DiffReader.swift`, add immediately after the `read(cwd:mode:)` function (after line 78):

```swift
    /// One commit as a diff, for the Commits scope.
    ///
    /// `--format=` prints the diff and nothing else, so `DiffParser` sees exactly what it
    /// sees for `git diff`. **`-m --first-parent` is not optional:** without it, `git show`
    /// on a *merge* commit emits a combined `@@@` diff, which it suppresses entirely at
    /// default verbosity — so the buffer would render blank with no error anywhere
    /// (measured on git 2.55). `--first-parent` also picks the one side worth showing for a
    /// merge, and is a no-op for the ordinary single-parent case.
    static func readCommit(cwd: String, sha: String) -> DiffReadResult {
        guard isGitRepo(cwd) else { return .notRepo }
        let out = git(cwd, ["show", "-M", "-m", "--first-parent", "--format=", sha]) ?? ""
        // `baseLabel` is the old side for blob reads. A root commit has no `<sha>^`, in
        // which case the read simply returns nil and the old side is empty — which is what
        // an all-additions commit shows anyway.
        return DiffReadResult(files: DiffParser.parse(out), stagedFiles: [],
                              baseLabel: "\(sha)^", baseName: detectBase(cwd), isRepo: true)
    }
```

- [ ] **Step 5: Run the tests**

Run:
```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test \
  -only-testing:ShepherdModelTests/CommitDiffIntegrationTests 2>&1 | tail -20
```
Expected: PASS, 4 tests.

Then the **full** suite, because adding an enum case breaks every exhaustive `switch` over `WorkbenchScope`:
```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | grep -E "error:|BUILD" | head -20
```
Expected: `BUILD SUCCEEDED`. If a `switch must be exhaustive` error appears, add the `.commits` case to that switch — treat it the same as `.files` unless the surrounding code says otherwise.

- [ ] **Step 6: Commit**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd && \
git add spike/seam1/Sources/DiffReader.swift spike/seam1/Tests/CommitDiffIntegrationTests.swift && \
git commit -m "$(cat <<'EOF'
feat(workbench): read a commit as a diff

`-m --first-parent` is required, not defensive: `git show -M --format=` on a
merge commit prints nothing at all, so drilling into one would have rendered a
blank buffer with no error anywhere. Measured on git 2.55, and the integration
test pins it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Provenance — extract `HighlightVariant`, add `DocumentProvenance`

This is the task that prevents the bug the spec is built around. It is pure and testable precisely so that the decision cannot be re-implemented inline in three places.

**Files:**
- Create: `spike/seam1/Sources/Workbench/HighlightVariant.swift`
- Create: `spike/seam1/Sources/Workbench/DocumentProvenance.swift`
- Create: `spike/seam1/Tests/DocumentProvenanceTests.swift`
- Modify: `spike/seam1/Sources/Workbench/MultiHighlighter.swift:66-76` (remove the enum)
- Modify: `spike/seam1/project.yml`

**Interfaces:**
- Consumes: nothing.
- Produces: `HighlightVariant` gains `case commit(String)`; `enum LineTextSource { case workingCopy, commitBlob(sha: String) }`; `DocumentProvenance.variant(hasMergePreview:commitSha:) -> HighlightVariant`; `DocumentProvenance.lineSource(commitSha:) -> LineTextSource`; `DocumentProvenance.isEditable(commitSha:) -> Bool`; `DocumentProvenance.readOnlyReason(commitSha:) -> String?`.

- [ ] **Step 1: Write the failing test**

Create `spike/seam1/Tests/DocumentProvenanceTests.swift`:

```swift
import XCTest
@testable import Shepherd

/// Where a row's text and colours come from.
///
/// This is one decision in one place because getting it wrong is this project's signature
/// defect: rows coloured from the working copy while the document showed something else
/// mangled highlighting on the first live run, and again — one layer along — when
/// conflicted files anchored to `.new` and were painted from the marker-laden file on disk.
/// A commit view is the third document whose text is not what is on disk.
final class DocumentProvenanceTests: XCTestCase {

    // MARK: highlight variant

    func testLiveDiffRowHighlightsFromTheWorkingCopy() {
        XCTAssertEqual(DocumentProvenance.variant(hasMergePreview: false, commitSha: nil),
                       .new)
    }

    func testConflictedRowHighlightsFromTheMergePreview() {
        XCTAssertEqual(DocumentProvenance.variant(hasMergePreview: true, commitSha: nil),
                       .mergePreview)
    }

    func testCommitRowHighlightsFromThatCommitsBlob() {
        XCTAssertEqual(DocumentProvenance.variant(hasMergePreview: false, commitSha: "abc"),
                       .commit("abc"))
    }

    /// Two commits touching one file must not share a parse, which is why the sha is in
    /// the cache key rather than the variant being a bare `.historical`.
    func testDifferentCommitsAreDifferentVariants() {
        XCTAssertNotEqual(DocumentProvenance.variant(hasMergePreview: false, commitSha: "abc"),
                          DocumentProvenance.variant(hasMergePreview: false, commitSha: "def"))
    }

    /// A commit view is never mid-merge — the lock forbids it — but if both were ever true
    /// the commit is what the document is showing.
    func testCommitWinsOverMergePreview() {
        XCTAssertEqual(DocumentProvenance.variant(hasMergePreview: true, commitSha: "abc"),
                       .commit("abc"))
    }

    // MARK: line text source

    func testLiveRowsReadTheWorkingCopy() {
        XCTAssertEqual(DocumentProvenance.lineSource(commitSha: nil), .workingCopy)
    }

    /// The one that stops a gap expansion inside an old commit splicing today's lines in.
    func testCommitRowsReadThatCommitsBlob() {
        XCTAssertEqual(DocumentProvenance.lineSource(commitSha: "abc"),
                       .commitBlob(sha: "abc"))
    }

    // MARK: editability

    func testLiveDocumentIsEditable() {
        XCTAssertTrue(DocumentProvenance.isEditable(commitSha: nil))
        XCTAssertNil(DocumentProvenance.readOnlyReason(commitSha: nil))
    }

    /// Read-only is structural, and the reason must be visible — silent read-only was the
    /// W2.2 defect.
    func testCommitDocumentIsReadOnlyWithAReason() {
        XCTAssertFalse(DocumentProvenance.isEditable(commitSha: "abc"))
        XCTAssertEqual(DocumentProvenance.readOnlyReason(commitSha: "abc"),
                       "read-only · historical commit")
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test \
  -only-testing:ShepherdModelTests/DocumentProvenanceTests 2>&1 | tail -20
```
Expected: FAIL — `cannot find 'DocumentProvenance' in scope`.

- [ ] **Step 3: Move `HighlightVariant` into its own pure file**

Create `spike/seam1/Sources/Workbench/HighlightVariant.swift`:

```swift
import Foundation

/// Which text a row's syntax colours are parsed from.
///
/// Lives in its own file, free of the editor and AppKit, so `DocumentProvenance` — the one
/// place that decides which variant a row gets — can be unit-tested. `MultiHighlighter`
/// caches by `(SourceID, HighlightVariant)`, so a variant is a cache key as much as a
/// description: anything that must not share a parse must differ here.
enum HighlightVariant: Hashable {
    /// The working copy.
    case new
    /// The base blob, for deletion bands.
    case old
    /// The merged text a conflicted file's document is showing.
    case mergePreview
    /// A file as of a commit. Keyed by sha: two commits touching one file are two texts.
    case commit(String)
    /// A fragment with no file position at all. Keyed by the block id so each band parses
    /// and caches on its own.
    case snippet(String)
}
```

Then **delete** lines 66–76 of `spike/seam1/Sources/Workbench/MultiHighlighter.swift` (the old `enum HighlightVariant` declaration and its doc comment). Leave everything else in that file alone.

- [ ] **Step 4: Write `DocumentProvenance`**

Create `spike/seam1/Sources/Workbench/DocumentProvenance.swift`:

```swift
import Foundation

/// Where a row reads its line text from, when the diff does not carry it.
///
/// Gap-revealed rows and rows of an edited file are the only rows whose text is not in the
/// diff, and they all funnel through one lookup in `WorkbenchSession.rebuild`.
enum LineTextSource: Equatable {
    case workingCopy
    case commitBlob(sha: String)
}

/// The document's provenance: what its text is, and therefore what may be done to it.
///
/// Three decisions, one place. Every one of them has a wrong answer that looks right on
/// screen — colours from the wrong file, a gap expansion splicing today's lines into a
/// three-week-old commit, an edit written at offsets derived from text that is not on disk.
enum DocumentProvenance {

    /// The variant a row's colours are parsed from.
    ///
    /// A commit wins over a merge preview: the lock means the two cannot coexist, but if
    /// they ever did, the commit is what the document is showing.
    static func variant(hasMergePreview: Bool, commitSha: String?) -> HighlightVariant {
        if let commitSha { return .commit(commitSha) }
        return hasMergePreview ? .mergePreview : .new
    }

    static func lineSource(commitSha: String?) -> LineTextSource {
        guard let commitSha else { return .workingCopy }
        return .commitBlob(sha: commitSha)
    }

    /// Editing history is not a thing. Read-only is structural here rather than a flag,
    /// so there is no path that forgets to check it.
    static func isEditable(commitSha: String?) -> Bool { commitSha == nil }

    /// Why the document will not accept typing. **Must be surfaced** — a buffer that
    /// silently refuses edits is the W2.2 defect.
    static func readOnlyReason(commitSha: String?) -> String? {
        commitSha == nil ? nil : "read-only · historical commit"
    }
}
```

- [ ] **Step 5: Register both files and run**

Add to `ShepherdModelTests`' `sources:` in `spike/seam1/project.yml`:
```yaml
      - path: Sources/Workbench/HighlightVariant.swift
      - path: Sources/Workbench/DocumentProvenance.swift
```

Run:
```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && xcodegen generate
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test \
  -only-testing:ShepherdModelTests/DocumentProvenanceTests 2>&1 | tail -20
```
Expected: PASS, 10 tests.

- [ ] **Step 6: Handle the new variant in `MultiHighlighter`'s consumers**

Build and fix the exhaustive `switch` in `WorkbenchSession.text(for:variant:)` (around line 410) by adding a case that returns `""` **for now** — Task 4 wires it to the blob cache:

```swift
        case .commit:
            // Wired to `BlobCache` in the next task; an empty string means "no colours yet",
            // never "colour from the working copy", which is the bug this exists to avoid.
            return ""
```

Run:
```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | grep -E "error:|BUILD" | head -20
```
Expected: `BUILD SUCCEEDED`.

- [ ] **Step 7: Commit**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd && \
git add spike/seam1/Sources/Workbench/HighlightVariant.swift \
        spike/seam1/Sources/Workbench/DocumentProvenance.swift \
        spike/seam1/Sources/Workbench/MultiHighlighter.swift \
        spike/seam1/Sources/Workbench/WorkbenchSession.swift \
        spike/seam1/Tests/DocumentProvenanceTests.swift spike/seam1/project.yml && \
git commit -m "$(cat <<'EOF'
feat(workbench): one place decides a document's provenance

Colours, line text and editability all follow from what the document *is*, and
each has a wrong answer that looks right on screen. HighlightVariant moves to
its own AppKit-free file so the decision can be tested.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `BlobCache` + session wiring for the commit document

**Files:**
- Create: `spike/seam1/Sources/Workbench/BlobCache.swift`
- Modify: `spike/seam1/Sources/Workbench/WorkbenchSession.swift` (`text(for:variant:)` ~line 410, `sourceAnchor` ~line 437, `rebuild()`'s `fileLines` lookup ~line 572, `canApplyEdit` ~line 1226, plus the new state)

**Interfaces:**
- Consumes: `CommitHistory.blobArguments` (Task 1); `DocumentProvenance`, `LineTextSource` (Task 3); `DiffReader.readCommit` (Task 2).
- Produces: on `WorkbenchSession` — `@Published private(set) var selectedCommit: Commit?`, `@Published private(set) var commits: [Commit]`, `func loadCommits()`, `func selectCommit(_ commit: Commit?)`; `BlobCache.cached(sha:path:) -> String?`, `BlobCache.request(sha:path:)`, `BlobCache.clear()`.

- [ ] **Step 1: Write `BlobCache`**

Create `spike/seam1/Sources/Workbench/BlobCache.swift`:

```swift
import Foundation

/// A file's text as of a commit, cached per `(sha, path)`.
///
/// **Lazy and off-main, with a redraw callback.** Not an optimization — the recorded
/// lesson: `SourceBuffer.init` eagerly ran `git show` per file and paid 287 main-thread
/// process spawns before the first row drew. It is also the correct shape for the
/// still-open "`git show` from `draw`" defect in the deletion-band path, which can adopt
/// this once it is proven here.
@MainActor
final class BlobCache {
    private struct Key: Hashable {
        let sha: String
        let path: String
    }

    private let cwd: String
    private var blobs: [Key: String] = [:]
    private var inFlight: Set<Key> = []

    /// Fired on the main thread after a blob lands, so the caller can invalidate the
    /// highlighter for that source and redraw. Never called synchronously from `request`.
    var onLoaded: ((String, String) -> Void)?

    init(cwd: String) { self.cwd = cwd }

    /// The text if it is already here. Callers must tolerate nil and ask again after
    /// `onLoaded` — an empty string is "not yet", never "colour from the working copy".
    func cached(sha: String, path: String) -> String? {
        blobs[Key(sha: sha, path: path)]
    }

    /// Start a fetch unless one is already cached or running. Deduplicated: a fragment can
    /// ask for the same blob on every draw pass.
    func request(sha: String, path: String) {
        let key = Key(sha: sha, path: path)
        guard blobs[key] == nil, !inFlight.contains(key) else { return }
        inFlight.insert(key)
        let cwd = self.cwd
        let args = CommitHistory.blobArguments(sha: sha, path: path)
        DispatchQueue.global(qos: .userInitiated).async {
            // A path that did not exist at this commit is an ordinary outcome (a file added
            // later), not an error worth surfacing: it caches as empty so it is asked once.
            let text: String
            if case .ok(let out) = GitStaging.run(args, cwd: cwd) { text = out } else { text = "" }
            DispatchQueue.main.async {
                self.inFlight.remove(key)
                self.blobs[key] = text
                self.onLoaded?(sha, path)
            }
        }
    }

    /// Dropped when the commit selection changes. Blobs are immutable, so nothing else
    /// invalidates them.
    func clear() {
        blobs.removeAll()
        inFlight.removeAll()
    }
}
```

- [ ] **Step 2: Regenerate and build**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && xcodegen generate && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | grep -E "error:|BUILD" | head -20
```
Expected: `BUILD SUCCEEDED`. (`BlobCache` is not added to the test target — it is a `Process`
shell, and its pure part, the argument builder, is already tested in Task 1.)

- [ ] **Step 3: Add the commit state to the session**

In `spike/seam1/Sources/Workbench/WorkbenchSession.swift`, add after the `focusedFile`
declaration (~line 50):

```swift
    /// The branch's commits, for the Commits scope. Empty until `loadCommits` runs.
    @Published private(set) var commits: [Commit] = []
    /// The commit the buffer is showing, and **the** definition of historical provenance.
    ///
    /// One piece of state, not a commit plus a flag: two things meaning "this document is
    /// history" is two things that can disagree, and a document coloured from the wrong
    /// text is exactly what that disagreement looks like.
    @Published private(set) var selectedCommit: Commit?

    /// Short sha of the shown commit, which is what every provenance decision keys off.
    var historicalSha: String? { selectedCommit?.sha }

    private lazy var blobCache = BlobCache(cwd: cwd)
```

Then add these methods near `load()`:

```swift
    /// Read the branch's commits. One `git log`, off-main, on the same triggers as `load`.
    func loadCommits() {
        let cwd = self.cwd
        let base = baseName ?? "main"
        DispatchQueue.global(qos: .userInitiated).async {
            let out: String
            if case .ok(let text) = GitStaging.run(CommitHistory.logArguments(base: base),
                                                  cwd: cwd) { out = text } else { out = "" }
            let parsed = CommitHistory.parse(out)
            DispatchQueue.main.async { self.commits = parsed }
        }
    }

    /// Drill into a commit, or nil to go back to the list.
    func selectCommit(_ commit: Commit?) {
        guard selectedCommit?.sha != commit?.sha else { return }
        selectedCommit = commit
        focusedFile = nil
        blobCache.clear()
        highlighter.invalidateAll()
        guard let commit else {
            files = []
            rebuild()
            return
        }
        loading = true
        let cwd = self.cwd
        DispatchQueue.global(qos: .userInitiated).async {
            let result = DiffReader.readCommit(cwd: cwd, sha: commit.sha)
            DispatchQueue.main.async {
                self.files = result.files
                self.stagedFiles = []
                self.baseLabel = result.baseLabel
                self.rebuild()
                self.loading = false
            }
        }
    }
```

If `MultiHighlighter` has no `invalidateAll()`, add one beside `invalidate(source:)`:

```swift
    /// Drop every cached parse. Used when the whole document's provenance changes.
    func invalidateAll() { cache.removeAll() }
```
(Match the existing cache property's name; `invalidate(source:)` is a filter over it.)

Wire `blobCache.onLoaded` in the session's `init` or beside the `buffer(for:)` callback setup:

```swift
        blobCache.onLoaded = { [weak self] _, path in
            guard let self else { return }
            self.highlighter.invalidate(source: self.source(of: path))
            self.rebuild()
        }
```

- [ ] **Step 4: Wire the three provenance points**

**(a) `text(for:variant:)`** — replace the placeholder `.commit` case from Task 3:

```swift
        case .commit(let sha):
            // nil means "not here yet" and colours arrive on `onLoaded`. Falling back to the
            // working copy here is the entire bug this design exists to prevent.
            let path = relativePath(of: source)
            if let text = blobCache.cached(sha: sha, path: path) { return text }
            blobCache.request(sha: sha, path: path)
            return ""
```

**(b) `sourceAnchor(atStitchedLine:)`** — replace the variant line:

```swift
        let variant = DocumentProvenance.variant(
            hasMergePreview: mergePreviews[origin.path] != nil,
            commitSha: historicalSha)
```

**(c) the `fileLines` lookup in `rebuild()`** (~line 572) — replace the two lines that fill
`fileLines[origin.path]`:

```swift
                if fileLines[origin.path] == nil {
                    // Gap-revealed rows and rows of an edited file are the only rows whose
                    // text is not in the diff. Reading the working copy for a historical
                    // document splices **today's** lines into an old commit.
                    let text: String
                    switch DocumentProvenance.lineSource(commitSha: historicalSha) {
                    case .workingCopy:
                        text = self.text(for: source(of: origin.path))
                    case .commitBlob(let sha):
                        let path = origin.path
                        text = blobCache.cached(sha: sha, path: path) ?? {
                            blobCache.request(sha: sha, path: path)
                            return ""
                        }()
                    }
                    fileLines[origin.path] = text.components(separatedBy: "\n")
                }
```

**(d) `canApplyEdit(range:)`** — add as the first guard:

```swift
        // History is not editable. Structural, and the header says so.
        guard DocumentProvenance.isEditable(commitSha: historicalSha) else { return false }
```

- [ ] **Step 5: Build and run the full suite**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test 2>&1 | tail -30
```
Expected: `BUILD SUCCEEDED` and the existing suite still green (no test count regression).

- [ ] **Step 6: Commit**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd && \
git add spike/seam1/Sources/Workbench/BlobCache.swift \
        spike/seam1/Sources/Workbench/WorkbenchSession.swift \
        spike/seam1/Sources/Workbench/MultiHighlighter.swift && \
git commit -m "$(cat <<'EOF'
feat(workbench): a commit's text comes from its own blobs

Three provenance points, all routed through DocumentProvenance: highlight
variant, the single fileLines lookup rebuild() uses for rows the diff does not
carry, and editability. The fileLines one is the easy miss — left alone,
expanding a hunk gap inside an old commit splices today's lines into it.

Blobs load lazily off-main with a redraw callback; an absent blob renders
uncoloured rather than falling back to the working copy.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: The Commits rail — list, drill-in, breadcrumb, read-only header

**Files:**
- Modify: `spike/seam1/Sources/Workbench/WorkbenchView.swift` (`scopeOptions` ~line 573, `keyBindings` ~line 114, the rail body, the header band)
- Modify: `spike/seam1/Sources/ShortcutCatalog.swift`

**Interfaces:**
- Consumes: `session.commits`, `session.selectedCommit`, `session.selectCommit(_:)`, `session.loadCommits()`, `CommitHistory.relativeAge`, `DocumentProvenance.readOnlyReason`.
- Produces: no new API — UI only.

- [ ] **Step 1: Add the scope segment**

In `scopeOptions` (~line 576), extend the `isRepo` branch so Commits sits after vs-base:

```swift
        var options: [ScopeOption] = session.isRepo ? [
            ScopeOption(id: .workingTree, title: "Working", tint: nil),
            ScopeOption(id: .vsBase, title: "vs \(session.baseName ?? "base")", tint: nil),
        ] : []
        // Only once there are commits to show: the rail must not reserve space for a scope
        // that does not exist yet. Gated on `isRepo` like its neighbours — outside a repo
        // there is no history and Files is the whole workbench.
        if session.isRepo, !session.commits.isEmpty {
            options.append(ScopeOption(id: .commits,
                                       title: "Commits",
                                       tint: nil,
                                       badge: session.commits.count))
        }
```

- [ ] **Step 2: Bind `⌃4`**

In `keyBindings` after the `⌃3` line (~line 116):

```swift
            key("4", [.control]) { if session.isRepo { session.setScope(.commits) } }
```

And add the display-only row to `ShortcutCatalog` beside the other `.workbench` entries,
matching their existing construction exactly (`key: nil`, category `.workbench`), with the
label `Commits scope` and glyph text `⌃4`. Then add its `ShortcutID` case to the exhaustive
`switch` in `ShortcutActions.run(_:)` with a `break`, as the other workbench rows do.

- [ ] **Step 3: Render the list and the drill-in**

Add to `WorkbenchView`:

```swift
    /// The Commits scope's rail: the branch's commits, or the selected commit's files.
    @ViewBuilder
    private var commitsRail: some View {
        if let commit = session.selectedCommit {
            Button {
                session.selectCommit(nil)
            } label: {
                HStack(spacing: 4) {
                    Text("‹").foregroundColor(Color(hex: Theme.Diff.gutterFg))
                    Text("COMMITS").font(.system(size: 10, weight: .semibold))
                    Text("·").foregroundColor(Color(hex: Theme.Diff.gutterFg))
                    Text(commit.shortSha).font(.system(size: 10, design: .monospaced))
                }
            }
            .buttonStyle(.plain)
            .focusable(false)
            fileSections   // the existing rail file list, which reads `session.files`
        } else {
            ForEach(session.commits) { commit in
                Button { session.selectCommit(commit) } label: { commitRow(commit) }
                    .buttonStyle(.plain)
                    .focusable(false)
            }
        }
    }

    private func commitRow(_ commit: Commit) -> some View {
        HStack(spacing: 6) {
            Circle().fill(Color(hex: Theme.Diff.modified)).frame(width: 5, height: 5)
            Text(commit.shortSha)
                .font(.system(size: 10, design: .monospaced))
                .foregroundColor(Color(hex: Theme.Diff.gutterFg))
            Text(commit.subject).font(.system(size: 11)).lineLimit(1)
            Spacer(minLength: 4)
            Text(CommitHistory.relativeAge(commit.timestamp, now: Date()))
                .font(.system(size: 10))
                .foregroundColor(Color(hex: Theme.Diff.gutterFg))
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }
```

Then in the rail's body, branch on the scope so `.commits` renders `commitsRail` in place of
the STAGED/UNSTAGED/COMMITTED sections. Reuse the existing file-section view for the
drilled-in state; if it is not already factored out, extract it as `fileSections` without
changing its behaviour.

**A commit's files carry no stage button.** Where the existing file row decides whether to
show one, add `session.selectedCommit == nil` to that condition — `git add` on a historical
path either does nothing or stages the wrong thing, and W1's own note says a button that
runs and moves nothing is worse than no button.

- [ ] **Step 4: Show the read-only reason in the header**

In the header band, beside the existing summary, add:

```swift
            if let commit = session.selectedCommit {
                Text("\(commit.shortSha) · \(commit.author) · \(CommitHistory.relativeAge(commit.timestamp, now: Date()))")
                    .font(.system(size: 11))
                if let reason = DocumentProvenance.readOnlyReason(commitSha: commit.sha) {
                    Text(reason)
                        .font(.system(size: 10))
                        .foregroundColor(Color(hex: Theme.Diff.gutterFg))
                }
            }
```

- [ ] **Step 5: Load the commits**

Wherever `WorkbenchView` triggers `session.load()` on appear and on reload, add
`session.loadCommits()` alongside it. Also clear the selection when leaving the scope — add
to `setScope` in `WorkbenchSession`, inside the existing body after `scope = next`:

```swift
        // Leaving Commits drops the historical document; staying in it keeps the drill-in.
        if next != .commits, selectedCommit != nil { selectCommit(nil) }
```

- [ ] **Step 6: Build**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test 2>&1 | tail -30
```
Expected: `BUILD SUCCEEDED`, suite green. (`ShortcutCatalogTests` asserts no duplicate
glyphs or ids and full `ShortcutID` coverage — if it fails, the new row collides with an
existing glyph or is missing from the catalog.)

- [ ] **Step 7: Commit**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd && \
git add spike/seam1/Sources/Workbench/WorkbenchView.swift \
        spike/seam1/Sources/Workbench/WorkbenchSession.swift \
        spike/seam1/Sources/ShortcutCatalog.swift && \
git commit -m "$(cat <<'EOF'
feat(workbench): Commits scope — the branch's commits, each as a diff

Clicking a commit narrows the rail to its files with a breadcrumb back, the same
shape focus(file:) already has, so there is one mental model for "clicking in the
rail scopes the buffer". The segment appears only once there are commits; the
rail reserves nothing for it before that. No stage buttons on a historical file.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `BlameParse` — porcelain into a line→sha map

**Files:**
- Create: `spike/seam1/Sources/Workbench/BlameParse.swift`
- Create: `spike/seam1/Tests/BlameParseTests.swift`
- Modify: `spike/seam1/project.yml`

**Interfaces:**
- Consumes: nothing.
- Produces: `struct BlameCommitMeta { let author: String; let timestamp: Date; let summary: String }`; `struct BlameResult { let shaByLine: [Int: String]; let meta: [String: BlameCommitMeta]; static let empty: BlameResult; static let uncommittedSha: String }`; `BlameParse.arguments(path: String) -> [String]`; `BlameParse.parse(_ porcelain: String) -> BlameResult`.

- [ ] **Step 1: Write the failing test**

Create `spike/seam1/Tests/BlameParseTests.swift`:

```swift
import XCTest
@testable import Shepherd

/// `git blame --porcelain` emits a sha's author/time/summary headers only on that sha's
/// **first** occurrence, so the parser must carry a sha → meta dictionary. That elision is
/// the whole reason for using `--porcelain` over `--line-porcelain`: on a file where three
/// commits own a thousand lines, it is three header blocks instead of a thousand.
final class BlameParseTests: XCTestCase {

    /// Real porcelain shape: a group header line, then headers, then a tab-prefixed content
    /// line. The second group repeats the sha and so carries no headers.
    private let sample = """
    aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 2
    author Eshaan Shah
    author-mail <eshaan@browserstack.com>
    author-time 1785235121
    author-tz +0530
    summary side-by-side diff
    filename f.swift
    \tlet a = 1
    aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 2 2
    \tlet b = 2
    bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 3 3 1
    author Someone Else
    author-mail <other@example.com>
    author-time 1785000000
    author-tz +0000
    summary earlier change
    filename f.swift
    \tlet c = 3
    """

    func testMapsEveryLineToItsCommit() {
        let result = BlameParse.parse(sample)
        XCTAssertEqual(result.shaByLine[1], String(repeating: "a", count: 40))
        XCTAssertEqual(result.shaByLine[2], String(repeating: "a", count: 40))
        XCTAssertEqual(result.shaByLine[3], String(repeating: "b", count: 40))
    }

    /// The elided-header case: line 2's group has no headers of its own.
    func testMetadataIsCarriedAcrossGroupsOfTheSameCommit() {
        let result = BlameParse.parse(sample)
        let meta = result.meta[String(repeating: "a", count: 40)]
        XCTAssertEqual(meta?.author, "Eshaan Shah")
        XCTAssertEqual(meta?.summary, "side-by-side diff")
        XCTAssertEqual(meta?.timestamp, Date(timeIntervalSince1970: 1_785_235_121))
    }

    func testSecondCommitGetsItsOwnMetadata() {
        let result = BlameParse.parse(sample)
        XCTAssertEqual(result.meta[String(repeating: "b", count: 40)]?.author, "Someone Else")
        XCTAssertEqual(result.meta.count, 2)
    }

    /// An uncommitted line is a real state the lane draws, not a parse failure.
    func testUncommittedLines() {
        let porcelain = """
        0000000000000000000000000000000000000000 4 4 1
        author Not Committed Yet
        author-mail <not.committed.yet>
        author-time 1785235999
        author-tz +0530
        summary Version of f.swift from f.swift
        filename f.swift
        \tlet d = 4
        """
        let result = BlameParse.parse(porcelain)
        XCTAssertEqual(result.shaByLine[4], BlameResult.uncommittedSha)
    }

    /// A content line is tab-prefixed, so a line of *code* that looks like a header must
    /// not be read as one.
    func testContentThatLooksLikeAHeaderIsNotParsedAsOne() {
        let porcelain = """
        aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 1
        author Real Author
        author-time 100
        summary real summary
        filename f.swift
        \tauthor Fake Author
        """
        let result = BlameParse.parse(porcelain)
        XCTAssertEqual(result.meta[String(repeating: "a", count: 40)]?.author, "Real Author")
    }

    func testEmptyInput() {
        XCTAssertTrue(BlameParse.parse("").shaByLine.isEmpty)
        XCTAssertTrue(BlameParse.parse("").meta.isEmpty)
    }

    /// `--porcelain`, never `--line-porcelain`, and `--` before the path so a file named
    /// like a revision is still a file.
    func testArguments() {
        XCTAssertEqual(BlameParse.arguments(path: "Sources/A.swift"),
                       ["blame", "--porcelain", "--", "Sources/A.swift"])
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test \
  -only-testing:ShepherdModelTests/BlameParseTests 2>&1 | tail -20
```
Expected: FAIL — `cannot find 'BlameParse' in scope`.

- [ ] **Step 3: Write minimal implementation**

Create `spike/seam1/Sources/Workbench/BlameParse.swift`:

```swift
import Foundation

/// Who last touched a commit's line, and when.
struct BlameCommitMeta: Equatable {
    let author: String
    let timestamp: Date
    let summary: String
}

/// A file's blame: every line's commit, and each commit's details once.
struct BlameResult: Equatable {
    /// 1-based final line number → commit sha.
    let shaByLine: [Int: String]
    let meta: [String: BlameCommitMeta]

    static let empty = BlameResult(shaByLine: [:], meta: [:])
    /// git's sha for a line that is not committed yet.
    static let uncommittedSha = String(repeating: "0", count: 40)

    func isUncommitted(_ sha: String) -> Bool { sha == Self.uncommittedSha }
}

/// `git blame --porcelain` → `BlameResult`.
///
/// `--porcelain` rather than `--line-porcelain`: it emits a commit's headers only on that
/// commit's first appearance, so a file where three commits own a thousand lines costs
/// three header blocks instead of a thousand. The price is that the parser must carry the
/// metadata forward in a dictionary, which is what `meta` is.
enum BlameParse {

    /// `--` before the path so a file named like a revision is still read as a file.
    static func arguments(path: String) -> [String] {
        ["blame", "--porcelain", "--", path]
    }

    static func parse(_ porcelain: String) -> BlameResult {
        var shaByLine: [Int: String] = [:]
        var meta: [String: BlameCommitMeta] = [:]
        var currentSha: String?
        var author: String?
        var authorTime: Double?
        var summary: String?

        func flush() {
            guard let sha = currentSha, meta[sha] == nil,
                  let author, let authorTime, let summary else { return }
            meta[sha] = BlameCommitMeta(author: author,
                                        timestamp: Date(timeIntervalSince1970: authorTime),
                                        summary: summary)
        }

        for line in porcelain.components(separatedBy: "\n") {
            // A content line is tab-prefixed. Checking this first is what stops a line of
            // code that happens to read `author Fake` from being parsed as a header.
            if line.hasPrefix("\t") { continue }

            let fields = line.split(separator: " ", maxSplits: 3,
                                    omittingEmptySubsequences: false).map(String.init)
            // Group header: "<40-hex sha> <origLine> <finalLine> [<numLines>]". Only the
            // first group of a commit carries the numLines field.
            if let first = fields.first, isSha(first), fields.count >= 3,
               let finalLine = Int(fields[2]) {
                flush()
                currentSha = first
                author = nil; authorTime = nil; summary = nil
                shaByLine[finalLine] = first
                continue
            }

            guard let key = fields.first else { continue }
            let value = String(line.dropFirst(key.count)).trimmingCharacters(in: .whitespaces)
            switch key {
            case "author":      author = value
            case "author-time": authorTime = Double(value)
            case "summary":     summary = value
            default:            break
            }
        }
        flush()
        return BlameResult(shaByLine: shaByLine, meta: meta)
    }

    private static func isSha(_ text: String) -> Bool {
        text.count == 40 && text.allSatisfy { $0.isHexDigit }
    }
}
```

- [ ] **Step 4: Register and run**

Add to `ShepherdModelTests`' `sources:` in `project.yml`:
```yaml
      - path: Sources/Workbench/BlameParse.swift
```

Run:
```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && xcodegen generate
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test \
  -only-testing:ShepherdModelTests/BlameParseTests 2>&1 | tail -20
```
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd && \
git add spike/seam1/Sources/Workbench/BlameParse.swift \
        spike/seam1/Tests/BlameParseTests.swift spike/seam1/project.yml && \
git commit -m "$(cat <<'EOF'
feat(workbench): parse git blame --porcelain

Porcelain elides a commit's headers after its first group, so the parser carries
metadata in a dictionary — the trade that makes it a fraction of
--line-porcelain's size. Content lines are tab-prefixed, checked first, so a line
of code reading `author Fake` is not parsed as a header.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `BlameLane` — rows into lane runs

**Files:**
- Create: `spike/seam1/Sources/Workbench/BlameLane.swift`
- Create: `spike/seam1/Tests/BlameLaneTests.swift`
- Modify: `spike/seam1/project.yml`

**Interfaces:**
- Consumes: `BlameResult`, `BlameCommitMeta` (Task 6).
- Produces: `enum BlameShade: Int { case fresh, recent, stale, old, uncommitted }`; `struct BlameRow { let sha: String; let shade: BlameShade; let isRunStart: Bool }`; `BlameLane.shade(commitTime: Date, now: Date) -> BlameShade`; `BlameLane.rows(lineNumbers: [Int?], blame: BlameResult, now: Date) -> [BlameRow?]`.

- [ ] **Step 1: Write the failing test**

Create `spike/seam1/Tests/BlameLaneTests.swift`:

```swift
import XCTest
@testable import Shepherd

/// The lane's shape. Age gives the heat, a separator at each run start gives the grouping —
/// two encodings that do not fight, so "this whole block is one change" reads at a glance.
final class BlameLaneTests: XCTestCase {

    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private let shaA = String(repeating: "a", count: 40)
    private let shaB = String(repeating: "b", count: 40)

    private func blame(_ pairs: [(Int, String)]) -> BlameResult {
        BlameResult(shaByLine: Dictionary(uniqueKeysWithValues: pairs), meta: [:])
    }

    func testShadeBuckets() {
        XCTAssertEqual(BlameLane.shade(commitTime: now.addingTimeInterval(-3600), now: now),
                       .fresh)
        XCTAssertEqual(BlameLane.shade(commitTime: now.addingTimeInterval(-4 * 86400), now: now),
                       .recent)
        XCTAssertEqual(BlameLane.shade(commitTime: now.addingTimeInterval(-40 * 86400), now: now),
                       .stale)
        XCTAssertEqual(BlameLane.shade(commitTime: now.addingTimeInterval(-400 * 86400), now: now),
                       .old)
    }

    /// A row is a run start when its commit differs from the row above it — that is what the
    /// separator is drawn from.
    func testConsecutiveRowsOfOneCommitFormOneRun() {
        let rows = BlameLane.rows(lineNumbers: [1, 2, 3],
                                  blame: blame([(1, shaA), (2, shaA), (3, shaA)]), now: now)
        XCTAssertEqual(rows.compactMap { $0?.isRunStart }, [true, false, false])
    }

    func testACommitChangeStartsANewRun() {
        let rows = BlameLane.rows(lineNumbers: [1, 2, 3],
                                  blame: blame([(1, shaA), (2, shaB), (3, shaB)]), now: now)
        XCTAssertEqual(rows.compactMap { $0?.isRunStart }, [true, true, false])
    }

    /// A band has no new-side line number, so it gets no lane cell at all — and it must not
    /// merge the runs either side of it into one.
    func testRowsWithNoLineNumberGetNoCellAndBreakTheRun() {
        let rows = BlameLane.rows(lineNumbers: [1, nil, 2],
                                  blame: blame([(1, shaA), (2, shaA)]), now: now)
        XCTAssertEqual(rows.count, 3)
        XCTAssertNil(rows[1])
        XCTAssertEqual(rows[0]?.isRunStart, true)
        XCTAssertEqual(rows[2]?.isRunStart, true)
    }

    /// A line the blame does not cover draws nothing rather than guessing.
    func testUnknownLineGetsNoCell() {
        let rows = BlameLane.rows(lineNumbers: [1, 99],
                                  blame: blame([(1, shaA)]), now: now)
        XCTAssertNotNil(rows[0])
        XCTAssertNil(rows[1])
    }

    func testUncommittedLinesGetTheUncommittedShade() {
        let rows = BlameLane.rows(lineNumbers: [1],
                                  blame: blame([(1, BlameResult.uncommittedSha)]), now: now)
        XCTAssertEqual(rows[0]?.shade, .uncommitted)
    }

    /// With no metadata for a sha there is no timestamp, so no age — it still gets a cell and
    /// a run boundary, just the oldest shade.
    func testMissingMetadataFallsBackToOldRatherThanNoCell() {
        let rows = BlameLane.rows(lineNumbers: [1], blame: blame([(1, shaA)]), now: now)
        XCTAssertEqual(rows[0]?.shade, .old)
        XCTAssertEqual(rows[0]?.sha, shaA)
    }

    func testEmptyDocument() {
        XCTAssertTrue(BlameLane.rows(lineNumbers: [], blame: .empty, now: now).isEmpty)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test \
  -only-testing:ShepherdModelTests/BlameLaneTests 2>&1 | tail -20
```
Expected: FAIL — `cannot find 'BlameLane' in scope`.

- [ ] **Step 3: Write minimal implementation**

Create `spike/seam1/Sources/Workbench/BlameLane.swift`:

```swift
import Foundation

/// How hot a lane cell is drawn. Age only — the run separator carries grouping, so the
/// shade does not also have to distinguish neighbouring commits.
enum BlameShade: Int, Equatable {
    case fresh, recent, stale, old, uncommitted
}

/// One row's lane cell.
struct BlameRow: Equatable {
    let sha: String
    let shade: BlameShade
    /// True when the row above belongs to a different commit (or to none). The hairline
    /// separator is drawn from this.
    let isRunStart: Bool
}

/// Rows → lane cells.
///
/// Pure, and it takes the document's line numbers rather than reading them itself: the
/// gutter's numbers are the real row → source-line mapping (`RowOrigin.newLineNumber`), and
/// deriving it any other way is the mistake that painted rows with unrelated lines.
enum BlameLane {

    static func shade(commitTime: Date, now: Date) -> BlameShade {
        switch max(0, now.timeIntervalSince(commitTime)) {
        case ..<86400:          return .fresh    // today
        case ..<(7 * 86400):    return .recent   // this week
        case ..<(90 * 86400):   return .stale    // this quarter
        default:                return .old
        }
    }

    /// - Parameters:
    ///   - lineNumbers: per stitched row, its 1-based new-side line number, or nil for a row
    ///     that has none — a deletion band's host row, or anything the blame does not cover.
    /// - Returns: one optional cell per row, index-aligned with `lineNumbers`.
    static func rows(lineNumbers: [Int?], blame: BlameResult, now: Date) -> [BlameRow?] {
        var out: [BlameRow?] = []
        out.reserveCapacity(lineNumbers.count)
        var previousSha: String?

        for number in lineNumbers {
            guard let number, let sha = blame.shaByLine[number] else {
                // No cell, and the run is broken: a band between two stretches of one
                // commit must not join them into a single unbroken bar.
                out.append(nil)
                previousSha = nil
                continue
            }
            let shade: BlameShade
            if blame.isUncommitted(sha) {
                shade = .uncommitted
            } else if let meta = blame.meta[sha] {
                shade = self.shade(commitTime: meta.timestamp, now: now)
            } else {
                // A sha with no metadata still gets a cell — abstaining would read as "not
                // committed", which is a different and wrong claim.
                shade = .old
            }
            out.append(BlameRow(sha: sha, shade: shade, isRunStart: sha != previousSha))
            previousSha = sha
        }
        return out
    }
}
```

- [ ] **Step 4: Register and run**

Add to `ShepherdModelTests`' `sources:` in `project.yml`:
```yaml
      - path: Sources/Workbench/BlameLane.swift
```

Run:
```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && xcodegen generate
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test \
  -only-testing:ShepherdModelTests/BlameLaneTests 2>&1 | tail -20
```
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd && \
git add spike/seam1/Sources/Workbench/BlameLane.swift \
        spike/seam1/Tests/BlameLaneTests.swift spike/seam1/project.yml && \
git commit -m "$(cat <<'EOF'
feat(workbench): blame lane runs and age shades

Takes the document's line numbers rather than deriving them: RowOrigin's numbers
are the real row -> source-line mapping. A row with no number breaks the run
instead of joining the stretches either side of it, and an uncovered line draws
nothing rather than guessing.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Draw the lane in the gutter

**Files:**
- Modify: `spike/seam1/Sources/Theme.swift:111-122` (`Diff` tokens) and `derivedTokens`
- Modify: `spike/seam1/Sources/Workbench/DiffGutter.swift` (`width(maxLineNumber:)` ~line 228, `draw` ~line 250)
- Modify: `spike/seam1/Sources/Workbench/WorkbenchSession.swift` (blame cache + `blameRows`)
- Modify: `spike/seam1/Sources/Workbench/EditorHost.swift` (`WorkbenchGutter.updateNSView`)

**Interfaces:**
- Consumes: `BlameLane.rows`, `BlameRow`, `BlameShade` (Task 7); `BlameParse` (Task 6).
- Produces: `Theme.Diff.blameHeat`, `Theme.Diff.blameUncommitted`; on the session — `@Published private(set) var blameRows: [BlameRow?]`, `func loadBlame()`, `var blameFilePath: String?`; on `DiffGutterView` — `var blameRows: [BlameRow?]`, `static let blameLaneWidth: CGFloat`, `static func width(maxLineNumber: Int, hasBlame: Bool) -> CGFloat`.

- [ ] **Step 1: Add the theme tokens**

In `spike/seam1/Sources/Theme.swift`, inside `enum Diff` after `wordDel`:

```swift
        /// The blame lane's hue. One token, four alpha steps by age — a token per bucket
        /// would be four values to keep in tune across three themes for no gain.
        static var blameHeat        : UInt32 { pickHex(dark: 0x58A6FF, light: 0x0969DA, warm: 0x3F6E91) }
        /// A line that is not committed yet. Deliberately not the heat hue: it is a
        /// different kind of fact, not a fresher version of the same one.
        static var blameUncommitted : UInt32 { pickHex(dark: 0x8B949E, light: 0x8C959F, warm: 0x9A8F79) }
```

Add both to the `derivedTokens` dictionary alongside the other `diff.*` entries so
`ThemeDerivationTests` covers them:

```swift
            "diff.blameHeat": Diff.blameHeat,
            "diff.blameUncommitted": Diff.blameUncommitted,
```

- [ ] **Step 2: Add the session's blame state**

In `WorkbenchSession`, add near the commit state:

```swift
    /// Per stitched row, its blame cell — empty unless the buffer is narrowed to one file.
    @Published private(set) var blameRows: [BlameRow?] = []
    /// Per-sha details, for the header annotation.
    @Published private(set) var blameMeta: [String: BlameCommitMeta] = [:]
    private var blameCache: [String: BlameResult] = [:]

    /// The one file blame is available for, or nil.
    ///
    /// Narrowed-to-one-file only, and never for a historical or conflicted document. Running
    /// it for a whole diff would be one `git blame` per file — the same mistake
    /// `SourceBuffer.init` made with `git show`, which cost 287 main-thread spawns.
    var blameFilePath: String? {
        guard selectedCommit == nil, !hasConflicts else { return nil }
        if let focusedFile { return focusedFile }
        let paths = Set(rowOrigins.map(\.path))
        return paths.count == 1 ? paths.first : nil
    }

    /// Read blame for the narrowed file, then project it onto the rows.
    func loadBlame() {
        guard let path = blameFilePath else {
            blameRows = []
            blameMeta = [:]
            return
        }
        if let cached = blameCache[path] {
            projectBlame(cached)
            return
        }
        let cwd = self.cwd
        DispatchQueue.global(qos: .userInitiated).async {
            let out: String
            if case .ok(let text) = GitStaging.run(BlameParse.arguments(path: path),
                                                  cwd: cwd) { out = text } else { out = "" }
            let parsed = BlameParse.parse(out)
            DispatchQueue.main.async {
                self.blameCache[path] = parsed
                guard self.blameFilePath == path else { return }   // narrowed away meanwhile
                self.projectBlame(parsed)
            }
        }
    }

    private func projectBlame(_ result: BlameResult) {
        blameRows = BlameLane.rows(lineNumbers: rowOrigins.map(\.newLineNumber),
                                   blame: result, now: Date())
        blameMeta = result.meta
    }

    /// Blame goes stale when the file changes or HEAD moves.
    func invalidateBlame(path: String? = nil) {
        if let path { blameCache.removeValue(forKey: path) } else { blameCache.removeAll() }
        blameRows = []
    }
```

Call `loadBlame()` at the end of `rebuild()`, `invalidateBlame(path:)` from the buffer's
`onExternalWrite` callback and from `saveEdits()`, and `invalidateBlame()` (all) from
`commit(push:)`, `checkout(branch:)` and `continueOperation()` (Task 12).

- [ ] **Step 3: Draw the lane**

In `DiffGutter.swift`, add to the metrics section beside `leadingPad` / `gap` / `signColumn`:

```swift
    /// The blame lane: a thin bar, not a text column. W1 took this gutter from ~138pt to
    /// ~66pt by deleting a second number column, and removed the staging checkbox column
    /// outright — per-row width reserved for an occasional job is not worth it. The facts
    /// live in the header annotation instead.
    static let blameLaneWidth: CGFloat = 5
    static let blameLaneGap: CGFloat = 4
```

Change the width function and update **every** caller:

```swift
    static func width(maxLineNumber: Int, hasBlame: Bool) -> CGFloat {
        let lane = hasBlame ? blameLaneWidth + blameLaneGap : 0
        return leadingPad + lane + digitWidth(maxLineNumber) + gap + signColumn + trailingPad
    }
```

Add the row store and draw. In `DiffGutterView`:

```swift
    /// Per stitched row, its blame cell. Empty means no lane at all.
    var blameRows: [BlameRow?] = []

    private var laneOffset: CGFloat {
        blameRows.isEmpty ? 0 : Self.blameLaneWidth + Self.blameLaneGap
    }

    /// The lane's cell for a row, drawn at the row's real geometry.
    private func drawBlameCell(_ row: Int, y: CGFloat, height: CGFloat) {
        guard blameRows.indices.contains(row), let cell = blameRows[row] else { return }
        let rect = NSRect(x: Self.leadingPad, y: y,
                          width: Self.blameLaneWidth, height: height)
        let color: NSColor
        switch cell.shade {
        case .uncommitted:
            color = NSColor(Color(hex: Theme.Diff.blameUncommitted)).withAlphaComponent(0.35)
        case .fresh:  color = NSColor(Color(hex: Theme.Diff.blameHeat)).withAlphaComponent(0.85)
        case .recent: color = NSColor(Color(hex: Theme.Diff.blameHeat)).withAlphaComponent(0.60)
        case .stale:  color = NSColor(Color(hex: Theme.Diff.blameHeat)).withAlphaComponent(0.38)
        case .old:    color = NSColor(Color(hex: Theme.Diff.blameHeat)).withAlphaComponent(0.20)
        }
        color.setFill()
        rect.fill()
        if cell.isRunStart {
            NSColor(Color(hex: Theme.Diff.buffer)).setFill()
            NSRect(x: rect.minX, y: y, width: Self.blameLaneWidth, height: 1).fill()
        }
    }
```

In `draw`, inside the existing per-row loop — which already resolves each row's real
`(y, height)` from `lineMetrics(index)` — call `drawBlameCell(index, y: y, height: rowHeight)`
before the number is drawn, and shift the number/sign x positions by `laneOffset`: every
`Self.leadingPad + …` x expression in the row and band drawing becomes
`Self.leadingPad + laneOffset + …`.

**Do not compute the row's y or height any other way.** `lineMetrics` reads
`layoutManager.textLineForIndex`; arithmetic from `rowHeight` drifts against the text and is
wrong outright for a row carrying a band. Inside a deletion band, a row's height is
`block.height / lines.count`, which the band-drawing path already computes — reuse that value
rather than introducing a third opinion.

- [ ] **Step 4: Feed it from the editor host**

In `EditorHost.swift`'s `WorkbenchGutter.updateNSView`, beside the existing assignments:

```swift
        view.blameRows = session.blameRows
```

And update the gutter's width call site to pass `hasBlame: !session.blameRows.isEmpty`.

- [ ] **Step 5: Build and run the suite**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test 2>&1 | tail -30
```
Expected: `BUILD SUCCEEDED`, suite green including `ThemeDerivationTests`.

- [ ] **Step 6: Commit**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd && \
git add spike/seam1/Sources/Theme.swift spike/seam1/Sources/Workbench/DiffGutter.swift \
        spike/seam1/Sources/Workbench/WorkbenchSession.swift \
        spike/seam1/Sources/Workbench/EditorHost.swift && \
git commit -m "$(cat <<'EOF'
feat(workbench): blame lane in the gutter

A 5pt bar, not a text column — age by alpha, grouping by a separator at each run
start. Present only when the buffer is narrowed to one file: a lane for a whole
diff would be one `git blame` per file, the spawn-per-file mistake again.

Cells are drawn at each row's real layout geometry, never arithmetic from
rowHeight.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Hover, the header annotation, and the lane click

**Files:**
- Modify: `spike/seam1/Sources/Workbench/DiffGutter.swift` (tracking area, `mouseMoved`, `mouseExited`, `mouseDown`)
- Modify: `spike/seam1/Sources/Workbench/WorkbenchSession.swift` (hover state + annotation)
- Modify: `spike/seam1/Sources/Workbench/WorkbenchView.swift` (header annotation row)

**Interfaces:**
- Consumes: `session.blameRows`, `session.blameMeta`, `session.cursorStitchedLine`, `session.commits`, `session.selectCommit`, `CommitHistory.relativeAge`.
- Produces: on the session — `@Published var hoveredBlameRow: Int?`, `var blameAnnotation: String?`, `func revealCommit(sha: String)`; on `DiffGutterView` — `var onHoverBlameRow: ((Int?) -> Void)?`, `var onClickBlame: ((Int) -> Void)?`.

- [ ] **Step 1: Add the annotation to the session**

```swift
    /// The lane row the pointer is over, if any. Overrides the cursor row in the header.
    @Published var hoveredBlameRow: Int?

    /// The blame line the header shows: hovered row if there is one, else the cursor's.
    ///
    /// The lane encodes shape and no facts, and hover-only text is never actually on screen.
    /// Sourcing this from the cursor by default is what makes the information readable
    /// without a per-row text column; hover is then an accelerator, not the only path.
    var blameAnnotation: String? {
        let row = hoveredBlameRow ?? cursorStitchedLine
        guard let row, blameRows.indices.contains(row), let cell = blameRows[row] else {
            return nil
        }
        if cell.shade == .uncommitted { return "not committed yet" }
        guard let meta = blameMeta[cell.sha] else { return nil }
        let short = String(cell.sha.prefix(7))
        let age = CommitHistory.relativeAge(meta.timestamp, now: Date())
        return "\(short) · \(meta.author) · \(age) · \(meta.summary)"
    }

    /// Jump to a commit in the Commits scope. Closes the loop from the lane to history.
    ///
    /// A sha outside `<base>..HEAD` is not in the list — an old line's commit usually
    /// predates the branch — so the scope switch is refused rather than landing on an empty
    /// list with no explanation.
    func revealCommit(sha: String) {
        guard let commit = commits.first(where: { $0.sha == sha }) else {
            lastError = "\(String(sha.prefix(7))) is not on this branch"
            return
        }
        setScope(.commits)
        selectCommit(commit)
    }
```

- [ ] **Step 2: Track hover in the gutter**

In `DiffGutterView`:

```swift
    var onHoverBlameRow: ((Int?) -> Void)?
    var onClickBlame: ((Int) -> Void)?

    private var blameTrackingArea: NSTrackingArea?

    /// Re-added on every bounds change, and on every attach.
    ///
    /// A rebuild hands us a new editor, scroll view and clip view — an "already installed,
    /// skip" short-circuit is what left the gutter observing a dead clip view and frozen
    /// from the first rebuild onward. There is no such short-circuit here.
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let existing = blameTrackingArea { removeTrackingArea(existing) }
        guard !blameRows.isEmpty else { blameTrackingArea = nil; return }
        let area = NSTrackingArea(
            rect: NSRect(x: Self.leadingPad, y: 0,
                         width: Self.blameLaneWidth, height: bounds.height),
            options: [.mouseEnteredAndExited, .mouseMoved, .activeInKeyWindow],
            owner: self, userInfo: nil)
        addTrackingArea(area)
        blameTrackingArea = area
    }

    override func mouseMoved(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        // Row resolved through the layout manager, never arithmetic: a row carrying a band
        // is not one row tall.
        onHoverBlameRow?(lineIndex(documentY: point.y + scrollY))
    }

    override func mouseExited(with event: NSEvent) {
        onHoverBlameRow?(nil)
    }
```

Use whichever expression the existing `draw` uses to convert a view y to a document y — do
not invent a second one; if `lineIndex(documentY:)` already takes a view-space y, pass
`point.y` unchanged.

In the existing `mouseDown`, add the lane check **before** the line-selection path:

```swift
        let point = convert(event.locationInWindow, from: nil)
        // x-range first: a gutter click/drag already means "select these lines for
        // staging", and the lane must not steal it.
        if !blameRows.isEmpty,
           point.x >= Self.leadingPad,
           point.x <= Self.leadingPad + Self.blameLaneWidth,
           let row = lineIndex(documentY: point.y + scrollY) {
            onClickBlame?(row)
            return
        }
```

- [ ] **Step 3: Wire the callbacks and the header**

In `EditorHost.swift`'s `WorkbenchGutter.updateNSView`:

```swift
        view.onHoverBlameRow = { row in session.hoveredBlameRow = row }
        view.onClickBlame = { row in
            guard session.blameRows.indices.contains(row),
                  let cell = session.blameRows[row] else { return }
            session.revealCommit(sha: cell.sha)
        }
```

In the header band in `WorkbenchView.swift`:

```swift
            if let annotation = session.blameAnnotation {
                Text(annotation)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(Color(hex: Theme.Diff.gutterFg))
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
```

- [ ] **Step 4: Build and run the suite**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test 2>&1 | tail -30
```
Expected: `BUILD SUCCEEDED`, suite green.

- [ ] **Step 5: Commit**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd && \
git add spike/seam1/Sources/Workbench/DiffGutter.swift \
        spike/seam1/Sources/Workbench/WorkbenchSession.swift \
        spike/seam1/Sources/Workbench/WorkbenchView.swift \
        spike/seam1/Sources/Workbench/EditorHost.swift && \
git commit -m "$(cat <<'EOF'
feat(workbench): blame text in the header, hover and click on the lane

The header annotation follows the cursor row by default and hover overrides it,
so the facts are on screen without a per-row text column. Clicking the lane
reveals the commit, refusing with a reason when the sha predates the branch
rather than landing on an empty list.

Tracking area is re-added on every bounds change with no already-installed
short-circuit, and the click hit-tests x first so it cannot steal the gutter's
line-selection drag.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: `SequencePolicy` — the pure half of the seam

**Files:**
- Create: `spike/seam1/Sources/Workbench/SequencePolicy.swift`
- Create: `spike/seam1/Tests/SequencePolicyTests.swift`
- Modify: `spike/seam1/project.yml`

**Interfaces:**
- Consumes: `MergeState.Operation` (existing, in `ConflictReader.swift`).
- Produces: `SequencePolicy.verb(_:) -> String?`; `.continueArguments(_:) -> [String]?`; `.messageFileName(_:) -> String?`; `.displayMessage(_:) -> String`; `.canContinue(isActive:unresolved:writing:) -> Bool`; `.blockedReason(isActive:unresolved:writing:) -> String?`.

- [ ] **Step 1: Write the failing test**

Create `spike/seam1/Tests/SequencePolicyTests.swift`:

```swift
import XCTest
@testable import Shepherd

/// Finishing a stopped rebase / cherry-pick / merge.
///
/// The message-file names were **probed against git 2.55**, not assumed: W3 lost time to
/// assuming `rebase-merge/onto_name` exists for a plain `git rebase` (it does not, and a
/// button ended up labelled with forty hex characters).
final class SequencePolicyTests: XCTestCase {

    func testVerbPerOperation() {
        XCTAssertEqual(SequencePolicy.verb(.merge), "merge")
        XCTAssertEqual(SequencePolicy.verb(.rebase), "rebase")
        XCTAssertEqual(SequencePolicy.verb(.cherryPick), "cherry-pick")
        XCTAssertNil(SequencePolicy.verb(.none))
    }

    func testContinueArguments() {
        XCTAssertEqual(SequencePolicy.continueArguments(.rebase), ["rebase", "--continue"])
        XCTAssertEqual(SequencePolicy.continueArguments(.merge), ["merge", "--continue"])
        XCTAssertEqual(SequencePolicy.continueArguments(.cherryPick),
                       ["cherry-pick", "--continue"])
        XCTAssertNil(SequencePolicy.continueArguments(.none))
    }

    /// Measured: a rebase parks its message in `rebase-merge/message`; merge and
    /// cherry-pick both use `MERGE_MSG`.
    func testMessageFileNames() {
        XCTAssertEqual(SequencePolicy.messageFileName(.rebase), "rebase-merge/message")
        XCTAssertEqual(SequencePolicy.messageFileName(.merge), "MERGE_MSG")
        XCTAssertEqual(SequencePolicy.messageFileName(.cherryPick), "MERGE_MSG")
        XCTAssertNil(SequencePolicy.messageFileName(.none))
    }

    /// Every one of those files ends with a `# Conflicts:` block git strips at commit time.
    func testDisplayMessageStripsGitsComments() {
        let raw = """
        feat: the real subject

        body line

        # Conflicts:
        #\tf.txt
        """
        XCTAssertEqual(SequencePolicy.displayMessage(raw),
                       "feat: the real subject\n\nbody line")
    }

    /// A `#` inside the body, not at line start, is content.
    func testDisplayMessageKeepsInlineHashes() {
        XCTAssertEqual(SequencePolicy.displayMessage("fix: issue #42\n"), "fix: issue #42")
    }

    func testDisplayMessageOfNothing() {
        XCTAssertEqual(SequencePolicy.displayMessage(""), "")
        XCTAssertEqual(SequencePolicy.displayMessage("# Conflicts:\n#\tf.txt\n"), "")
    }

    // MARK: the gate

    func testCanContinueOnlyWhenActiveAndSettled() {
        XCTAssertTrue(SequencePolicy.canContinue(isActive: true, unresolved: 0, writing: false))
        XCTAssertFalse(SequencePolicy.canContinue(isActive: false, unresolved: 0, writing: false))
        XCTAssertFalse(SequencePolicy.canContinue(isActive: true, unresolved: 3, writing: false))
        XCTAssertFalse(SequencePolicy.canContinue(isActive: true, unresolved: 0, writing: true))
    }

    /// A disabled button with a reason, never a dead one.
    func testBlockedReasons() {
        XCTAssertNil(SequencePolicy.blockedReason(isActive: true, unresolved: 0, writing: false))
        XCTAssertEqual(SequencePolicy.blockedReason(isActive: true, unresolved: 1, writing: false),
                       "1 conflict left")
        XCTAssertEqual(SequencePolicy.blockedReason(isActive: true, unresolved: 3, writing: false),
                       "3 conflicts left")
        XCTAssertEqual(SequencePolicy.blockedReason(isActive: true, unresolved: 0, writing: true),
                       "git is running")
        XCTAssertEqual(SequencePolicy.blockedReason(isActive: false, unresolved: 0, writing: false),
                       "nothing in progress")
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test \
  -only-testing:ShepherdModelTests/SequencePolicyTests 2>&1 | tail -20
```
Expected: FAIL — `cannot find 'SequencePolicy' in scope`.

- [ ] **Step 3: Write minimal implementation**

Create `spike/seam1/Sources/Workbench/SequencePolicy.swift`:

```swift
import Foundation

/// Finishing a stopped multi-commit operation.
///
/// The workbench can already resolve a conflict and abort an operation, but nothing ran
/// `--continue`, so a rebase started in a terminal pane and resolved here was stranded
/// half-applied. This is the pure half of closing that loop.
enum SequencePolicy {

    static func verb(_ operation: MergeState.Operation) -> String? {
        switch operation {
        case .merge:      return "merge"
        case .rebase:     return "rebase"
        case .cherryPick: return "cherry-pick"
        case .none:       return nil
        }
    }

    static func continueArguments(_ operation: MergeState.Operation) -> [String]? {
        guard let verb = verb(operation) else { return nil }
        return [verb, "--continue"]
    }

    /// Where git parked the message it is going to commit, relative to the git dir.
    ///
    /// **Measured against git 2.55**, not assumed: a rebase writes `rebase-merge/message`
    /// while merge and cherry-pick both write `MERGE_MSG`. Resolve through
    /// `rev-parse --git-path` so linked worktrees and non-default layouts work.
    static func messageFileName(_ operation: MergeState.Operation) -> String? {
        switch operation {
        case .rebase:                return "rebase-merge/message"
        case .merge, .cherryPick:    return "MERGE_MSG"
        case .none:                  return nil
        }
    }

    /// The message without git's own comment block.
    ///
    /// All three files end with a `# Conflicts:` list that git strips at commit time. Only
    /// a `#` at the start of a line is a comment — `fix: issue #42` is content.
    static func displayMessage(_ raw: String) -> String {
        raw.components(separatedBy: "\n")
            .filter { !$0.hasPrefix("#") }
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func canContinue(isActive: Bool, unresolved: Int, writing: Bool) -> Bool {
        isActive && unresolved == 0 && !writing
    }

    /// Why Continue is disabled. Never nil when `canContinue` is false — a dead button with
    /// no explanation is the thing this project keeps refusing to ship.
    static func blockedReason(isActive: Bool, unresolved: Int, writing: Bool) -> String? {
        if !isActive { return "nothing in progress" }
        if writing { return "git is running" }
        if unresolved > 0 {
            return "\(unresolved) conflict\(unresolved == 1 ? "" : "s") left"
        }
        return nil
    }
}
```

- [ ] **Step 4: Register and run**

Add to `ShepherdModelTests`' `sources:` in `project.yml`:
```yaml
      - path: Sources/Workbench/SequencePolicy.swift
```

Run:
```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && xcodegen generate
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test \
  -only-testing:ShepherdModelTests/SequencePolicyTests 2>&1 | tail -20
```
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd && \
git add spike/seam1/Sources/Workbench/SequencePolicy.swift \
        spike/seam1/Tests/SequencePolicyTests.swift spike/seam1/project.yml && \
git commit -m "$(cat <<'EOF'
feat(workbench): SequencePolicy — the pure half of finishing a rebase

Message-file names probed against git 2.55 rather than assumed: rebase parks its
message in rebase-merge/message, merge and cherry-pick in MERGE_MSG, all three
with a # Conflicts: block to strip. blockedReason is never nil when the button is
disabled.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: `SequenceRunner` + `GitStaging.run(env:)` + the real-git test

**Files:**
- Modify: `spike/seam1/Sources/Workbench/GitStaging.swift:128` (`run` gains `env:`)
- Create: `spike/seam1/Sources/Workbench/SequenceRunner.swift`
- Create: `spike/seam1/Tests/SequenceIntegrationTests.swift`

**Interfaces:**
- Consumes: `SequencePolicy` (Task 10); `GitResult`, `GitStaging.run`.
- Produces: `GitStaging.run(_ args: [String], cwd: String, stdin: String? = nil, env: [String: String]? = nil) -> GitResult`; `SequenceRunner.pendingMessage(cwd: String, operation: MergeState.Operation) -> String?`; `SequenceRunner.cont(cwd: String, operation: MergeState.Operation, message: String?) -> GitResult`.

- [ ] **Step 1: Write the failing test**

Create `spike/seam1/Tests/SequenceIntegrationTests.swift`:

```swift
import XCTest
@testable import Shepherd

/// The sequence seam against real git.
///
/// This test is the only thing that can prove the `GIT_EDITOR` handling works, because the
/// failure mode is a **hang** — a `Process` with no tty waiting on an editor nobody can see.
/// No unit test and no green build can see that. Every assertion here also depends on what
/// files git actually writes, which is knowledge only git has.
final class SequenceIntegrationTests: XCTestCase {

    private var repo: String!

    override func setUpWithError() throws {
        try super.setUpWithError()
        repo = NSTemporaryDirectory() + "shepherd-w5a-seq-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: repo, withIntermediateDirectories: true)
        git("init", "-b", "main")
        git("config", "user.email", "test@example.com")
        git("config", "user.name", "Test")
        git("config", "rerere.enabled", "false")
    }

    override func tearDownWithError() throws {
        if let repo { try? FileManager.default.removeItem(atPath: repo) }
        try super.tearDownWithError()
    }

    @discardableResult
    private func git(_ args: String...) -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["-C", repo] + args
        let out = Pipe(), err = Pipe()
        process.standardOutput = out
        process.standardError = err
        // A rebase that stops for an editor would hang the test suite, so this harness
        // never lets git open one.
        var environment = ProcessInfo.processInfo.environment
        environment["GIT_EDITOR"] = "true"
        process.environment = environment
        try? process.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        _ = err.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(data: data, encoding: .utf8) ?? ""
    }

    private func write(_ path: String, _ contents: String) {
        try? contents.write(toFile: (repo as NSString).appendingPathComponent(path),
                            atomically: true, encoding: .utf8)
    }

    private func unmergedCount() -> Int {
        git("ls-files", "-u").split(separator: "\n").filter { !$0.isEmpty }.count
    }

    /// Two commits on a branch, both of which conflict when replayed onto main.
    private func startTwoConflictRebase() {
        write("f.txt", "base\n")
        git("add", "-A"); git("commit", "-m", "base")
        git("checkout", "-b", "feature")
        write("f.txt", "feature one\n")
        git("commit", "-am", "feat: first")
        write("f.txt", "feature two\n")
        git("commit", "-am", "feat: second")
        git("checkout", "main")
        write("f.txt", "main change\n")
        git("commit", "-am", "main")
        git("checkout", "feature")
        git("rebase", "main")
    }

    func testRebaseStopsAndIsDetected() {
        startTwoConflictRebase()
        let state = ConflictReader.read(cwd: repo).state
        XCTAssertEqual(state.operation, .rebase)
        XCTAssertEqual(state.progress?.total, 2)
        XCTAssertGreaterThan(unmergedCount(), 0)
    }

    func testPendingMessageIsReadableAndStripped() {
        startTwoConflictRebase()
        let raw = SequenceRunner.pendingMessage(cwd: repo, operation: .rebase)
        XCTAssertNotNil(raw)
        XCTAssertEqual(SequencePolicy.displayMessage(raw ?? ""), "feat: first")
    }

    /// The whole loop: resolve, continue, hit the second conflict, resolve, continue, done.
    /// If `GIT_EDITOR` is mishandled this test hangs rather than failing.
    func testResolveContinueLoopFinishesTheRebase() {
        startTwoConflictRebase()

        write("f.txt", "resolved one\n")
        git("add", "f.txt")
        XCTAssertTrue(SequenceRunner.cont(cwd: repo, operation: .rebase, message: nil).isOK)

        // The second commit conflicts too, so we are stopped again — 2 of 2 this time.
        XCTAssertGreaterThan(unmergedCount(), 0)
        let mid = ConflictReader.read(cwd: repo).state
        XCTAssertEqual(mid.operation, .rebase)
        XCTAssertEqual(mid.progress?.done, 2)

        write("f.txt", "resolved two\n")
        git("add", "f.txt")
        XCTAssertTrue(SequenceRunner.cont(cwd: repo, operation: .rebase, message: nil).isOK)

        // Finished: no operation, nothing unmerged.
        XCTAssertEqual(ConflictReader.read(cwd: repo).state.operation, .none)
        XCTAssertEqual(unmergedCount(), 0)
    }

    /// Keep-as-is must not disturb the message.
    func testContinueWithoutARewordKeepsTheOriginalSubject() {
        startTwoConflictRebase()
        write("f.txt", "resolved\n")
        git("add", "f.txt")
        XCTAssertTrue(SequenceRunner.cont(cwd: repo, operation: .rebase, message: nil).isOK)
        XCTAssertTrue(git("log", "--format=%s").contains("feat: first"))
    }

    /// The reword path, which is why `GIT_EDITOR=true` alone was not good enough.
    func testContinueWithARewordRewritesTheSubject() {
        startTwoConflictRebase()
        write("f.txt", "resolved\n")
        git("add", "f.txt")
        let result = SequenceRunner.cont(cwd: repo, operation: .rebase,
                                         message: "reworded: chosen in the workbench")
        XCTAssertTrue(result.isOK, result.errorText ?? "")
        XCTAssertTrue(git("log", "--format=%s").contains("reworded: chosen in the workbench"))
        XCTAssertFalse(git("log", "--format=%s").contains("feat: first"))
    }

    /// `--continue` with an unstaged conflict must surface git's own words, not hang or
    /// silently succeed.
    func testContinueWithUnstagedConflictFailsWithAReason() {
        startTwoConflictRebase()
        // Resolve the text but never `git add` it.
        write("f.txt", "resolved but unstaged\n")
        let result = SequenceRunner.cont(cwd: repo, operation: .rebase, message: nil)
        XCTAssertFalse(result.isOK)
        XCTAssertNotNil(result.errorText)
    }

    func testMergeContinueCommitsTheMerge() {
        write("f.txt", "base\n")
        git("add", "-A"); git("commit", "-m", "base")
        git("checkout", "-b", "side")
        write("f.txt", "side\n")
        git("commit", "-am", "side")
        git("checkout", "main")
        write("f.txt", "main\n")
        git("commit", "-am", "main")
        git("merge", "side")
        XCTAssertGreaterThan(unmergedCount(), 0)

        write("f.txt", "resolved\n")
        git("add", "f.txt")
        XCTAssertTrue(SequenceRunner.cont(cwd: repo, operation: .merge, message: nil).isOK)
        XCTAssertEqual(ConflictReader.read(cwd: repo).state.operation, .none)
        XCTAssertEqual(unmergedCount(), 0)
    }

    func testCherryPickContinue() {
        write("f.txt", "base\n")
        git("add", "-A"); git("commit", "-m", "base")
        git("checkout", "-b", "side")
        write("f.txt", "side\n")
        git("commit", "-am", "pick me")
        git("checkout", "main")
        write("f.txt", "main\n")
        git("commit", "-am", "main")
        git("cherry-pick", "side")
        XCTAssertGreaterThan(unmergedCount(), 0)

        write("f.txt", "resolved\n")
        git("add", "f.txt")
        XCTAssertTrue(SequenceRunner.cont(cwd: repo, operation: .cherryPick, message: nil).isOK)
        XCTAssertEqual(ConflictReader.read(cwd: repo).state.operation, .none)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test \
  -only-testing:ShepherdModelTests/SequenceIntegrationTests 2>&1 | tail -20
```
Expected: FAIL — `cannot find 'SequenceRunner' in scope`.

- [ ] **Step 3: Give `GitStaging.run` an environment**

In `spike/seam1/Sources/Workbench/GitStaging.swift`, change the signature at line 128 and add
the environment merge right after `p.arguments`:

```swift
    static func run(_ args: [String], cwd: String, stdin: String? = nil,
                    env: [String: String]? = nil) -> GitResult {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["-C", cwd] + args
        if let env {
            // Merged into the inherited environment, never replacing it: git needs HOME to
            // find its config and PATH to find its helpers, and a bare dictionary would
            // silently change what git *is* while we were only trying to set an editor.
            p.environment = ProcessInfo.processInfo.environment.merging(env) { _, new in new }
        }
```

Leave the rest of the function untouched.

- [ ] **Step 4: Write `SequenceRunner`**

Create `spike/seam1/Sources/Workbench/SequenceRunner.swift`:

```swift
import Foundation

/// Runs `<verb> --continue`, and reads the message git is about to commit.
///
/// The hazard this exists to handle: `--continue` opens `$GIT_EDITOR` for the commit
/// message, and a `Process` spawned from an app bundle has no tty — so left alone it hangs
/// forever holding the session's `writing` flag, which is an unkillable spinner.
enum SequenceRunner {

    /// The message git parked for the stopped commit, raw (comments included), or nil when
    /// there is no pending commit at all — a rebase stopped on `break`, for instance.
    static func pendingMessage(cwd: String, operation: MergeState.Operation) -> String? {
        guard let name = SequencePolicy.messageFileName(operation),
              case .ok(let resolved) = GitStaging.run(["rev-parse", "--git-path", name],
                                                      cwd: cwd) else { return nil }
        let relative = resolved.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !relative.isEmpty else { return nil }
        let path = relative.hasPrefix("/")
            ? relative
            : (cwd as NSString).appendingPathComponent(relative)
        guard let contents = try? String(contentsOfFile: path, encoding: .utf8),
              !contents.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return contents
    }

    /// Continue the operation. `message` nil keeps git's own message verbatim.
    static func cont(cwd: String, operation: MergeState.Operation,
                     message: String?) -> GitResult {
        guard let args = SequencePolicy.continueArguments(operation) else {
            return .failed("nothing in progress")
        }
        guard let message, !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            // Accept the message as-is. `true` exits 0 having written nothing, which git
            // reads as "the user saved it unchanged".
            return GitStaging.run(args, cwd: cwd, env: ["GIT_EDITOR": "true"])
        }

        // Reword. `GIT_EDITOR` is a *command string* git appends the file path to, so
        // `cp <ours>` becomes `cp <ours> <git's message file>` — a substitution that needs
        // no tty and does not depend on which file git chose to park the message in.
        let temp = FileManager.default.temporaryDirectory
            .appendingPathComponent("shepherd-msg-\(UUID().uuidString).txt")
        do {
            try (message + "\n").write(to: temp, atomically: true, encoding: .utf8)
        } catch {
            return .failed("Could not stage the commit message: \(error.localizedDescription)")
        }
        defer { try? FileManager.default.removeItem(at: temp) }
        // Quoted because git runs the string through a shell.
        return GitStaging.run(args, cwd: cwd,
                              env: ["GIT_EDITOR": "cp '\(temp.path)'"])
    }
}
```

- [ ] **Step 5: Regenerate and run**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && xcodegen generate
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test \
  -only-testing:ShepherdModelTests/SequenceIntegrationTests 2>&1 | tail -25
```
Expected: PASS, 8 tests. **If the run hangs instead of failing, the `GIT_EDITOR` handling is
wrong** — that is the failure mode this test exists for. Kill it and check the env is being
merged rather than replaced.

- [ ] **Step 6: Commit**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd && \
git add spike/seam1/Sources/Workbench/GitStaging.swift \
        spike/seam1/Sources/Workbench/SequenceRunner.swift \
        spike/seam1/Tests/SequenceIntegrationTests.swift && \
git commit -m "$(cat <<'EOF'
feat(workbench): continue a stopped rebase, cherry-pick or merge

`--continue` opens $GIT_EDITOR and an app-spawned Process has no tty, so left
alone it hangs forever holding `writing`. Keep-as-is passes GIT_EDITOR=true;
rewording passes GIT_EDITOR="cp <file>", since git appends the message path to
that string — a substitution needing no tty and no knowledge of which file git
parked the message in.

The env is merged into the inherited one, never replacing it: git needs HOME for
its config.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Widen the lock, and the sequence panel

**Files:**
- Modify: `spike/seam1/Sources/Workbench/WorkbenchSession.swift:25` (`setScope` guard), `:88` (`resolveOnly`), plus `continueOperation`
- Modify: `spike/seam1/Sources/Workbench/WorkbenchView.swift:69-71` (scope forcing), `:739-770` (footer)

**Interfaces:**
- Consumes: `SequencePolicy`, `SequenceRunner` (Tasks 10–11).
- Produces: on the session — `var isMidSequence: Bool`, `@Published var sequenceMessageDraft: String`, `@Published private(set) var pendingSequenceMessage: String?`, `func loadPendingMessage()`, `func continueOperation()`.

- [ ] **Step 1: Widen the lock**

In `WorkbenchSession`, add beside `hasConflicts`:

```swift
    /// Mid-merge, mid-rebase or mid-cherry-pick, whether or not anything is unmerged.
    ///
    /// The lock is this, not `hasConflicts`. Resolving the last file used to unlock the whole
    /// workbench **mid-rebase** — where HEAD is a detached replay state, so "vs base" is a
    /// comparison against nothing meaningful. A half-applied sequence is exactly as broken a
    /// tree as a conflicted one, and the only doors out are Continue and Abort.
    ///
    /// Failure mode, bounded on purpose: a stale `rebase-merge` directory locks the
    /// workbench with nothing to resolve. Abort is always enabled, and this is re-derived
    /// from git's own files on every load — so it clears the instant git's state does.
    var isMidSequence: Bool { hasConflicts || mergeState.isActive }
```

Change the `setScope` guard (line 25) from `!hasConflicts` to:

```swift
        guard !isMidSequence || next == .files else { return }
```

Change `resolveOnly` (line 88) to:

```swift
    var resolveOnly: Bool { isMidSequence }
```

In `WorkbenchView.swift` (lines 69–71), widen the scope forcing:

```swift
        .onChange(of: session.isMidSequence) { midSequence in
            if midSequence, session.scope != .files { session.setScope(.files) }
        }
```

- [ ] **Step 2: Add the message state and the action**

In `WorkbenchSession`:

```swift
    /// The message git will commit when the sequence continues, comments stripped. Nil when
    /// there is no pending commit — a rebase stopped on `break` shows no field rather than
    /// an empty box implying one.
    @Published private(set) var pendingSequenceMessage: String?
    /// The editable copy. Equal to `pendingSequenceMessage` means "keep it verbatim".
    @Published var sequenceMessageDraft = ""

    func loadPendingMessage() {
        guard mergeState.isActive else {
            pendingSequenceMessage = nil
            sequenceMessageDraft = ""
            return
        }
        let cwd = self.cwd
        let operation = mergeState.operation
        DispatchQueue.global(qos: .userInitiated).async {
            let raw = SequenceRunner.pendingMessage(cwd: cwd, operation: operation)
            let shown = raw.map(SequencePolicy.displayMessage)
            DispatchQueue.main.async {
                self.pendingSequenceMessage = shown
                self.sequenceMessageDraft = shown ?? ""
            }
        }
    }

    /// Finish the current step of the operation.
    ///
    /// Then just `loadConflicts()`. If the next commit conflicts, `mergeFiles` fills, the
    /// lock re-engages and the progress counter advances on its own; if the sequence
    /// finished, `MergeState.idle` clears the banner and a full `load()` runs because the
    /// tree changed under every row on screen. **No sequence state of ours is cached** —
    /// `ConflictReader.readState` re-reads git's files each time, so our position cannot
    /// drift from git's.
    func continueOperation() {
        guard SequencePolicy.canContinue(isActive: mergeState.isActive,
                                         unresolved: totalUnresolved,
                                         writing: writing) else { return }
        let cwd = self.cwd
        let operation = mergeState.operation
        // Unchanged draft ⇒ keep git's message verbatim.
        let reword = sequenceMessageDraft != (pendingSequenceMessage ?? "")
            ? sequenceMessageDraft : nil
        lastError = nil
        writing = true
        invalidateBlame()
        DispatchQueue.global(qos: .userInitiated).async {
            let result = SequenceRunner.cont(cwd: cwd, operation: operation, message: reword)
            DispatchQueue.main.async {
                self.writing = false
                self.lastError = result.errorText
                self.resolutions.removeAll()
                self.pendingSequenceMessage = nil
                self.sequenceMessageDraft = ""
                self.loadConflicts()
                if !self.mergeState.isActive { self.load() }
            }
        }
    }
```

Call `loadPendingMessage()` at the end of `loadConflicts()`'s main-thread block, after
`mergeState` is assigned.

Note `writing` is `private(set)` — set it from inside the session as the existing
`abortOperation` does.

- [ ] **Step 3: Render the sequence panel**

In `WorkbenchView.swift`'s footer, where `mergeState.summary` and the abort row already
render (~lines 739–770), replace the commit box with the sequence panel while a sequence is
active — mid-sequence a plain `git commit` would create a stray commit:

```swift
    @ViewBuilder
    private var sequencePanel: some View {
        if let summary = session.mergeState.summary {
            VStack(alignment: .leading, spacing: 6) {
                Text(summary).font(.system(size: 11, weight: .medium))
                if session.pendingSequenceMessage != nil {
                    TextEditor(text: $session.sequenceMessageDraft)
                        .font(.system(size: 11, design: .monospaced))
                        .frame(height: 54)
                    Text("edit to reword this commit")
                        .font(.system(size: 9))
                        .foregroundColor(Color(hex: Theme.Diff.gutterFg))
                }
                HStack(spacing: 6) {
                    let reason = SequencePolicy.blockedReason(
                        isActive: session.mergeState.isActive,
                        unresolved: session.totalUnresolved,
                        writing: session.writing)
                    Button("Continue") { session.continueOperation() }
                        .disabled(reason != nil)
                        .help(reason ?? "Finish this step and move on")
                        .focusable(false)
                    if let reason {
                        Text(reason)
                            .font(.system(size: 9))
                            .foregroundColor(Color(hex: Theme.Diff.gutterFg))
                    }
                    Spacer()
                    Button("Abort") { session.abortOperation() }
                        .disabled(session.writing)
                        .focusable(false)
                }
            }
            .padding(8)
        }
    }
```

Use `TextEditor(text:)` only if that is how the existing commit box binds; otherwise mirror
the existing commit-box construction exactly, changing only the binding to
`$session.sequenceMessageDraft`. Keep all sidebar/footer controls `.focusable(false)` so
focus stays on the terminal.

Then branch the footer: `if session.mergeState.isActive { sequencePanel } else { commitBox }`.

- [ ] **Step 4: Build and run the full suite**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test 2>&1 | tail -30
```
Expected: `BUILD SUCCEEDED`, suite green. Note the test count — it should be the original
count plus roughly 54 new tests across Tasks 1–11.

- [ ] **Step 5: Commit**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd && \
git add spike/seam1/Sources/Workbench/WorkbenchSession.swift \
        spike/seam1/Sources/Workbench/WorkbenchView.swift && \
git commit -m "$(cat <<'EOF'
feat(workbench): the lock covers the whole sequence, not just its conflicts

Resolving the last conflict used to unlock the workbench mid-rebase, where HEAD
is a detached replay and "vs base" compares against nothing meaningful. The gate
is now hasConflicts || mergeState.isActive, so the only doors out of a
half-applied sequence are Continue and Abort.

The footer becomes the sequence panel while one is active: summary, the pending
message when there is one, Continue disabled with a reason, Abort. A plain commit
there would create a stray commit.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Docs, and the human gate before merge

**Files:**
- Modify: `docs/superpowers/plans/2026-07-26-unified-workbench-w1-w5-roadmap.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the roadmap**

In the progress block, change the W5 line to two lines and recompute the overall bar:

```
W5a history & commits      ██████████████████████  100%   commits, blame, sequence seam
W5b power tools            ░░░░░░░░░░░░░░░░░░░░░░    0%   stash, cherry-pick, rebase -i
```

Replace the "## W5 — History & power tools (last; blocks nothing)" section with a **W5a as
built** section recording: that there is no graph renderer and why; that the commit document
reuses W3's not-on-disk provenance; the three provenance points with the `fileLines` one
called out as the easy miss; the verified git facts table from this plan's header; and a
pointer to the W5a spec. Then a short **W5b remains** section listing stash, cherry-pick and
interactive rebase, noting that `GIT_SEQUENCE_EDITOR` will need the same treatment
`GIT_EDITOR` got here.

- [ ] **Step 2: Add the gotchas to `CLAUDE.md`**

In the workbench section, describe the Commits scope, the blame lane and the sequence panel in
the existing voice. Add these to the "Critical gotchas" list:

- **`git show -M --format=` on a merge commit prints nothing.** It defaults to a combined
  `@@@` diff and suppresses it at default verbosity, so a commit view without
  `-m --first-parent` renders blank with no error. `DiffReader.readCommit` passes both;
  `CommitDiffIntegrationTests` pins it.
- **A document's provenance is one decision, in `DocumentProvenance`.** Colours, the text of
  rows the diff does not carry, and editability all follow from `selectedCommit`. The
  `fileLines` lookup in `rebuild()` is the easy miss: it is the only path for gap-revealed
  and edited rows, and reading the working copy there splices today's lines into a three-week
  old commit.
- **`--continue` wants an editor and an app-spawned `Process` has no tty**, so it hangs
  rather than failing. `SequenceRunner` passes `GIT_EDITOR=true` to keep the message and
  `GIT_EDITOR="cp '<file>'"` to reword. `GitStaging.run(env:)` **merges** into the inherited
  environment — replacing it loses `HOME` and so git's config.
- **The workbench lock is `isMidSequence`, not `hasConflicts`.** A half-applied rebase gates
  every scope until Continue or Abort.

- [ ] **Step 3: Commit the docs**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd && \
git add CLAUDE.md docs/superpowers/plans/2026-07-26-unified-workbench-w1-w5-roadmap.md && \
git commit -m "$(cat <<'EOF'
docs(workbench): W5a as built; W5b is what remains

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Run it in ShepherdDev — this is a required gate, not a formality**

Nine defects in the last session were found by a person pressing something: the crash, the
overlay never drawing, bands vanishing on resolve, dead click targets. **None of them were
visible to `xcodebuild` or to 545 green tests.** Workbench UI does not merge on green tests
plus a clean build.

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd && scripts/dev.sh
```

**Never `killall Shepherd`** — that is the user's daily terminal. `killall ShepherdDev` is
the dev app only.

Check, in `ShepherdDev`, on this repo:

1. `⌃4` → the commit list renders with subjects and ages; the segment is absent in a
   directory that is not a repo.
2. Drill into a commit older than a week and confirm the syntax colours are **that commit's**
   text — pick a file that has changed a lot since. Then **expand a hunk gap inside it** and
   confirm the revealed lines belong to the old commit, not to today's file. This is where
   wrong provenance shows, and it is the single most important check here.
3. Confirm the commit view refuses typing and the header says why; confirm no stage buttons.
4. Breadcrumb back to the list, then `⌃2` out — no stale historical rows should remain.
5. Focus a single file and confirm the blame lane appears, tracks the text **under hard
   scrolling** (this is the geometry check), and that the header annotation follows the
   cursor, is overridden by hover, and restores on exit.
6. Click a lane cell for a commit on this branch → it drills in. Click one that predates the
   branch → an explanatory error, not a blank list.
7. In `~/Home/dev/tools/shepherd-w3-fixture` (already mid-conflict — delete it whenever), or
   a fresh throwaway clone, start a two-commit conflicting rebase and drive the whole loop
   from the workbench: resolve → Continue → resolve → Continue → done. Do it once keeping
   the message and once rewording. Confirm the counter moves and that no scope is reachable
   while the sequence is stopped.

- [ ] **Step 5: Hand the branch over**

Report what was checked and what was found. Per the project's ship workflow, merging to local
`master`, rebuilding, resigning and pushing happen **only when the user asks**.

---

## Self-review

**Spec coverage.** § 1 commits scope → Tasks 1, 2, 4, 5; the two provenance points and the
blob cache → Tasks 3, 4; read-only with a visible reason → Tasks 3, 5. § 2 blame reading →
Task 6; lane runs and shades → Task 7; gutter draw, width, theme tokens, per-file laziness →
Task 8; the header annotation, hover and lane click → Task 9. § 3 pure policy → Task 10;
`--continue`, both message paths, the env merge, the real-git loop → Task 11; the widened
lock and the panel → Task 12. New-units table → Tasks 1, 3, 4, 6, 7, 10, 11. Testing section
→ the per-task cycles plus Tasks 2 and 11's integration tests. The human gate → Task 13.

Deliberately **not** implemented, matching the spec's deferred list: blame inside a commit
view, blame on deletion bands, full-history exploration, adopting `BlobCache` in the
deletion-band path, and all of W5b.

**Type consistency.** `selectedCommit` / `historicalSha` are the only provenance state and are
used consistently from Task 4 onward. `DocumentProvenance.variant(hasMergePreview:commitSha:)`,
`.lineSource(commitSha:)`, `.isEditable(commitSha:)`, `.readOnlyReason(commitSha:)` keep the
same labels everywhere. `BlameResult.shaByLine` / `.meta`, `BlameRow.sha/.shade/.isRunStart`,
`BlameLane.rows(lineNumbers:blame:now:)` and `.shade(commitTime:now:)` match between Tasks 6,
7, 8 and 9. `SequencePolicy.canContinue(isActive:unresolved:writing:)` and
`.blockedReason(isActive:unresolved:writing:)` take the same three labels in Tasks 10 and 12.
`SequenceRunner.cont(cwd:operation:message:)` is spelled the same in Tasks 11 and 12.
`GitStaging.run(_:cwd:stdin:env:)` adds `env` last with a default, so no existing call site
changes.

**Two places where the plan is deliberately instructional rather than literal**, because the
exact surrounding code must be read first: the rail's file-section extraction in Task 5, and
the gutter's x-offset shift in Task 8 (every `Self.leadingPad + …` becomes
`Self.leadingPad + laneOffset + …`). Both name the precise transformation and the invariant to
preserve.
