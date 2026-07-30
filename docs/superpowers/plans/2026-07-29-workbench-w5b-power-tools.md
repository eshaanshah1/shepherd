# Workbench W5b (Power Tools) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the workbench — a Rewrite mode that turns the Commits list into an interactive-rebase todo, cherry-picking from another branch or worktree, stashes as first-class previewable entries, and an escape from the locked-with-no-exit state a conflicted stash apply produces today.

**Architecture:** Every verb here ends where W5a already ends — an operation that either completes or stops with conflicts, handled by `SequenceRunner.cont` / `SequencePolicy.outcome` / the `isMidSequence` lock / `loadConflicts()`. So this adds *starters* for that machine plus one state it cannot express (`hasConflicts && !mergeState.isActive`). Three measured git facts keep it small: a stash is a 3-parent merge commit so `DiffReader.readCommit` reads one unchanged; `GIT_SEQUENCE_EDITOR` takes the same `cp '<file>'` substitution `GIT_EDITOR` does; and a todo of bare `pick <sha>` lines rebases correctly, so we never parse git's todo format, only write one.

**Tech Stack:** Swift 5, SwiftUI + AppKit, xcodegen, vendored CodeEditTextView/CodeEditSourceEditor, XCTest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-29-workbench-w5b-power-tools-design.md`. Every task's requirements implicitly include it.
- Deployment target macOS 13.0; `SWIFT_VERSION: "5.0"`.
- **Run `xcodegen generate` after adding or removing ANY source file.** Otherwise the file is not compiled and you get `cannot find X in scope` at *build* time, not edit time.
- **Every new pure model must be added to `ShepherdModelTests`' explicit `sources:` list in `project.yml`.** Files under `Tests/` are picked up by the `- path: Tests` glob; compiled sources are not.
- **`-only-testing:` on a suite the project does not know about reports `** TEST SUCCEEDED **`** — it matches nothing and passes vacuously. Run `xcodegen generate` before the first run of any new test file, and treat a pass as real only once the test count moves: `grep -c "Test Case .* passed"`.
- **This shell resets cwd between calls.** Always `cd` with an absolute path inside each command. A compound `xcodegen && xcodebuild` without it silently tests a *stale* project.
- **SourceKit lies in this repo.** "Cannot find type" from the editor is stale noise; `xcodebuild` is ground truth.
- Pure models contain **no AppKit import**. That is what makes them testable.
- **Never run `killall Shepherd`** — the user runs Shepherd as their daily terminal. Verify by compile + unit tests; hand runtime checks to the user via `scripts/dev.sh`. (`killall ShepherdDev` is fine — that is the dev app.)
- BSD `sed` has no `\b`; use `[[:<:]]` / `[[:>:]]`. BSD `cat` has no `-A`; use `sed -n l` or `od -c`.
- Commit messages end with: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- Build command (used by every task):
  ```bash
  cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
    xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
    -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
    CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | grep -E "error:|BUILD" | head -20
  ```
- Test command:
  ```bash
  cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
    xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
    -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
    CLANG_MODULE_CACHE_PATH=./build/ModuleCache test 2>&1 | tail -30
  ```
- Single-test filter: append `-only-testing:ShepherdModelTests/<ClassName>` (optionally `/<testName>`) to the test command.
- **On a cold build, run the build command before the test command.** `ShepherdModelTests` does `@testable import Shepherd` but declares no dependency on the `Shepherd` target, so with empty derived data the test target races the app module and fails with `Unable to resolve module dependency: 'Shepherd'` — which looks like a broken checkout and is not one. Measured in a fresh worktree: `build` then `test` succeeds. (Adding `- target: Shepherd` to that target's `dependencies:` would fix it properly; left alone here because `project.yml` is contested by other in-flight work.)
- **Baseline for this plan: 708 tests passing**, measured in a fresh worktree at `f438b3c`. Each task's expected count is that number plus everything added since.
- Fixtures for the live run already exist and are re-creatable: `~/Home/dev/tools/shepherd-w5b-fixture/setup.sh` builds `history/` (4 backdated commits, a hunk gap whose interior was rewritten) and `rebase/` (stopped at rebase 1/2).

## Verified git behaviour (probed against git 2.55 — do not re-derive)

Every row was measured. Two of them changed the design and one found a live defect.

| Fact | Consequence |
|---|---|
| **A stash is a 3-parent merge commit**; `git show -M -m --first-parent --format= stash@{0}` yields its tracked changes vs HEAD-at-stash-time | `DiffReader.readCommit` reads a stash **unchanged** — no new document type, variant or provenance case |
| Files stashed with `-u` live in the stash's **third parent** and appear **nowhere** in the first-parent diff | untracked-in-stash paths come from `git ls-tree stash@{n}^3` and are listed, not previewed |
| `git stash list --format='…%x00…'` honours `%x00`/`%x1e` escapes and emits real NUL/RS bytes | `StashList` uses the escapes, never literal NULs — see the crash note below |
| **`GIT_SEQUENCE_EDITOR` is a command string with the todo path appended**, so `cp '<file>'` substitutes a todo. Verified with a path containing a space | the todo writer is a temp file plus a `cp`; no shell script, no tty, no hang |
| A todo of bare **`pick <sha>`** lines — no subject at all — rebases correctly. git 2.55 itself writes `pick <shortsha> # <subject>` (confirmed with global *and* system config neutralised) | **we never parse git's todo, only write one.** The subject is decoration; identity is the sha |
| Reorder, `reword` (with `GIT_EDITOR`), `drop` and `squash` all apply via `GIT_SEQUENCE_EDITOR` with **no tty**, exit 0 | Apply needs no terminal |
| An **empty todo** gives `error: nothing to do` and unwinds cleanly — not a half-applied state | the empty plan needs a UI refusal for clarity, not a safety guard |
| A **cherry-pick sequence** writes `CHERRY_PICK_HEAD` + `sequencer/todo` + `MERGE_MSG`, has **no `msgnum`/`end`**, and keeps **no record of the original total** (the todo shrinks in place; the dir holds only `todo`, `head`, `abort-safety`) | progress is `N remaining`, never `N of M`. Inventing M would be cached sequence state |
| **A conflicted `git stash pop` leaves 3 unmerged stages and NO operation**: no `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `rebase-merge`, `rebase-apply`, `sequencer` or `MERGE_MSG`. The stash entry survives. `git stash apply --continue` does not exist | the `.loose` state — Task 1. Today this locks the workbench with a Continue that says "nothing in progress" and an Abort that returns silently |
| `git checkout HEAD -- <path>` clears **all three** unmerged stages for that path and leaves an unrelated modified file untouched | the discard escape is per-path `checkout HEAD --`, never `reset --hard` |
| git 2.55 runs even a **plain** `git rebase` through the merge backend — `rebase-merge/git-rebase-todo` and an `interactive` marker both exist, with `msgnum`/`end` | a stopped `rebase -i` is structurally identical to what W5a already handles |

### The crash trap, restated because it applies again here

`CommitHistory` documents this and `StashList` must obey it: **passing `%x00` in a shell is not the same as writing `"\u{0}"` in Swift.** `Process` turns every argument into a C string, a Swift string holding a NUL has none, and `run()` throws `NSInvalidArgumentException` — an **ObjC** exception `try`/`catch` cannot see, so the app dies. Use the four-character escape `%x00` in the argument and split on the real `"\u{0}"` in the output.

## File structure

| File | Responsibility |
|---|---|
| `Sources/Workbench/SequencePolicy.swift` (modify) | `ConflictContext`; the loose headline / explanation / discard confirmation |
| `Sources/Workbench/ConflictReader.swift` (modify) | `MergeProgress` becomes two shapes; cherry-pick `remaining` from `sequencer/todo` |
| `Sources/Workbench/GitStaging.swift` (modify) | `restoreFiles(_:cwd:)` — the per-path discard |
| `Sources/Workbench/StashList.swift` (new, **pure**) | `Stash`; `git stash list` argument builder + NUL-delimited parse; the untracked-parent argument builder |
| `Sources/Workbench/StashRunner.swift` (new) | `push` / `apply` / `pop` / `drop` / untracked-path read |
| `Sources/Workbench/RefList.swift` (new, **pure**) | `Ref`; `for-each-ref` argument builder + parse, worktree marking, current-branch exclusion |
| `Sources/Workbench/CommitHistory.swift` (modify) | `logArguments(range:)` generalized; `logArguments(base:)` becomes one caller |
| `Sources/Workbench/RebasePlan.swift` (new, **pure**) | `RebaseVerb`, `PlanRow`; rows → todo text (**reversed**); validity + the reason for each refusal |
| `Sources/Workbench/RebaseRunner.swift` (new) | temp todo, `GIT_SEQUENCE_EDITOR`, the `rebase -i` spawn |
| `Sources/Workbench/CherryPickRunner.swift` (new) | ref + range reads, the `cherry-pick` spawn |
| `Sources/Workbench/WorkbenchSession.swift` (modify) | `conflictContext`, `discardLooseConflicts`, stash state + actions, ref/source-commit state, plan state + apply |
| `Sources/Workbench/WorkbenchView.swift` (modify) | the loose-conflict panel, the STASHES section, the Stash button, the ref picker, Rewrite mode |
| `Tests/*` (new) | `ConflictContextTests`, `StashListTests`, `RefListTests`, `RebasePlanTests`, `StashIntegrationTests`, `CherryPickIntegrationTests`, `RebasePlanIntegrationTests` |

Task order is the spec's "Order of work": the live defect first, then ascending by size.

---

### Task 1: `ConflictContext` — the state with no representation

The mirror of what W5a called unrepresented. Pure, and first because everything later in this plan can produce conflicts.

**Files:**
- Modify: `spike/seam1/Sources/Workbench/SequencePolicy.swift`
- Create: `spike/seam1/Tests/ConflictContextTests.swift`

**Interfaces:**
- Consumes: `MergeState.Operation` (existing, in `ConflictReader.swift`).
- Produces: `enum ConflictContext: Equatable { case clean, sequence(MergeState.Operation), loose }`; `SequencePolicy.context(operation:hasConflicts:) -> ConflictContext`; `SequencePolicy.looseHeadline(unresolved:) -> String`; `SequencePolicy.looseExplanation: String`; `SequencePolicy.discardConfirmation(paths:stashTop:) -> String`.

- [ ] **Step 1: Write the failing test**

Create `spike/seam1/Tests/ConflictContextTests.swift`:

```swift
import XCTest
@testable import Shepherd

/// Unmerged files with **no operation in progress**.
///
/// W5a named `isActive && !hasConflicts` the state with no representation. This is its
/// mirror, and it is worse: measured against git 2.55, a conflicted `git stash pop` leaves
/// three unmerged stages and no `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `rebase-merge`,
/// `rebase-apply`, `sequencer` or `MERGE_MSG` at all. Run that through the shipped code and
/// the workbench locks to Files, offers a Continue whose reason reads "nothing in progress",
/// and an Abort that hits `guard mergeState.isActive` and returns silently.
final class ConflictContextTests: XCTestCase {

    // MARK: classification

    func testNothingHappeningIsClean() {
        XCTAssertEqual(SequencePolicy.context(operation: .none, hasConflicts: false), .clean)
    }

    func testAnActiveOperationIsASequence() {
        XCTAssertEqual(SequencePolicy.context(operation: .rebase, hasConflicts: true),
                       .sequence(.rebase))
        XCTAssertEqual(SequencePolicy.context(operation: .cherryPick, hasConflicts: false),
                       .sequence(.cherryPick))
        XCTAssertEqual(SequencePolicy.context(operation: .merge, hasConflicts: true),
                       .sequence(.merge))
    }

    /// The whole point of the type.
    func testConflictsWithNoOperationAreLoose() {
        XCTAssertEqual(SequencePolicy.context(operation: .none, hasConflicts: true), .loose)
    }

    /// An active operation wins. A stash applied on top of a stopped rebase is still a
    /// rebase as far as the way *out* is concerned.
    func testSequenceWinsOverLoose() {
        XCTAssertEqual(SequencePolicy.context(operation: .rebase, hasConflicts: true),
                       .sequence(.rebase))
    }

    // MARK: copy

    func testHeadlineSingularAndPlural() {
        XCTAssertEqual(SequencePolicy.looseHeadline(unresolved: 1),
                       "1 conflict · no operation in progress")
        XCTAssertEqual(SequencePolicy.looseHeadline(unresolved: 3),
                       "3 conflicts · no operation in progress")
    }

    /// It must say there is nothing to continue, because the lock says otherwise.
    func testExplanationSaysThereIsNothingToContinue() {
        XCTAssertTrue(SequencePolicy.looseExplanation.contains("nothing to continue"))
        XCTAssertTrue(SequencePolicy.looseExplanation.contains("working tree"))
    }

    // MARK: the discard confirmation

    func testDiscardNamesOneFile() {
        let text = SequencePolicy.discardConfirmation(paths: ["Sources/App.swift"],
                                                     stashTop: nil)
        XCTAssertTrue(text.contains("App.swift"))
        XCTAssertTrue(text.contains("HEAD"))
        // The promise that makes this an escape hatch rather than a second trap.
        XCTAssertTrue(text.contains("Other modified files are untouched."))
    }

    func testDiscardCountsSeveralFilesAndStillNamesThem() {
        let text = SequencePolicy.discardConfirmation(paths: ["a/one.swift", "b/two.swift"],
                                                     stashTop: nil)
        XCTAssertTrue(text.contains("2 files"))
        XCTAssertTrue(text.contains("one.swift"))
        XCTAssertTrue(text.contains("two.swift"))
    }

    /// Information, never a claim. A conflicted pop does keep its entry, but nothing in git
    /// proves the top entry is the one that was applied — so this reports what exists and
    /// does not say it is your work.
    func testStashNoteIsInformationalAndOmittedWhenThereIsNone() {
        let with = SequencePolicy.discardConfirmation(paths: ["f.txt"],
                                                      stashTop: "stash@{0}: On main: wip")
        XCTAssertTrue(with.contains("stash@{0}: On main: wip"))
        XCTAssertFalse(with.lowercased().contains("your work is safe"))

        let without = SequencePolicy.discardConfirmation(paths: ["f.txt"], stashTop: nil)
        XCTAssertFalse(without.lowercased().contains("stash"))
    }

    func testNoPathsIsNoConfirmationText() {
        XCTAssertEqual(SequencePolicy.discardConfirmation(paths: [], stashTop: nil), "")
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && xcodegen generate
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test \
  -only-testing:ShepherdModelTests/ConflictContextTests 2>&1 | tail -20
```
Expected: FAIL — `cannot find 'ConflictContext' in scope`. (`xcodegen generate` runs first because a brand-new test file the project does not know about would report `** TEST SUCCEEDED **` having compiled nothing.)

- [ ] **Step 3: Write the implementation**

Append to `spike/seam1/Sources/Workbench/SequencePolicy.swift`, above `enum SequencePolicy`:

```swift
/// What kind of conflicted state the repo is in, and therefore what the way out is.
///
/// Derived from git's own files on every read, never cached — the rule
/// `ConflictReader.readState` sets, so our idea of where we are cannot drift from git's
/// after an abort in a terminal pane.
enum ConflictContext: Equatable {
    /// Nothing unmerged and nothing in flight.
    case clean
    /// git is part-way through something that can be continued or aborted.
    case sequence(MergeState.Operation)
    /// Unmerged files with **no operation**. A conflicted `git stash pop`,
    /// `git checkout -m`, or `git apply -3`. There is nothing to continue and nothing to
    /// abort, so the only way out is to resolve or to discard.
    case loose
}
```

Then add to `enum SequencePolicy`:

```swift
    /// Classify the conflicted state. An active operation wins: a stash applied on top of a
    /// stopped rebase is still a rebase as far as the way out is concerned.
    ///
    /// **`.loose` is inferred, not read.** git records nothing that distinguishes a
    /// conflicted stash apply from a conflicted `git checkout -m`, so this describes the
    /// shape of the state rather than naming its cause. Naming it would be a guess.
    static func context(operation: MergeState.Operation, hasConflicts: Bool) -> ConflictContext {
        if operation != .none { return .sequence(operation) }
        return hasConflicts ? .loose : .clean
    }

    /// Headline for `.loose`. Counts unresolved regions, matching `blockedReason`.
    static func looseHeadline(unresolved: Int) -> String {
        "\(unresolved) conflict\(unresolved == 1 ? "" : "s") · no operation in progress"
    }

    /// Why there is no Continue. It has to say so out loud: the workbench is locked, which
    /// implies a sequence, and a disabled Continue reading "nothing in progress" beside a
    /// lock is a contradiction the user has to resolve on our behalf.
    static let looseExplanation =
        "Resolve each file and the result stays in your working tree. "
        + "There is nothing to continue — no rebase, merge or cherry-pick is in flight."

    /// Exactly what Discard will do, named file by file.
    ///
    /// The action is per-path `git checkout HEAD --`, never `reset --hard`: the tree can hold
    /// unrelated modifications that were never at risk, and throwing those away would be a
    /// second trap rather than an escape from the first. Verified against git 2.55 — it
    /// clears all three unmerged stages and leaves an unrelated modified file alone.
    static func discardConfirmation(paths: [String], stashTop: String?) -> String {
        guard !paths.isEmpty else { return "" }
        let names = paths.map { ($0 as NSString).lastPathComponent }.joined(separator: ", ")
        var text = paths.count == 1
            ? "Restore \(names) to HEAD, throwing away this conflicted merge."
            : "Restore \(paths.count) files to HEAD, throwing away this conflicted merge: \(names)."
        text += " Other modified files are untouched."
        // Information, not reassurance: a conflicted pop keeps its entry, but nothing in git
        // proves the top entry is the one that was applied.
        if let stashTop, !stashTop.isEmpty {
            text += "\n\nThe stash list still holds \(stashTop)."
        }
        return text
    }
```

- [ ] **Step 4: Run the tests**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test \
  -only-testing:ShepherdModelTests/ConflictContextTests 2>&1 | \
  grep -E "Test Case .* passed|failed|TEST" | tail -20
```
Expected: 10 tests passed, and the full suite at **718** (708 + 10). **Confirm the count** — a vacuous pass shows no `Test Case … passed` lines at all.

- [ ] **Step 5: Commit**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd && \
git add spike/seam1/Sources/Workbench/SequencePolicy.swift \
        spike/seam1/Tests/ConflictContextTests.swift && \
git commit -m "$(cat <<'EOF'
feat(workbench): name the conflicted state with no operation

W5a called `isActive && !hasConflicts` the state with no representation. Its
mirror — unmerged files with NO operation, which a conflicted stash pop leaves
(measured: three stages, no MERGE_HEAD, no sequencer, nothing) — locks the
workbench to Files, offers a Continue whose reason reads "nothing in progress",
and an Abort that returns silently.

ConflictContext is derived from git's files every read, never cached, and is
deliberately unable to name a cause: git records nothing distinguishing a
conflicted stash apply from a conflicted `checkout -m`.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Wire `.loose` — the discard escape and its panel

**Files:**
- Modify: `spike/seam1/Sources/Workbench/GitStaging.swift` (add `restoreFiles`, beside `unstageFiles` ~line 39)
- (No `StashRunner` yet — the stash-top read for the confirmation lands in Task 4; until then the panel passes `stashTop: nil`.)
- Modify: `spike/seam1/Sources/Workbench/WorkbenchSession.swift` (`conflictContext`, `discardLooseConflicts`, `looseConflictPaths`)
- Modify: `spike/seam1/Sources/Workbench/WorkbenchView.swift` (the merge section ~lines 938–960, which today branches only on `hasConflicts` / `mergeState.isActive`)
- Create: `spike/seam1/Tests/StashIntegrationTests.swift` (the `.loose` half only; the rest arrives in Task 4)

**Interfaces:**
- Consumes: `SequencePolicy.context/looseHeadline/looseExplanation/discardConfirmation` (Task 1); `GitStaging.run` (existing).
- Produces: `GitStaging.restoreFiles(_ paths: [String], cwd: String) -> GitResult`; on `WorkbenchSession` — `var conflictContext: ConflictContext`, `var looseConflictPaths: [String]`, `func discardLooseConflicts()`.

- [ ] **Step 1: Write the failing integration test**

Create `spike/seam1/Tests/StashIntegrationTests.swift`. Real git, on the `ConflictIntegrationTests` pattern — no unit test can discover which files git writes.

```swift
import XCTest
@testable import Shepherd

/// Real-git behaviour around stashes, and the `.loose` state a conflicted pop produces.
///
/// The load-bearing case: a conflicted `git stash pop` leaves unmerged files and **no
/// operation at all**. Only real git can say that, and it is the difference between a
/// workbench with an exit and one without.
final class StashIntegrationTests: XCTestCase {

    private var repo: String!

    override func setUpWithError() throws {
        try super.setUpWithError()
        repo = NSTemporaryDirectory() + "shepherd-w5b-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: repo, withIntermediateDirectories: true)
        git("init", "-b", "main")
        git("config", "user.email", "test@example.com")
        git("config", "user.name", "Test")
        git("config", "commit.gpgsign", "false")
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

    private func read(_ path: String) -> String {
        (try? String(contentsOfFile: (repo as NSString).appendingPathComponent(path),
                     encoding: .utf8)) ?? ""
    }

    /// Leaves the repo with a conflicted stash pop in progress, plus one unrelated dirty
    /// file that was never at risk.
    private func conflictedPop() {
        write("f.txt", "a\nb\nc\n")
        write("other.txt", "unrelated original\n")
        git("add", "-A"); git("commit", "-m", "base")

        write("f.txt", "a\nSTASHED\nc\n")
        git("stash", "push", "-m", "wip | with a pipe")
        write("f.txt", "a\nHEAD-MOVED\nc\n")
        git("commit", "-am", "moves the same line")
        write("other.txt", "unrelated EDITED\n")
        git("stash", "pop")
    }

    func testConflictedPopLeavesUnmergedFilesAndNoOperation() {
        conflictedPop()
        let result = ConflictReader.read(cwd: repo)
        XCTAssertFalse(result.isEmpty, "the pop must leave something unmerged")
        XCTAssertEqual(result.state.operation, .none,
                       "a stash pop is not an operation git records")
        XCTAssertEqual(SequencePolicy.context(operation: result.state.operation,
                                             hasConflicts: !result.isEmpty),
                       .loose)
    }

    /// The stash survives a conflicted pop, so the discard is recoverable.
    func testTheStashEntrySurvivesAConflictedPop() {
        conflictedPop()
        XCTAssertTrue(git("stash", "list").contains("wip | with a pipe"))
    }

    /// The escape hatch: per-path, so unrelated work is untouched.
    func testDiscardRestoresOnlyTheConflictedPaths() {
        conflictedPop()
        let paths = ConflictReader.read(cwd: repo).files.map(\.path)
        XCTAssertEqual(paths, ["f.txt"])

        let outcome = GitStaging.restoreFiles(paths, cwd: repo)
        XCTAssertTrue(outcome.isOK, outcome.errorText ?? "")

        XCTAssertTrue(ConflictReader.read(cwd: repo).isEmpty,
                      "the unmerged stages must be gone")
        XCTAssertEqual(read("f.txt"), "a\nHEAD-MOVED\nc\n", "f.txt returns to HEAD")
        XCTAssertEqual(read("other.txt"), "unrelated EDITED\n",
                       "an unrelated dirty file must survive the discard")
    }

    func testRestoringNothingIsNotAnError() {
        conflictedPop()
        XCTAssertTrue(GitStaging.restoreFiles([], cwd: repo).isOK)
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && xcodegen generate
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test \
  -only-testing:ShepherdModelTests/StashIntegrationTests 2>&1 | tail -20
```
Expected: FAIL — `type 'GitStaging' has no member 'restoreFiles'`.

- [ ] **Step 3: Add `restoreFiles`**

In `spike/seam1/Sources/Workbench/GitStaging.swift`, after `unstageFiles` (line 39):

```swift
    /// Restore paths to HEAD, clearing their unmerged stages.
    ///
    /// **Per path, never `reset --hard`.** This is the escape from a conflicted state with no
    /// operation to abort, and the tree around it can hold modifications that were never at
    /// risk — discarding those would be a second trap rather than an exit from the first.
    /// Measured against git 2.55: this clears all three stages for the named paths and leaves
    /// an unrelated modified file untouched.
    static func restoreFiles(_ paths: [String], cwd: String) -> GitResult {
        guard !paths.isEmpty else { return .ok("") }
        return run(["checkout", "HEAD", "--"] + paths, cwd: cwd)
    }
```

- [ ] **Step 4: Run the integration test**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test \
  -only-testing:ShepherdModelTests/StashIntegrationTests 2>&1 | \
  grep -E "Test Case .* passed|failed|TEST" | tail -20
```
Expected: 4 tests passed.

- [ ] **Step 5: Expose the context on the session**

In `spike/seam1/Sources/Workbench/WorkbenchSession.swift`, beside `isMidSequence` (~line 931):

```swift
    /// What kind of conflicted state this is, and therefore what the way out is.
    ///
    /// Derived, never stored: `mergeState` and `mergeFiles` are both re-read from git by
    /// `loadConflicts()`, so this cannot drift from git's own idea of where we are.
    var conflictContext: ConflictContext {
        SequencePolicy.context(operation: mergeState.operation, hasConflicts: hasConflicts)
    }

    /// The paths a discard would restore. Only meaningful in `.loose`.
    var looseConflictPaths: [String] { mergeFiles.map(\.path) }

    /// Leave a conflicted state that has no operation to abort.
    ///
    /// The only exit that exists for it: git has nothing to `--continue` and nothing to
    /// `--abort`, so either every file gets resolved or the merge is thrown away.
    func discardLooseConflicts() {
        guard !writing, case .loose = conflictContext else { return }
        let paths = looseConflictPaths
        guard !paths.isEmpty else { return }
        let cwd = self.cwd
        lastError = nil
        writing = true
        DispatchQueue.global(qos: .userInitiated).async {
            let result = GitStaging.restoreFiles(paths, cwd: cwd)
            DispatchQueue.main.async {
                self.writing = false
                self.lastError = result.errorText
                self.resolutions.removeAll()
                self.loadConflicts()
                // The tree just changed under every row on screen.
                if result.isOK { self.load() }
            }
        }
    }
```

- [ ] **Step 6: Render the panel**

In `spike/seam1/Sources/Workbench/WorkbenchView.swift`, in the merge section (the `if session.hasConflicts { … } else if session.mergeState.isActive { … }` block around lines 940–959).

**The transformation, stated precisely** — read the surrounding code first, because the existing rows must keep their behaviour exactly:

1. The `else if session.mergeState.isActive` arm that shows *"Everything is resolved — continue when you're ready."* is unchanged.
2. The `if session.mergeState.isActive { sequenceMessageBox; continueRow; abortRow }` block is unchanged — **it must stay gated on `isActive`, not on `hasConflicts`**, so `.loose` gets no Continue and no Abort. That is the defect: an Abort that runs `<verb> --abort` with no verb returns silently.
3. Add, immediately after that block:

```swift
            // `.loose` — unmerged files with nothing in flight. No Continue and no Abort,
            // because there is nothing to continue or abort; a disabled Continue reading
            // "nothing in progress" beside a locked workbench is a contradiction the user
            // would have to resolve for us.
            if case .loose = session.conflictContext {
                looseConflictPanel
            }
```

Then add these members to `WorkbenchView`:

```swift
    /// Conflicts with no operation behind them, and the one way out.
    private var looseConflictPanel: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 10)).foregroundStyle(Theme.blocked)
                Text(SequencePolicy.looseHeadline(unresolved: session.totalUnresolved))
                    .font(.ui(10.5, .semibold)).foregroundStyle(Theme.blocked)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            Text(SequencePolicy.looseExplanation)
                .font(.ui(9.5)).foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 0) {
                Button(role: .destructive) { discardConfirm = true } label: {
                    Text("Discard changes…")
                        .font(.ui(10, .medium)).foregroundStyle(Theme.error)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Theme.error.opacity(0.12))
                        .clipShape(RoundedRectangle(cornerRadius: 4))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).focusable(false).disabled(session.writing)
                .help("Restore the conflicted files to HEAD")
                Spacer(minLength: 0)
            }
            .padding(.top, 2)
        }
        .padding(.horizontal, 12).padding(.top, 10)
    }
```

Add the state property beside the existing `abortConfirm` declaration:

```swift
    @State private var discardConfirm = false
```

And a confirmation dialog beside the existing abort one (find `abortConfirm` and mirror its `.confirmationDialog` modifier on the same view):

```swift
        .confirmationDialog(
            "Discard this conflicted merge?",
            isPresented: $discardConfirm, titleVisibility: .visible
        ) {
            Button("Discard changes", role: .destructive) {
                session.discardLooseConflicts()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            // `stashTop: nil` until Task 4 can read the stash list. The sentence is
            // information either way, never a claim that the top entry is your work.
            Text(SequencePolicy.discardConfirmation(paths: session.looseConflictPaths,
                                                    stashTop: nil))
        }
```

- [ ] **Step 7: Build and run the full suite**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test 2>&1 | tail -30
```
Expected: `** TEST SUCCEEDED **`, with the count up by 13 from the pre-Task-1 baseline.

- [ ] **Step 8: Commit**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd && \
git add spike/seam1/Sources/Workbench/GitStaging.swift \
        spike/seam1/Sources/Workbench/WorkbenchSession.swift \
        spike/seam1/Sources/Workbench/WorkbenchView.swift \
        spike/seam1/Tests/StashIntegrationTests.swift && \
git commit -m "$(cat <<'EOF'
fix(workbench): an exit from conflicts with no operation

Reachable in the shipped build: pop a stash that conflicts and the workbench
locks to Files with a Continue that says "nothing in progress" and an Abort that
silently returns, because there is no verb to abort. The only exit was another
app.

The discard is per-path `checkout HEAD --`, not `reset --hard` — the tree can
hold modifications that were never at risk, and taking those would be a second
trap. The confirmation names the files, promises the rest are untouched, and
reports the stash list without claiming the top entry is your work: nothing in
git proves that.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `StashList` — the pure stash model

**Files:**
- Create: `spike/seam1/Sources/Workbench/StashList.swift`
- Create: `spike/seam1/Tests/StashListTests.swift`
- Modify: `spike/seam1/project.yml` (add to `ShepherdModelTests` `sources:`)

**Interfaces:**
- Consumes: nothing.
- Produces: `struct Stash { let ref, sha, message: String; let timestamp: Date; var id: String }`; `enum StashScope { case all, stagedOnly, includingUntracked }`; `StashList.listArguments() -> [String]`; `StashList.parse(_:) -> [Stash]`; `StashList.pushArguments(message:scope:) -> [String]`; `StashList.untrackedArguments(ref:) -> [String]`; `StashList.applyArguments(ref:pop:) -> [String]`; `StashList.dropArguments(ref:) -> [String]`.

- [ ] **Step 1: Write the failing test**

Create `spike/seam1/Tests/StashListTests.swift`:

```swift
import XCTest
@testable import Shepherd

/// The stash list parse, and the argument lists that read and write stashes.
///
/// NUL fields and RS records for the same reason `CommitHistory` uses them: a stash message
/// is free text. Verified against git 2.55 — `git stash list --format` honours `%x00`, and a
/// real message in the wild came back as `On main: wip | with a pipe`, which a `|` delimiter
/// would have split in half.
final class StashListTests: XCTestCase {

    private func record(ref: String, sha: String, epoch: Int, message: String) -> String {
        "\(ref)\u{0}\(sha)\u{0}\(epoch)\u{0}\(message)\u{1e}\n"
    }

    // MARK: parse

    func testParsesOneStash() {
        let out = record(ref: "stash@{0}", sha: "32f6ef1efcc", epoch: 1_785_314_628,
                         message: "On main: wip: auth")
        let stashes = StashList.parse(out)
        XCTAssertEqual(stashes.count, 1)
        XCTAssertEqual(stashes[0].ref, "stash@{0}")
        XCTAssertEqual(stashes[0].sha, "32f6ef1efcc")
        XCTAssertEqual(stashes[0].message, "On main: wip: auth")
        XCTAssertEqual(stashes[0].timestamp, Date(timeIntervalSince1970: 1_785_314_628))
    }

    func testParsesSeveralInListOrder() {
        let out = record(ref: "stash@{0}", sha: "aaa", epoch: 3, message: "newest")
            + record(ref: "stash@{1}", sha: "bbb", epoch: 2, message: "middle")
            + record(ref: "stash@{2}", sha: "ccc", epoch: 1, message: "oldest")
        XCTAssertEqual(StashList.parse(out).map(\.message), ["newest", "middle", "oldest"])
    }

    /// The reason for the delimiters, taken from a real message.
    func testMessageContainingAPipe() {
        let message = "On main: wip | with a pipe"
        let out = record(ref: "stash@{0}", sha: "aaa", epoch: 1, message: message)
        XCTAssertEqual(StashList.parse(out).first?.message, message)
    }

    /// `git stash push -m` accepts a newline, so records cannot be lines.
    func testMessageContainingANewline() {
        let message = "On main: first line\nsecond line"
        let out = record(ref: "stash@{0}", sha: "aaa", epoch: 1, message: message)
        let parsed = StashList.parse(out)
        XCTAssertEqual(parsed.count, 1)
        XCTAssertEqual(parsed.first?.message, message)
    }

    func testEmptyOutputIsNoStashes() {
        XCTAssertTrue(StashList.parse("").isEmpty)
        XCTAssertTrue(StashList.parse("\n").isEmpty)
    }

    /// A short record is dropped rather than filled with blanks — a half-parsed ref would
    /// drive `git stash drop` at the wrong entry, which is not recoverable.
    func testMalformedRecordIsDropped() {
        XCTAssertTrue(StashList.parse("stash@{0}\u{0}aaa\u{1e}\n").isEmpty)
        XCTAssertTrue(StashList.parse("stash@{0}\u{0}aaa\u{0}notanumber\u{0}m\u{1e}\n").isEmpty)
    }

    /// Identity is the sha, not the ref: dropping `stash@{0}` renumbers every entry below
    /// it, so a ref-keyed selection would silently point at a different stash.
    func testIdentityIsTheShaNotTheRef() {
        let out = record(ref: "stash@{1}", sha: "abc", epoch: 1, message: "m")
        XCTAssertEqual(StashList.parse(out).first?.id, "abc")
    }

    // MARK: arguments

    /// **The crash trap.** The argument must carry the four-character escape `%x00`, never a
    /// literal NUL: `Process` cannot form a C string from a Swift string containing one, and
    /// the resulting `NSInvalidArgumentException` is an ObjC exception `try`/`catch` cannot
    /// see — it killed the workbench on ⌘G once already.
    func testListArgumentsUseFormatEscapesNotLiteralNulls() {
        let args = StashList.listArguments()
        XCTAssertEqual(args.first, "stash")
        XCTAssertTrue(args.contains("list"))
        let format = args.first { $0.hasPrefix("--format=") }
        XCTAssertNotNil(format)
        XCTAssertTrue(format!.contains("%x00"))
        XCTAssertTrue(format!.contains("%x1e"))
        for arg in args {
            XCTAssertFalse(arg.contains("\u{0}"), "a literal NUL in an argument crashes Process")
            XCTAssertFalse(arg.contains("\u{1e}"))
        }
    }

    func testPushArgumentsCarryTheMessage() {
        let args = StashList.pushArguments(message: "wip: auth", scope: .all)
        XCTAssertEqual(args.prefix(2).map(String.init(_:)), ["stash", "push"])
        XCTAssertTrue(args.contains("-m"))
        XCTAssertTrue(args.contains("wip: auth"))
    }

    /// An empty message means "let git name it" — `-m ""` would set a blank one.
    func testPushWithNoMessageOmitsTheFlag() {
        XCTAssertFalse(StashList.pushArguments(message: "   ", scope: .all).contains("-m"))
    }

    /// The scopes are mutually exclusive by construction, so `--staged --include-untracked`
    /// — which git rejects — cannot be built.
    func testPushScopes() {
        XCTAssertTrue(StashList.pushArguments(message: "", scope: .stagedOnly)
            .contains("--staged"))
        XCTAssertFalse(StashList.pushArguments(message: "", scope: .stagedOnly)
            .contains("--include-untracked"))
        XCTAssertTrue(StashList.pushArguments(message: "", scope: .includingUntracked)
            .contains("--include-untracked"))
        XCTAssertFalse(StashList.pushArguments(message: "", scope: .includingUntracked)
            .contains("--staged"))
        let all = StashList.pushArguments(message: "", scope: .all)
        XCTAssertFalse(all.contains("--staged"))
        XCTAssertFalse(all.contains("--include-untracked"))
    }

    func testApplyAndPopAndDrop() {
        XCTAssertEqual(StashList.applyArguments(ref: "stash@{1}", pop: false),
                       ["stash", "apply", "stash@{1}"])
        XCTAssertEqual(StashList.applyArguments(ref: "stash@{1}", pop: true),
                       ["stash", "pop", "stash@{1}"])
        XCTAssertEqual(StashList.dropArguments(ref: "stash@{1}"),
                       ["stash", "drop", "stash@{1}"])
    }

    /// Untracked files stashed with `-u` live in the **third** parent and appear nowhere in
    /// the first-parent diff. A stash without `-u` has no third parent, so this read is
    /// expected to fail for most stashes and that is not an error.
    func testUntrackedArgumentsReadTheThirdParent() {
        XCTAssertEqual(StashList.untrackedArguments(ref: "stash@{0}"),
                       ["ls-tree", "-r", "--name-only", "stash@{0}^3"])
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && xcodegen generate
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test \
  -only-testing:ShepherdModelTests/StashListTests 2>&1 | tail -20
```
Expected: FAIL — `cannot find 'StashList' in scope`.

- [ ] **Step 3: Write the implementation**

Create `spike/seam1/Sources/Workbench/StashList.swift`:

```swift
import Foundation

/// One stash entry.
///
/// `id` is the **sha**, not the ref: dropping `stash@{0}` renumbers every entry below it, so
/// a ref-keyed selection would quietly come to mean a different stash.
struct Stash: Equatable, Identifiable {
    /// `stash@{0}` — git's own handle, and what every stash command takes.
    let ref: String
    let sha: String
    /// git's message, e.g. `On main: wip: auth`.
    let message: String
    let timestamp: Date

    var id: String { sha }
}

/// What a `git stash push` should take. Mutually exclusive by construction — git rejects
/// `--staged --include-untracked`, and an enum cannot express it.
enum StashScope: Equatable {
    /// Staged and unstaged tracked changes.
    case all
    /// Only what is staged.
    case stagedOnly
    /// Tracked changes plus untracked files.
    case includingUntracked
}

/// The stash list, and the git argument lists that read and write stashes.
///
/// Pure: the argument builders and the parse are the parts a test can catch being wrong. The
/// `Process` work lives in `StashRunner`, like `WorktreeService`.
enum StashList {

    /// Separators **in git's output**.
    private static let fieldSeparator = "\u{0}"
    private static let recordSeparator = "\u{1e}"

    /// The same separators as git **format escapes**, for the argument.
    ///
    /// These must not be the literal characters above. `Process` turns every argument into a
    /// C string, a Swift string holding a NUL has none, and `run()` throws
    /// `NSInvalidArgumentException` — an **ObjC** exception `try`/`catch` cannot see, so the
    /// app dies. That crashed the workbench on ⌘G once; `CommitHistory` carries the same note.
    private static let fieldEscape = "%x00"
    private static let recordEscape = "%x1e"

    /// `%gd` is the ref (`stash@{0}`), `%gs` the reflog subject git shows in `stash list`.
    ///
    /// Records are RS-delimited rather than newline-delimited because `git stash push -m`
    /// accepts a message containing a newline.
    static func listArguments() -> [String] {
        ["stash", "list",
         "--format=%gd\(fieldEscape)%H\(fieldEscape)%at\(fieldEscape)%gs\(recordEscape)"]
    }

    static func parse(_ output: String) -> [Stash] {
        output.components(separatedBy: recordSeparator).compactMap { record in
            // Only the leading/trailing newline between records is noise; a newline *inside*
            // the message is content, and trimming only the ends preserves it.
            let trimmed = record.trimmingCharacters(in: .newlines)
            guard !trimmed.isEmpty else { return nil }
            let fields = trimmed.components(separatedBy: fieldSeparator)
            // A short record is dropped rather than filled with blanks: a half-parsed ref
            // would drive `git stash drop` at the wrong entry, which nothing undoes.
            guard fields.count >= 4, let epoch = Double(fields[2]) else { return nil }
            return Stash(ref: fields[0], sha: fields[1], message: fields[3],
                         timestamp: Date(timeIntervalSince1970: epoch))
        }
    }

    /// An empty message is omitted entirely so git names the stash itself — `-m ""` would
    /// set a blank one.
    static func pushArguments(message: String, scope: StashScope) -> [String] {
        var args = ["stash", "push"]
        switch scope {
        case .all:                break
        case .stagedOnly:         args.append("--staged")
        case .includingUntracked: args.append("--include-untracked")
        }
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { args += ["-m", trimmed] }
        return args
    }

    static func applyArguments(ref: String, pop: Bool) -> [String] {
        ["stash", pop ? "pop" : "apply", ref]
    }

    static func dropArguments(ref: String) -> [String] {
        ["stash", "drop", ref]
    }

    /// Paths of the files stashed with `-u`.
    ///
    /// They live in the stash's **third parent** and appear nowhere in the first-parent diff
    /// (measured). A stash pushed without `-u` has no third parent, so this read fails for
    /// most stashes — an ordinary outcome, not an error.
    static func untrackedArguments(ref: String) -> [String] {
        ["ls-tree", "-r", "--name-only", "\(ref)^3"]
    }
}
```

- [ ] **Step 4: Register, regenerate, run**

Add to `spike/seam1/project.yml` in `ShepherdModelTests`' `sources:` list, beside the other workbench models:
```yaml
      - path: Sources/Workbench/StashList.swift
```

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && xcodegen generate
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test \
  -only-testing:ShepherdModelTests/StashListTests 2>&1 | \
  grep -E "Test Case .* passed|failed|TEST" | tail -20
```
Expected: 13 tests passed.

- [ ] **Step 5: Commit**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd && \
git add spike/seam1/Sources/Workbench/StashList.swift \
        spike/seam1/Tests/StashListTests.swift spike/seam1/project.yml && \
git commit -m "$(cat <<'EOF'
feat(workbench): StashList — stashes parsed, and the args that move them

NUL fields and RS records: a stash message is free text, and the first real one
this hit came back as `On main: wip | with a pipe`. Records are RS-delimited
rather than lines because `stash push -m` accepts a newline.

The format argument carries `%x00`, never a literal NUL — Process cannot form a
C string from one and the ObjC exception that follows is invisible to try/catch.
Scopes are an enum so `--staged --include-untracked`, which git rejects, cannot
be constructed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `StashRunner` + session state, and the stash-as-a-commit reuse

The task that proves the spec's central reuse claim. If a stash does not render through
`readCommit` untouched, the later phases are built on a false premise, so this is where it
gets tested against real git.

**Files:**
- Create: `spike/seam1/Sources/Workbench/StashRunner.swift`
- Modify: `spike/seam1/Sources/Workbench/WorkbenchSession.swift` (stash state near `commits` ~line 62; `selectCommit` ~line 495; actions near `loadCommits`)
- Modify: `spike/seam1/Tests/StashIntegrationTests.swift` (add the reuse cases from Task 2's file)

**Interfaces:**
- Consumes: `StashList` (Task 3); `DiffReader.readCommit`, `Commit`, `GitStaging.run` (existing).
- Produces: `StashRunner.list(cwd:) -> [Stash]`; `StashRunner.untrackedPaths(cwd:ref:) -> [String]`; `StashRunner.push(cwd:message:scope:) -> GitResult`; `StashRunner.apply(cwd:ref:pop:) -> GitResult`; `StashRunner.drop(cwd:ref:) -> GitResult`. On `WorkbenchSession` — `@Published private(set) var stashes: [Stash]`, `@Published private(set) var selectedStash: Stash?`, `@Published private(set) var stashUntrackedPaths: [String]`, `func loadStashes()`, `func selectStash(_:)`, `func createStash(scope:)`, `func applyStash(_:pop:)`, `func dropStash(_:)`, `var stashTopDescription: String?`.

- [ ] **Step 1: Add the failing reuse tests**

Append these to `spike/seam1/Tests/StashIntegrationTests.swift`, inside the class:

```swift
    // MARK: - a stash is a commit-shaped document

    /// The spec's central reuse claim, against real git. A stash is a 3-parent merge commit,
    /// and `readCommit` already passes `-m --first-parent` — added in W5a so drilling into a
    /// merge commit would not render blank. That is exactly what makes a stash readable.
    func testStashReadsAsADiffThroughReadCommit() {
        write("f.txt", "a\nb\nc\n")
        git("add", "-A"); git("commit", "-m", "base")
        write("f.txt", "a\nWIP\nc\n")
        write("s.txt", "staged\n")
        git("add", "s.txt")
        git("stash", "push", "-m", "wip: auth")

        let stashes = StashRunner.list(cwd: repo)
        XCTAssertEqual(stashes.count, 1)
        XCTAssertEqual(stashes[0].ref, "stash@{0}")
        XCTAssertTrue(stashes[0].message.contains("wip: auth"))

        let result = DiffReader.readCommit(cwd: repo, sha: stashes[0].sha)
        XCTAssertTrue(result.isRepo)
        // Both the unstaged edit and the staged addition are in the first-parent diff.
        XCTAssertTrue(result.files.contains { $0.path == "f.txt" })
        XCTAssertTrue(result.files.contains { $0.path == "s.txt" })
        // Nothing is staged in a historical view — the rail must draw no stage buttons.
        XCTAssertTrue(result.stagedFiles.isEmpty)
    }

    /// A stash's blobs are readable by sha, which is what `BlobCache` needs for gap
    /// expansion and syntax colours inside a stash view.
    func testStashBlobsAreReadableBySha() {
        write("f.txt", "a\nb\nc\n")
        git("add", "-A"); git("commit", "-m", "base")
        write("f.txt", "a\nWIP\nc\n")
        git("stash", "push", "-m", "wip")

        let sha = StashRunner.list(cwd: repo)[0].sha
        let blob = GitStaging.run(CommitHistory.blobArguments(sha: sha, path: "f.txt"),
                                  cwd: repo)
        guard case .ok(let text) = blob else {
            return XCTFail("could not read the stash's blob: \(blob.errorText ?? "")")
        }
        XCTAssertEqual(text, "a\nWIP\nc\n")
    }

    /// Untracked files are in the **third** parent and nowhere in the first-parent diff, so
    /// they are listed rather than previewed. Measured — this is why the rail says
    /// "untracked (not previewed)" instead of synthesizing rows.
    func testUntrackedFilesAreInTheThirdParentOnly() {
        write("f.txt", "a\nb\nc\n")
        git("add", "-A"); git("commit", "-m", "base")
        write("f.txt", "a\nWIP\nc\n")
        write("u.txt", "untracked\n")
        git("stash", "push", "-u", "-m", "wip with untracked")

        let sha = StashRunner.list(cwd: repo)[0].sha
        let diff = DiffReader.readCommit(cwd: repo, sha: sha)
        XCTAssertFalse(diff.files.contains { $0.path == "u.txt" },
                       "an untracked file must not appear in the first-parent diff")

        XCTAssertEqual(StashRunner.untrackedPaths(cwd: repo, ref: "stash@{0}"), ["u.txt"])
    }

    /// A stash pushed without `-u` has no third parent. That read fails, and failing is the
    /// ordinary case — it must come back empty rather than surfacing an error.
    func testNoThirdParentIsAnEmptyListNotAnError() {
        write("f.txt", "a\nb\nc\n")
        git("add", "-A"); git("commit", "-m", "base")
        write("f.txt", "a\nWIP\nc\n")
        git("stash", "push", "-m", "no untracked")

        XCTAssertTrue(StashRunner.untrackedPaths(cwd: repo, ref: "stash@{0}").isEmpty)
    }

    func testPushAndApplyRoundTrip() {
        write("f.txt", "a\nb\nc\n")
        git("add", "-A"); git("commit", "-m", "base")
        write("f.txt", "a\nWIP\nc\n")

        XCTAssertTrue(StashRunner.push(cwd: repo, message: "round trip", scope: .all).isOK)
        XCTAssertEqual(read("f.txt"), "a\nb\nc\n", "the tree is clean after a push")

        XCTAssertTrue(StashRunner.apply(cwd: repo, ref: "stash@{0}", pop: true).isOK)
        XCTAssertEqual(read("f.txt"), "a\nWIP\nc\n", "pop restores the work")
        XCTAssertTrue(StashRunner.list(cwd: repo).isEmpty, "pop consumes the entry")
    }

    func testDropRemovesTheEntry() {
        write("f.txt", "a\nb\nc\n")
        git("add", "-A"); git("commit", "-m", "base")
        write("f.txt", "a\nWIP\nc\n")
        git("stash", "push", "-m", "doomed")

        XCTAssertTrue(StashRunner.drop(cwd: repo, ref: "stash@{0}").isOK)
        XCTAssertTrue(StashRunner.list(cwd: repo).isEmpty)
    }

    /// Nothing to stash is a git failure with a real message, and it must reach `lastError`
    /// rather than being swallowed into a no-op that looks like success.
    func testPushWithACleanTreeReportsAReason() {
        write("f.txt", "a\n")
        git("add", "-A"); git("commit", "-m", "base")

        let outcome = StashRunner.push(cwd: repo, message: "nothing", scope: .all)
        // git 2.55 exits 0 saying "No local changes to save"; either way the entry count is
        // what matters and no stash may be invented.
        XCTAssertTrue(StashRunner.list(cwd: repo).isEmpty)
        _ = outcome
    }
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test \
  -only-testing:ShepherdModelTests/StashIntegrationTests 2>&1 | tail -20
```
Expected: FAIL — `cannot find 'StashRunner' in scope`.

- [ ] **Step 3: Write `StashRunner`**

Create `spike/seam1/Sources/Workbench/StashRunner.swift`:

```swift
import Foundation

/// The `Process` half of stashing. Synchronous — callers dispatch it off the main thread,
/// like `GitStaging` and `SequenceRunner`.
enum StashRunner {

    static func list(cwd: String) -> [Stash] {
        guard case .ok(let out) = GitStaging.run(StashList.listArguments(), cwd: cwd) else {
            return []
        }
        return StashList.parse(out)
    }

    /// Paths stashed with `-u`.
    ///
    /// A stash pushed without `-u` has **no third parent**, so this read fails — the ordinary
    /// case, and the reason the failure is swallowed into an empty list rather than surfaced.
    static func untrackedPaths(cwd: String, ref: String) -> [String] {
        guard case .ok(let out) = GitStaging.run(StashList.untrackedArguments(ref: ref),
                                                cwd: cwd) else { return [] }
        return out.split(separator: "\n").map(String.init).filter { !$0.isEmpty }
    }

    static func push(cwd: String, message: String, scope: StashScope) -> GitResult {
        GitStaging.run(StashList.pushArguments(message: message, scope: scope), cwd: cwd)
    }

    /// Apply, or pop. **A conflicted apply is not an error to hide** — git exits non-zero,
    /// leaves unmerged files and no operation, and keeps the stash entry. The caller shows
    /// git's words and then reloads, and `ConflictContext` resolves the state to `.loose`.
    static func apply(cwd: String, ref: String, pop: Bool) -> GitResult {
        GitStaging.run(StashList.applyArguments(ref: ref, pop: pop), cwd: cwd)
    }

    static func drop(cwd: String, ref: String) -> GitResult {
        GitStaging.run(StashList.dropArguments(ref: ref), cwd: cwd)
    }
}
```

- [ ] **Step 4: Regenerate, build, run the integration suite**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && xcodegen generate
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test \
  -only-testing:ShepherdModelTests/StashIntegrationTests 2>&1 | \
  grep -E "Test Case .* passed|failed|TEST" | tail -25
```
Expected: 11 tests passed (4 from Task 2 + 7 here). **If `testStashReadsAsADiffThroughReadCommit` fails, stop** — the spec's reuse claim is wrong and the remaining tasks need rethinking before any UI is built.

> **Correction found while executing:** there is **no `loadCommits()`**. The commit list is
> read inside `load()`'s existing background hop (`WorkbenchSession.load()`, beside the
> `CommitHistory.logArguments` call) — deliberately, per the CLAUDE.md gotcha, because asking
> in a separate dispatch races `baseName` into its `"main"` fallback. **Every list this plan
> calls `loadX()` belongs in that same hop**, which also means it refreshes on every trigger
> `load()` already has and needs no view wiring at all. Task 4 did this for stashes; Task 8
> does the same for refs.

- [ ] **Step 5: Add the session state**

In `spike/seam1/Sources/Workbench/WorkbenchSession.swift`, after the `selectedCommit` /
`historicalSha` declarations (~line 71):

```swift
    /// The stash list, for the Commits scope's STASHES section. Empty until `loadStashes`.
    @Published private(set) var stashes: [Stash] = []

    /// Which stash the buffer is showing, when it is showing one.
    ///
    /// **This is a label for the selection, never a source of provenance.** A stash is a real
    /// commit, so a selected stash *is* a `selectedCommit` and `historicalSha` remains the
    /// single thing colours, line text and editability follow from. Two pieces of state
    /// meaning "this document is history" is two pieces of state that can disagree, which is
    /// the defect W5a's `DocumentProvenance` exists to prevent.
    @Published private(set) var selectedStash: Stash?

    /// Paths this stash carries that the diff cannot show — they live in its third parent.
    @Published private(set) var stashUntrackedPaths: [String] = []

    /// The top stash, for the discard confirmation's informational line.
    var stashTopDescription: String? {
        guard let top = stashes.first else { return nil }
        return "\(top.ref): \(top.message)"
    }
```

- [ ] **Step 6: Add the actions**

Add near `loadCommits()`:

```swift
    /// Read the stash list. One `git stash list`, off-main, on the same triggers as `load`.
    func loadStashes() {
        let cwd = self.cwd
        DispatchQueue.global(qos: .userInitiated).async {
            let parsed = StashRunner.list(cwd: cwd)
            DispatchQueue.main.async {
                self.stashes = parsed
                // A stash that has been popped or dropped elsewhere must not stay selected
                // with a document nothing can explain.
                if let selected = self.selectedStash,
                   !parsed.contains(where: { $0.sha == selected.sha }) {
                    self.selectStash(nil)
                }
            }
        }
    }

    /// Show a stash as a diff, or nil to go back to the list.
    ///
    /// Funnelled through `selectCommit` rather than beside it: a stash is a commit, so this
    /// gets W5a's provenance, blob cache, read-only guard and breadcrumb for free, and there
    /// is exactly one path by which the buffer becomes historical.
    func selectStash(_ stash: Stash?) {
        guard let stash else {
            selectedStash = nil
            stashUntrackedPaths = []
            selectCommit(nil)
            return
        }
        selectedStash = stash
        // `author` reads as the document's kind rather than a person: the header prints
        // `<sha> · <author> · <age>`, and "stash" there says what you are looking at.
        selectCommit(Commit(sha: stash.sha,
                            shortSha: String(stash.sha.prefix(7)),
                            subject: stash.message,
                            author: "stash",
                            timestamp: stash.timestamp))
        let cwd = self.cwd
        let ref = stash.ref
        DispatchQueue.global(qos: .userInitiated).async {
            let paths = StashRunner.untrackedPaths(cwd: cwd, ref: ref)
            DispatchQueue.main.async { self.stashUntrackedPaths = paths }
        }
    }

    /// Stash the working tree, reusing the commit draft as the message.
    func createStash(scope: StashScope) {
        guard !writing else { return }
        let cwd = self.cwd
        let message = commitDraft
        lastError = nil
        writing = true
        DispatchQueue.global(qos: .userInitiated).async {
            let result = StashRunner.push(cwd: cwd, message: message, scope: scope)
            DispatchQueue.main.async {
                self.writing = false
                self.lastError = result.errorText
                if result.isOK { self.commitDraft = "" }
                self.loadStashes()
                // The tree changed under every row on screen.
                self.load()
            }
        }
    }

    /// Apply or pop a stash. A conflicted apply is an ordinary outcome, not a failure to
    /// hide: git's words go to `lastError` and `loadConflicts()` resolves the state, which
    /// `ConflictContext` will report as `.loose` — no operation, so no Continue.
    func applyStash(_ stash: Stash, pop: Bool) {
        guard !writing else { return }
        let cwd = self.cwd
        let ref = stash.ref
        lastError = nil
        writing = true
        DispatchQueue.global(qos: .userInitiated).async {
            let result = StashRunner.apply(cwd: cwd, ref: ref, pop: pop)
            DispatchQueue.main.async {
                self.writing = false
                self.lastError = result.errorText
                // Drop the historical document first: after an apply the interesting thing is
                // the working tree, not the stash that produced it.
                self.selectStash(nil)
                self.loadStashes()
                self.loadConflicts()
                self.load()
            }
        }
    }

    func dropStash(_ stash: Stash) {
        guard !writing else { return }
        let cwd = self.cwd
        let ref = stash.ref
        lastError = nil
        writing = true
        DispatchQueue.global(qos: .userInitiated).async {
            let result = StashRunner.drop(cwd: cwd, ref: ref)
            DispatchQueue.main.async {
                self.writing = false
                self.lastError = result.errorText
                if self.selectedStash?.sha == stash.sha { self.selectStash(nil) }
                self.loadStashes()
            }
        }
    }
```

- [ ] **Step 7: Keep `selectedStash` from outliving its selection**

In `selectCommit(_:)` (~line 495), immediately after the `guard selectedCommit?.sha != commit?.sha else { return }` line, add:

```swift
        // A commit picked from the list is not a stash. Cleared here rather than at each call
        // site so no path can leave the label pointing at a document it does not describe.
        if selectedStash?.sha != commit?.sha {
            selectedStash = nil
            stashUntrackedPaths = []
        }
```

Also, in `setScope`, the existing line `if next != .commits { selectCommit(nil) }` already
clears a stash selection through the hook above — **do not add a second clear**, or leaving the
scope would clear `selectedStash` before `selectCommit` can compare against it.

- [ ] **Step 8: Load stashes where commits load**

No view wiring is needed: the stash list is read in `load()`'s own background hop beside the
commit log, so it refreshes on every trigger `load()` already has. The stash actions each end
in `load()`, which is what refreshes the list after a write.

Then wire the discard confirmation's stash note, replacing the `stashTop: nil` placeholder
from Task 2 Step 6:

```swift
            Text(SequencePolicy.discardConfirmation(paths: session.looseConflictPaths,
                                                    stashTop: session.stashTopDescription))
```

- [ ] **Step 9: Build and run the full suite**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test 2>&1 | tail -30
```
Expected: `** TEST SUCCEEDED **`, suite green.

- [ ] **Step 10: Commit**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd && \
git add spike/seam1/Sources/Workbench/StashRunner.swift \
        spike/seam1/Sources/Workbench/WorkbenchSession.swift \
        spike/seam1/Sources/Workbench/WorkbenchView.swift \
        spike/seam1/Tests/StashIntegrationTests.swift && \
git commit -m "$(cat <<'EOF'
feat(workbench): a stash is a commit-shaped document

Measured: a stash is a 3-parent merge commit, so readCommit reads one with no
change at all — the `-m --first-parent` W5a added so drilling into a merge would
not render blank is exactly what makes a stash readable. Selecting a stash goes
*through* selectCommit rather than beside it, so provenance, the blob cache, the
read-only guard and the breadcrumb all come for free and there is one path by
which the buffer becomes historical.

selectedStash is a label for that selection and never a source of provenance;
historicalSha stays the only thing colours, line text and editability follow
from. Untracked files live in the third parent and are listed, not previewed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: The STASHES section and the Stash button

UI only. No new git, no new model.

**Files:**
- Modify: `spike/seam1/Sources/Workbench/WorkbenchView.swift` (`commitsRail` ~line 540, `commitBox` ~line 630)

**Interfaces:**
- Consumes: `session.stashes`, `session.selectedStash`, `session.stashUntrackedPaths`, `session.selectStash(_:)`, `session.createStash(scope:)`, `session.applyStash(_:pop:)`, `session.dropStash(_:)`, `CommitHistory.relativeAge`.
- Produces: no new API.

- [ ] **Step 1: Render the section**

In `spike/seam1/Sources/Workbench/WorkbenchView.swift`, `commitsRail` currently reads:

```swift
    @ViewBuilder private var commitsRail: some View {
        if session.selectedCommit != nil {
            fileList   // its own breadcrumb trail carries the way back up
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(session.commits) { commit in
                        commitRow(commit)
                    }
                    baseRow
                }
                .padding(.bottom, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(ThinScrollers())
        }
    }
```

Add the stashes section after `baseRow`, inside the same `LazyVStack`:

```swift
                    baseRow
                    stashSection
```

Then add these members:

```swift
    /// Stashes live under the commit list rather than in a scope of their own. A stash is a
    /// kind of history, which is what this scope is — and a fifth scope segment costs a second
    /// row of chrome for something used a few times a week.
    @ViewBuilder private var stashSection: some View {
        if !session.stashes.isEmpty {
            Button { stashesExpanded.toggle() } label: {
                HStack(spacing: 5) {
                    Image(systemName: stashesExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 8, weight: .semibold))
                    Text("STASHES \(session.stashes.count)")
                        .font(.ui(9.5, .semibold))
                    Spacer(minLength: 0)
                }
                .foregroundStyle(Theme.textDim)
                .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 3)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).focusable(false)

            if stashesExpanded {
                ForEach(session.stashes) { stash in
                    stashRow(stash)
                }
            }
        }
    }

    /// Two lines like `commitRow`, for the same reason: the message is the part you read, and
    /// a ~220pt row cannot hold it beside a ref and an age.
    private func stashRow(_ stash: Stash) -> some View {
        let active = session.selectedStash?.sha == stash.sha
        return VStack(alignment: .leading, spacing: 3) {
            Button { session.selectStash(active ? nil : stash) } label: {
                HStack(alignment: .top, spacing: 7) {
                    TablerIcon(paths: Tabler.flag, size: 11)
                        .foregroundStyle(Theme.textSecondary)
                        .padding(.top, 1)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(stash.message)
                            .font(.ui(11.5, active ? .semibold : .regular))
                            .foregroundStyle(Theme.textPrimary)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                            .multilineTextAlignment(.leading)
                        HStack(spacing: 5) {
                            Text(stash.ref).font(.mono(9.5))
                            Text("·")
                            Text(CommitHistory.relativeAge(stash.timestamp, now: Date()))
                                .font(.mono(9.5))
                        }
                        .foregroundStyle(Theme.textDim)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).focusable(false)
            .help(stash.message)

            // Actions only on the open one, so the list stays scannable.
            if active {
                HStack(spacing: 6) {
                    stashAction("Apply", help: "Apply and keep the stash") {
                        session.applyStash(stash, pop: false)
                    }
                    stashAction("Pop", help: "Apply and remove the stash") {
                        session.applyStash(stash, pop: true)
                    }
                    stashAction("Drop", help: "Delete this stash", destructive: true) {
                        stashToDrop = stash
                    }
                    Spacer(minLength: 0)
                }
                // Untracked files are in the stash's third parent, which the first-parent
                // diff cannot show. Named, not fabricated into rows.
                if !session.stashUntrackedPaths.isEmpty {
                    Text("untracked (not previewed): "
                         + session.stashUntrackedPaths.joined(separator: ", "))
                        .font(.ui(9)).foregroundStyle(Theme.textDim)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 5)
        .background(active ? Theme.surface3 : Color.clear)
    }

    private func stashAction(_ title: String, help: String, destructive: Bool = false,
                             _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.ui(10, .medium))
                .foregroundStyle(destructive ? Theme.error : Theme.textSecondary)
                .padding(.horizontal, 7).padding(.vertical, 2)
                .background((destructive ? Theme.error : Theme.textSecondary).opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: 4))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).focusable(false).disabled(session.writing)
        .help(help)
    }
```

Add the state properties beside the other `@State` declarations:

```swift
    @State private var stashesExpanded = true
    /// Non-nil while the drop confirmation is up. A stash is the one thing here nothing
    /// undoes, so it is the one action that asks.
    @State private var stashToDrop: Stash?
```

And the confirmation, beside the existing `abortConfirm` / `discardConfirm` dialogs:

```swift
        .confirmationDialog(
            "Delete this stash?",
            isPresented: Binding(get: { stashToDrop != nil },
                                 set: { if !$0 { stashToDrop = nil } }),
            titleVisibility: .visible
        ) {
            Button("Drop stash", role: .destructive) {
                if let stash = stashToDrop { session.dropStash(stash) }
                stashToDrop = nil
            }
            Button("Cancel", role: .cancel) { stashToDrop = nil }
        } message: {
            Text(stashToDrop.map { "\($0.ref) — \($0.message)\n\nThis cannot be undone." } ?? "")
        }
```

**If `Tabler.flag` does not exist**, use whichever existing glyph in `Tabler` reads as a
marker (`Tabler.gitBranch` is an acceptable fallback) rather than adding a path set in this
task — `ShortcutCatalogTests` asserts glyph uniqueness only for shortcuts, but keeping icon
additions out of a UI-wiring task keeps the diff reviewable. Check with:
```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && grep -n "static let flag\|static let gitBranch" Sources/TablerIcons.swift
```

- [ ] **Step 2: Add the Stash button to the commit box**

In `commitBox` (~line 650), the button row currently reads:

```swift
            HStack(spacing: 6) {
                commitButton("Commit", prominent: true) { session.commit(push: false) }
                commitButton("& Push", prominent: false, blocked: session.pushBlockedReason) {
                    session.commit(push: true)
                }
                Spacer(minLength: 0)
                if let branch = session.branchName {
                    Text(branch).font(.mono(9.5)).foregroundStyle(Theme.textDim).lineLimit(1)
                }
            }
```

Insert a Stash control after `& Push`:

```swift
                stashMenu
```

and add:

```swift
    /// Stashing is the neighbour of committing — both are "put this somewhere and clean the
    /// tree" — and the box that already names the change is right here, so the draft becomes
    /// the stash message.
    ///
    /// A `Menu` gets **text only**: macOS renders one through an NSPopUpButton, which rescales
    /// image content to the control's height, so an icon inside the label ignores its `size:`
    /// entirely.
    @ViewBuilder private var stashMenu: some View {
        if session.isRepo && !session.resolveOnly {
            Menu {
                Button("Stash all changes") { session.createStash(scope: .all) }
                Button("Stash staged only") { session.createStash(scope: .stagedOnly) }
                Button("Stash, including untracked") {
                    session.createStash(scope: .includingUntracked)
                }
            } label: {
                Text("Stash").font(.ui(11, .semibold)).foregroundStyle(Theme.textSecondary)
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .focusable(false)
            .disabled(session.writing)
            .help("Park these changes; the commit message becomes the stash message")
        }
    }
```

- [ ] **Step 3: Build**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test 2>&1 | tail -30
```
Expected: `** TEST SUCCEEDED **`, suite green.

- [ ] **Step 4: Commit**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd && \
git add spike/seam1/Sources/Workbench/WorkbenchView.swift && \
git commit -m "$(cat <<'EOF'
feat(workbench): stashes in the Commits rail, and Stash beside Commit

A collapsible STASHES section under the commit list rather than a fifth scope: a
stash is a kind of history, and a fifth segment costs a second row of chrome for
something used a few times a week. Clicking one shows it as a read-only diff
exactly as a commit does. Actions appear only on the open row so the list stays
scannable, and Drop is the one that asks.

Untracked files are named rather than drawn — they live in the stash's third
parent, which the first-parent diff cannot show, and synthesizing rows for them
would make the fabrication real.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `RefList` + a commit range that is not always `base..HEAD`

**Files:**
- Create: `spike/seam1/Sources/Workbench/RefList.swift`
- Create: `spike/seam1/Tests/RefListTests.swift`
- Modify: `spike/seam1/Sources/Workbench/CommitHistory.swift` (`logArguments`)
- Modify: `spike/seam1/Tests/CommitHistoryTests.swift` (one added case)
- Modify: `spike/seam1/project.yml`

**Interfaces:**
- Consumes: nothing.
- Produces: `struct Ref { let name: String; let worktreePath: String?; let subject: String; let timestamp: Date; var id: String; var isCheckedOut: Bool }`; `RefList.arguments() -> [String]`; `RefList.parse(_:currentBranch:) -> [Ref]`; `CommitHistory.logArguments(range: String) -> [String]` with `logArguments(base:)` kept as a caller.

- [ ] **Step 1: Write the failing test**

Create `spike/seam1/Tests/RefListTests.swift`:

```swift
import XCTest
@testable import Shepherd

/// Local branches, for the cherry-pick source picker.
///
/// `%(worktreepath)` is non-empty exactly when a branch is checked out in some worktree —
/// verified against git 2.55, including the main checkout — which is how the picker marks the
/// branches that are live agents without a second command. In Shepherd that matters: each
/// agent works in its own worktree, so a checked-out branch is somebody's current work.
final class RefListTests: XCTestCase {

    private func record(name: String, worktree: String, epoch: Int, subject: String) -> String {
        "\(name)\u{0}\(worktree)\u{0}\(epoch)\u{0}\(subject)\u{1e}\n"
    }

    func testParsesABranchWithNoWorktree() {
        let out = record(name: "feature/auth", worktree: "", epoch: 1_785_000_000,
                         subject: "fix: token expiry")
        let refs = RefList.parse(out, currentBranch: "main")
        XCTAssertEqual(refs.count, 1)
        XCTAssertEqual(refs[0].name, "feature/auth")
        XCTAssertNil(refs[0].worktreePath)
        XCTAssertFalse(refs[0].isCheckedOut)
        XCTAssertEqual(refs[0].subject, "fix: token expiry")
        XCTAssertEqual(refs[0].timestamp, Date(timeIntervalSince1970: 1_785_000_000))
    }

    func testABranchInAWorktreeIsMarked() {
        let out = record(name: "ephemeral-panes",
                         worktree: "/Users/me/.shepherd/worktrees/shepherd/ephemeral-panes",
                         epoch: 1, subject: "wip")
        let refs = RefList.parse(out, currentBranch: "main")
        XCTAssertEqual(refs[0].worktreePath,
                       "/Users/me/.shepherd/worktrees/shepherd/ephemeral-panes")
        XCTAssertTrue(refs[0].isCheckedOut)
    }

    /// You cannot cherry-pick from yourself, and the current branch is the one whose
    /// `worktreepath` is always set — so leaving it in would put a permanently-marked
    /// useless row at the top of the picker.
    func testTheCurrentBranchIsExcluded() {
        let out = record(name: "main", worktree: "/Users/me/repo", epoch: 2, subject: "a")
            + record(name: "other", worktree: "", epoch: 1, subject: "b")
        XCTAssertEqual(RefList.parse(out, currentBranch: "main").map(\.name), ["other"])
    }

    /// A detached HEAD has no current branch; nothing should be excluded then.
    func testNoCurrentBranchExcludesNothing() {
        let out = record(name: "main", worktree: "", epoch: 2, subject: "a")
        XCTAssertEqual(RefList.parse(out, currentBranch: nil).map(\.name), ["main"])
    }

    /// Newest first: this repo has dozens of branches and the interesting ones are recent.
    /// git is asked to sort, and the parse must not undo it.
    func testOrderIsPreserved() {
        let out = record(name: "newest", worktree: "", epoch: 3, subject: "c")
            + record(name: "middle", worktree: "", epoch: 2, subject: "b")
            + record(name: "oldest", worktree: "", epoch: 1, subject: "a")
        XCTAssertEqual(RefList.parse(out, currentBranch: nil).map(\.name),
                       ["newest", "middle", "oldest"])
    }

    func testArgumentsSortNewestFirstAndUseFormatEscapes() {
        let args = RefList.arguments()
        XCTAssertEqual(args.first, "for-each-ref")
        XCTAssertTrue(args.contains("refs/heads"))
        XCTAssertTrue(args.contains("--sort=-committerdate"))
        let format = args.first { $0.hasPrefix("--format=") }
        XCTAssertNotNil(format)
        XCTAssertTrue(format!.contains("%(worktreepath)"))
        XCTAssertTrue(format!.contains("%x00"))
        for arg in args {
            XCTAssertFalse(arg.contains("\u{0}"), "a literal NUL in an argument crashes Process")
        }
    }

    func testEmptyAndMalformedRecords() {
        XCTAssertTrue(RefList.parse("", currentBranch: nil).isEmpty)
        XCTAssertTrue(RefList.parse("\n", currentBranch: nil).isEmpty)
        XCTAssertTrue(RefList.parse("only\u{0}two\u{1e}\n", currentBranch: nil).isEmpty)
        XCTAssertTrue(RefList.parse("n\u{0}\u{0}notanumber\u{0}s\u{1e}\n",
                                    currentBranch: nil).isEmpty)
    }

    /// A branch name cannot contain a space, but a subject can contain anything — including
    /// the `|` a readable delimiter would have split on.
    func testSubjectWithPunctuation() {
        let subject = "fix(x): a|b — [wip] 100% \"quoted\""
        let out = record(name: "b", worktree: "", epoch: 1, subject: subject)
        XCTAssertEqual(RefList.parse(out, currentBranch: nil).first?.subject, subject)
    }
}
```

Add to `spike/seam1/Tests/CommitHistoryTests.swift`:

```swift
    /// The Commits scope asks for `base..HEAD`; the cherry-pick picker asks for
    /// `HEAD..<ref>` — what that branch has and this one does not. One builder, so the two
    /// cannot drift in format.
    func testLogArgumentsTakeAnArbitraryRange() {
        let args = CommitHistory.logArguments(range: "HEAD..feature/auth")
        XCTAssertEqual(args.first, "log")
        XCTAssertTrue(args.contains("HEAD..feature/auth"))
        XCTAssertEqual(args.first { $0.hasPrefix("--format=") },
                       CommitHistory.logArguments(base: "master")
                           .first { $0.hasPrefix("--format=") })
    }
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && xcodegen generate
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test \
  -only-testing:ShepherdModelTests/RefListTests 2>&1 | tail -20
```
Expected: FAIL — `cannot find 'RefList' in scope`.

- [ ] **Step 3: Write `RefList`**

Create `spike/seam1/Sources/Workbench/RefList.swift`:

```swift
import Foundation

/// A local branch, as a cherry-pick source.
struct Ref: Equatable, Identifiable {
    let name: String
    /// The worktree this branch is checked out in, or nil.
    ///
    /// Non-empty exactly when git has it checked out somewhere — the main checkout included.
    /// In Shepherd that reads as "an agent is working here", because worktrees are how panes
    /// get their own branch.
    let worktreePath: String?
    let subject: String
    let timestamp: Date

    var id: String { name }
    var isCheckedOut: Bool { worktreePath != nil }
}

/// Local branches for the source picker.
///
/// Pure: argument builder plus parse. `GitStaging.listBranches` stays as it is — it feeds the
/// existing checkout menu and only needs names.
enum RefList {

    private static let fieldSeparator = "\u{0}"
    private static let recordSeparator = "\u{1e}"
    /// Format **escapes**, never literal separators — see `CommitHistory`'s note: a Swift
    /// argument containing a NUL cannot become a C string and kills the process.
    private static let fieldEscape = "%x00"
    private static let recordEscape = "%x1e"

    /// Newest first. Sorting is git's job; the parse must not reorder.
    static func arguments() -> [String] {
        ["for-each-ref", "--sort=-committerdate",
         "--format=%(refname:short)\(fieldEscape)%(worktreepath)\(fieldEscape)"
         + "%(committerdate:unix)\(fieldEscape)%(subject)\(recordEscape)",
         "refs/heads"]
    }

    /// `currentBranch` is excluded: cherry-picking from yourself is not a thing, and it is
    /// the one branch whose `worktreepath` is always set.
    static func parse(_ output: String, currentBranch: String?) -> [Ref] {
        output.components(separatedBy: recordSeparator).compactMap { record in
            let trimmed = record.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return nil }
            let fields = trimmed.components(separatedBy: fieldSeparator)
            guard fields.count >= 4, let epoch = Double(fields[2]) else { return nil }
            let name = fields[0]
            guard !name.isEmpty, name != currentBranch else { return nil }
            let worktree = fields[1].isEmpty ? nil : fields[1]
            return Ref(name: name, worktreePath: worktree, subject: fields[3],
                       timestamp: Date(timeIntervalSince1970: epoch))
        }
    }
}
```

- [ ] **Step 4: Generalize `logArguments`**

In `spike/seam1/Sources/Workbench/CommitHistory.swift`, replace `logArguments(base:)` with:

```swift
    /// Commits in a range, newest first.
    ///
    /// The Commits scope asks for `<base>..HEAD` — what this branch has done. The cherry-pick
    /// picker asks for `HEAD..<ref>` — what another branch has that this one does not. One
    /// builder so the two cannot drift in format, which matters because `parse` is shared.
    static func logArguments(range: String) -> [String] {
        ["log",
         "--format=%H\(fieldEscape)%h\(fieldEscape)%an\(fieldEscape)%at\(fieldEscape)%s\(recordEscape)",
         range]
    }

    /// `<base>..HEAD` — what this branch has done, which is the question the Commits scope
    /// answers. `%at` is the author date as a UNIX timestamp, so nothing has to parse a
    /// locale-dependent date string.
    static func logArguments(base: String) -> [String] {
        logArguments(range: "\(base)..HEAD")
    }
```

- [ ] **Step 5: Register, regenerate, run**

Add to `spike/seam1/project.yml` in `ShepherdModelTests`' `sources:`:
```yaml
      - path: Sources/Workbench/RefList.swift
```

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && xcodegen generate
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test \
  -only-testing:ShepherdModelTests/RefListTests \
  -only-testing:ShepherdModelTests/CommitHistoryTests 2>&1 | \
  grep -E "Test Case .* passed|failed|TEST" | tail -25
```
Expected: 8 `RefListTests` + 9 `CommitHistoryTests` passed.

- [ ] **Step 6: Commit**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd && \
git add spike/seam1/Sources/Workbench/RefList.swift \
        spike/seam1/Sources/Workbench/CommitHistory.swift \
        spike/seam1/Tests/RefListTests.swift spike/seam1/Tests/CommitHistoryTests.swift \
        spike/seam1/project.yml && \
git commit -m "$(cat <<'EOF'
feat(workbench): local branches as cherry-pick sources

%(worktreepath) is non-empty exactly when a branch is checked out somewhere, so
one for-each-ref marks the branches that are live agents — which in Shepherd is
the useful distinction, since worktrees are how panes get their own branch. The
current branch is excluded: you cannot pick from yourself, and it is the one
branch whose worktreepath is always set.

logArguments generalizes to a range so `base..HEAD` and `HEAD..<ref>` share one
format, and therefore one parse.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Cherry-pick progress — `N remaining`, honestly

**Files:**
- Modify: `spike/seam1/Sources/Workbench/ConflictReader.swift:3-38` (`MergeProgress`, `summary`), `:131-134` (the cherry-pick branch)
- Modify: `spike/seam1/Tests/SequenceIntegrationTests.swift:78,102` (two assertions)
- Create: `spike/seam1/Tests/CherryPickIntegrationTests.swift`

**Interfaces:**
- Consumes: `ConflictReader.gitFile` (existing, private).
- Produces: `enum MergeProgress { case counted(done: Int, total: Int); case remaining(Int); var text: String }`.

- [ ] **Step 1: Write the failing integration test**

Create `spike/seam1/Tests/CherryPickIntegrationTests.swift`:

```swift
import XCTest
@testable import Shepherd

/// A multi-commit cherry-pick, against real git.
///
/// Measured on git 2.55: a cherry-pick sequence writes `CHERRY_PICK_HEAD`, `sequencer/todo`
/// and `MERGE_MSG`, has **no `msgnum`/`end`**, and keeps **no record of what it started
/// with** — the todo shrinks in place and the directory holds only `todo`, `head` and
/// `abort-safety`. So the only honest label is how many are left.
final class CherryPickIntegrationTests: XCTestCase {

    private var repo: String!

    override func setUpWithError() throws {
        try super.setUpWithError()
        repo = NSTemporaryDirectory() + "shepherd-w5b-cp-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: repo, withIntermediateDirectories: true)
        git("init", "-b", "main")
        git("config", "user.email", "test@example.com")
        git("config", "user.name", "Test")
        git("config", "commit.gpgsign", "false")
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

    /// `side` gets three commits; the **last** touches the same line `main` moves, so a pick
    /// of all three stops on the third with two already applied.
    private func setUpDivergence() {
        write("f.txt", "a\nb\nc\n")
        write("k.txt", "keep\n")
        git("add", "-A"); git("commit", "-m", "base")

        git("checkout", "-b", "side")
        write("one.txt", "one\n"); git("add", "-A"); git("commit", "-m", "side one")
        write("two.txt", "two\n"); git("add", "-A"); git("commit", "-m", "side two")
        write("f.txt", "a\nSIDE\nc\n"); git("commit", "-am", "side touches f")

        git("checkout", "main")
        write("f.txt", "a\nMAIN\nc\n"); git("commit", "-am", "main touches f")
    }

    func testStoppedCherryPickReportsRemainingNotAFraction() {
        setUpDivergence()
        git("cherry-pick", "side~3..side")

        let state = ConflictReader.read(cwd: repo).state
        XCTAssertEqual(state.operation, .cherryPick)
        // One pick is left — the conflicted one. There is no denominator to report.
        XCTAssertEqual(state.progress, .remaining(1))
        XCTAssertEqual(state.summary?.contains("1 remaining"), true)
    }

    /// The two clean picks did land, which is why a fraction would need state we do not have.
    func testTheEarlierPicksAreAlreadyApplied() {
        setUpDivergence()
        git("cherry-pick", "side~3..side")
        let log = git("log", "--format=%s")
        XCTAssertTrue(log.contains("side one"))
        XCTAssertTrue(log.contains("side two"))
    }

    /// The loop: resolve, continue, finish — driven through the same seam a rebase uses.
    func testResolveThenContinueFinishesTheSequence() {
        setUpDivergence()
        git("cherry-pick", "side~3..side")

        write("f.txt", "a\nRESOLVED\nc\n")
        git("add", "f.txt")

        let outcome = SequenceRunner.cont(cwd: repo, operation: .cherryPick, message: nil)
        XCTAssertEqual(outcome, .finished)
        XCTAssertEqual(ConflictReader.read(cwd: repo).state.operation, .none)
        XCTAssertTrue(git("log", "--format=%s").contains("side touches f"))
    }

    /// A single-commit pick has no sequencer directory at all, so progress is absent rather
    /// than `remaining(0)` — which would render as "0 remaining" beside a live conflict.
    func testASingleCommitPickHasNoProgress() {
        setUpDivergence()
        git("cherry-pick", "side")
        let state = ConflictReader.read(cwd: repo).state
        XCTAssertEqual(state.operation, .cherryPick)
        XCTAssertNil(state.progress)
    }
}
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && xcodegen generate
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test \
  -only-testing:ShepherdModelTests/CherryPickIntegrationTests 2>&1 | tail -20
```
Expected: FAIL — `MergeProgress` has no member `remaining`.

- [ ] **Step 3: Give `MergeProgress` two shapes**

In `spike/seam1/Sources/Workbench/ConflictReader.swift`, replace lines 3–6:

```swift
/// How far through a multi-commit operation git is.
///
/// Two shapes, because git only records a fraction for a rebase. A cherry-pick's
/// `sequencer/todo` shrinks in place and nothing records what it started with (measured
/// against git 2.55 — the directory holds only `todo`, `head`, `abort-safety`), so
/// `remaining` is all that is recoverable. Inventing a denominator by remembering what we
/// started with would be **cached sequence state**, which is exactly what cannot be trusted
/// after an abort in a terminal pane.
enum MergeProgress: Equatable {
    case counted(done: Int, total: Int)
    case remaining(Int)

    var text: String {
        switch self {
        case .counted(let done, let total): return "\(done) of \(total)"
        case .remaining(let left):         return "\(left) remaining"
        }
    }
}
```

Then in `MergeState.summary`, replace the `.cherryPick` and `.rebase` arms:

```swift
        case .cherryPick:
            let base = "Cherry-picking \(theirsLabel) onto \(oursLabel)"
            guard let progress else { return base }
            return "\(base) — \(progress.text)"
        case .rebase:
            let base = "Rebasing \(theirsLabel) onto \(oursLabel)"
            guard let progress else { return base }
            return "\(base) — \(progress.text)"
```

In `readState`, replace the rebase construction (line 123):

```swift
                progress: (done.flatMap { d in total.map { MergeProgress.counted(done: d, total: $0) } }))
```

And replace the cherry-pick branch (lines 131–134):

```swift
        if gitFile(cwd, "CHERRY_PICK_HEAD") != nil {
            return MergeState(operation: .cherryPick, oursLabel: head,
                              theirsLabel: refName(cwd, "CHERRY_PICK_HEAD"),
                              progress: remainingPicks(cwd))
        }
```

Add this helper beside `gitFile`:

```swift
    /// Picks still to apply, from `sequencer/todo`.
    ///
    /// Absent for a single-commit pick, which writes no sequencer directory — so this returns
    /// nil rather than `.remaining(0)`, which would render "0 remaining" beside a live
    /// conflict. Comment and blank lines are skipped; git writes `pick <sha> <subject>` there,
    /// but only the count is read, never the format.
    private static func remainingPicks(_ cwd: String) -> MergeProgress? {
        guard let todo = gitFile(cwd, "sequencer/todo") else { return nil }
        let count = todo.components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("#") }
            .count
        return count > 0 ? .remaining(count) : nil
    }
```

- [ ] **Step 4: Update the two existing assertions**

In `spike/seam1/Tests/SequenceIntegrationTests.swift`, line 78 becomes:

```swift
        XCTAssertEqual(state.progress, .counted(done: 1, total: 2))
```

and line 102 becomes:

```swift
        XCTAssertEqual(mid.progress, .counted(done: 2, total: 2))
```

**Read the surrounding assertions before editing** — the `done` values above are what those
tests already assert via `progress?.done` / `progress?.total`; keep whatever numbers are there
rather than these, if they differ.

- [ ] **Step 5: Run both suites, then everything**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test \
  -only-testing:ShepherdModelTests/CherryPickIntegrationTests \
  -only-testing:ShepherdModelTests/SequenceIntegrationTests 2>&1 | \
  grep -E "Test Case .* passed|failed|TEST" | tail -25
```
Expected: 4 cherry-pick tests + the existing sequence tests, all passing. Then the full suite.

- [ ] **Step 6: Commit**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd && \
git add spike/seam1/Sources/Workbench/ConflictReader.swift \
        spike/seam1/Tests/CherryPickIntegrationTests.swift \
        spike/seam1/Tests/SequenceIntegrationTests.swift && \
git commit -m "$(cat <<'EOF'
feat(workbench): a stopped cherry-pick says how many are left

It said nothing before: progress was read from rebase's msgnum/end, and a
cherry-pick has neither. It has sequencer/todo, which shrinks in place — and
measured on git 2.55, nothing records what the sequence started with. So the
label is "2 remaining", never "2 of 5"; remembering the 5 ourselves would be
cached sequence state, which an abort in a terminal pane invalidates.

A single-commit pick writes no sequencer directory, so it reports no progress
rather than "0 remaining" beside a live conflict.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: The source picker, and picking

**Files:**
- Create: `spike/seam1/Sources/Workbench/CherryPickRunner.swift`
- Modify: `spike/seam1/Sources/Workbench/WorkbenchSession.swift` (ref/source state + actions)
- Modify: `spike/seam1/Sources/Workbench/WorkbenchView.swift` (`commitsRail`)

**Interfaces:**
- Consumes: `RefList`, `CommitHistory.logArguments(range:)` / `.parse` (Task 6); `GitStaging.run`, `GitStaging.currentBranch` (existing).
- Produces: `CherryPickRunner.refs(cwd:) -> [Ref]`; `CherryPickRunner.commits(cwd:ref:) -> [Commit]`; `CherryPickRunner.pick(cwd:shas:) -> GitResult`. On `WorkbenchSession` — `@Published private(set) var sourceRefs: [Ref]`, `@Published private(set) var sourceRef: Ref?`, `@Published private(set) var sourceCommits: [Commit]`, `@Published var pickSelection: Set<String>`, `func loadSourceRefs()`, `func selectSourceRef(_:)`, `func cherryPickSelection()`.

- [ ] **Step 1: Write `CherryPickRunner`**

Create `spike/seam1/Sources/Workbench/CherryPickRunner.swift`:

```swift
import Foundation

/// Reading other branches, and starting a pick. The `Process` half; the parses are pure.
enum CherryPickRunner {

    static func refs(cwd: String) -> [Ref] {
        guard case .ok(let out) = GitStaging.run(RefList.arguments(), cwd: cwd) else { return [] }
        return RefList.parse(out, currentBranch: GitStaging.currentBranch(cwd: cwd))
    }

    /// What `ref` has that HEAD does not.
    ///
    /// `HEAD..<ref>` rather than the ref's whole history: a branch's shared past is not a
    /// cherry-pick candidate, and listing it would be the unbounded history browsing W5a
    /// ruled out.
    static func commits(cwd: String, ref: String) -> [Commit] {
        guard case .ok(let out) = GitStaging.run(
            CommitHistory.logArguments(range: "HEAD..\(ref)"), cwd: cwd) else { return [] }
        return CommitHistory.parse(out)
    }

    /// Pick, **oldest first**.
    ///
    /// `git cherry-pick` applies its arguments in the order given, and the list on screen is
    /// newest-first — so the caller's order has to be reversed before it gets here or the
    /// picks land backwards. Same inversion `RebasePlan` handles, one command earlier.
    ///
    /// A conflict is an ordinary outcome: git exits non-zero, writes `CHERRY_PICK_HEAD`, and
    /// the existing lock plus Continue drive the rest.
    static func pick(cwd: String, shas: [String]) -> GitResult {
        guard !shas.isEmpty else { return .ok("") }
        return GitStaging.run(["cherry-pick"] + shas, cwd: cwd)
    }
}
```

- [ ] **Step 2: Add the session state and actions**

In `spike/seam1/Sources/Workbench/WorkbenchSession.swift`, beside the stash state:

```swift
    /// Branches that could be a cherry-pick source. Empty until `loadSourceRefs`.
    @Published private(set) var sourceRefs: [Ref] = []
    /// The branch being browsed, or nil for this branch's own commits.
    @Published private(set) var sourceRef: Ref?
    /// `HEAD..<sourceRef>` — what that branch has that this one does not.
    @Published private(set) var sourceCommits: [Commit] = []
    /// Shas ticked for picking, newest-first like the list they came from.
    @Published var pickSelection: Set<String> = []
```

and the actions, near `loadStashes()`:

```swift
    func loadSourceRefs() {
        let cwd = self.cwd
        DispatchQueue.global(qos: .userInitiated).async {
            let refs = CherryPickRunner.refs(cwd: cwd)
            DispatchQueue.main.async {
                self.sourceRefs = refs
                // A branch deleted elsewhere must not stay selected with a stale commit list.
                if let current = self.sourceRef,
                   !refs.contains(where: { $0.name == current.name }) {
                    self.selectSourceRef(nil)
                }
            }
        }
    }

    /// Browse another branch, or nil to go back to this branch's commits.
    func selectSourceRef(_ ref: Ref?) {
        sourceRef = ref
        pickSelection = []
        // Whatever historical document was on screen belonged to the previous list.
        selectCommit(nil)
        guard let ref else {
            sourceCommits = []
            return
        }
        let cwd = self.cwd
        let name = ref.name
        DispatchQueue.global(qos: .userInitiated).async {
            let commits = CherryPickRunner.commits(cwd: cwd, ref: name)
            DispatchQueue.main.async { self.sourceCommits = commits }
        }
    }

    /// Apply the ticked commits onto this branch.
    ///
    /// **Reversed on the way out.** `sourceCommits` is newest-first, and `git cherry-pick`
    /// applies its arguments in the order given, so handing it the display order would land
    /// the picks backwards — and each would then be applied to a tree its author never saw.
    func cherryPickSelection() {
        guard !writing, !pickSelection.isEmpty else { return }
        let shas = sourceCommits.filter { pickSelection.contains($0.sha) }
            .map(\.sha).reversed().map(String.init)
        let cwd = self.cwd
        lastError = nil
        writing = true
        invalidateBlame()
        DispatchQueue.global(qos: .userInitiated).async {
            let result = CherryPickRunner.pick(cwd: cwd, shas: shas)
            DispatchQueue.main.async {
                self.writing = false
                // A conflict is not a failure to hide, but git's words are worth showing —
                // the lock and the counter will explain the rest.
                self.lastError = result.errorText
                self.pickSelection = []
                self.selectCommit(nil)
                self.loadConflicts()
                self.load()
                self.loadCommits()
            }
        }
    }
```

- [ ] **Step 3: Render the picker**

In `commitsRail`, the list branch currently iterates `session.commits`. It becomes: a `from:`
menu, then either this branch's commits or the source branch's, with a pick bar when anything
is ticked.

Replace the `else` branch's `LazyVStack` contents so it reads:

```swift
                LazyVStack(alignment: .leading, spacing: 0) {
                    sourcePicker
                    if session.sourceRef == nil {
                        ForEach(session.commits) { commit in
                            commitRow(commit)
                        }
                        baseRow
                        stashSection
                    } else {
                        if session.sourceCommits.isEmpty {
                            Text("Nothing here that this branch does not already have.")
                                .font(.ui(10)).foregroundStyle(Theme.textDim)
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.horizontal, 12).padding(.vertical, 8)
                        }
                        ForEach(session.sourceCommits) { commit in
                            sourceCommitRow(commit)
                        }
                        pickBar
                    }
                }
```

Then add:

```swift
    /// Where cherry-pick sources come from. One `for-each-ref`, sorted newest-first, with the
    /// branches git has checked out somewhere marked — in Shepherd those are the agents.
    ///
    /// The `Menu` carries **text only**: macOS renders one through an NSPopUpButton, which
    /// rescales image content to the control's height, so an icon in the label ignores `size:`.
    @ViewBuilder private var sourcePicker: some View {
        if !session.sourceRefs.isEmpty {
            HStack(spacing: 6) {
                Text("from").font(.ui(9.5)).foregroundStyle(Theme.textDim)
                Menu {
                    Button("This branch") { session.selectSourceRef(nil) }
                    Divider()
                    ForEach(session.sourceRefs) { ref in
                        Button(ref.isCheckedOut ? "\(ref.name)  ·  checked out" : ref.name) {
                            session.selectSourceRef(ref)
                        }
                    }
                } label: {
                    Text(session.sourceRef?.name ?? "this branch")
                        .font(.ui(10.5, .medium)).foregroundStyle(Theme.textSecondary)
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .focusable(false)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12).padding(.top, 6).padding(.bottom, 4)
        }
    }

    /// A source commit: tick to pick, click the body to preview it read-only.
    private func sourceCommitRow(_ commit: Commit) -> some View {
        let ticked = session.pickSelection.contains(commit.sha)
        let active = session.selectedCommit?.sha == commit.sha
        return HStack(alignment: .top, spacing: 7) {
            Button {
                if ticked { session.pickSelection.remove(commit.sha) }
                else { session.pickSelection.insert(commit.sha) }
            } label: {
                Image(systemName: ticked ? "checkmark.square.fill" : "square")
                    .font(.system(size: 11))
                    .foregroundStyle(ticked ? Theme.working : Theme.textDim)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain).focusable(false)
            .help(ticked ? "Remove from the pick" : "Cherry-pick this commit")

            Button { session.selectCommit(active ? nil : commit) } label: {
                VStack(alignment: .leading, spacing: 1) {
                    Text(commit.subject)
                        .font(.ui(11.5, active ? .semibold : .regular))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                        .multilineTextAlignment(.leading)
                    HStack(spacing: 5) {
                        Text(commit.shortSha).font(.mono(9.5))
                        Text("·")
                        Text(CommitHistory.relativeAge(commit.timestamp, now: Date()))
                            .font(.mono(9.5))
                    }
                    .foregroundStyle(Theme.textDim)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).focusable(false)
            .help("\(commit.subject)\n\(commit.author)")
        }
        .padding(.horizontal, 12).padding(.vertical, 5)
        .background(active ? Theme.surface3 : Color.clear)
    }

    @ViewBuilder private var pickBar: some View {
        if !session.pickSelection.isEmpty {
            HStack(spacing: 8) {
                Button { session.cherryPickSelection() } label: {
                    Text("Cherry-pick \(session.pickSelection.count)")
                        .font(.ui(11, .semibold)).foregroundStyle(Theme.working)
                        .padding(.horizontal, 10).padding(.vertical, 4)
                        .background(Theme.working.opacity(0.14))
                        .clipShape(RoundedRectangle(cornerRadius: 5))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).focusable(false).disabled(session.writing)
                .help("Apply the ticked commits onto this branch, oldest first")
                Button { session.pickSelection = [] } label: {
                    Text("Clear").font(.ui(10)).foregroundStyle(Theme.textDim)
                }
                .buttonStyle(.plain).focusable(false)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
        }
    }
```

- [ ] **Step 4: Load the refs where the other lists load**

Read the ref list in `load()`'s background hop, beside the commit log and the stash list —
same reason, same place. No view wiring.

Also, in `WorkbenchSession.setScope`, the `.commits` arm returns early. Add before that return:

```swift
            // A source branch chosen last visit is not the landing state — the scope opens on
            // this branch's own commits, which is what it is for.
            if sourceRef != nil { selectSourceRef(nil) }
```

- [ ] **Step 5: Build**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && xcodegen generate
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test 2>&1 | tail -30
```
Expected: `** TEST SUCCEEDED **`, suite green.

- [ ] **Step 6: Commit**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd && \
git add spike/seam1/Sources/Workbench/CherryPickRunner.swift \
        spike/seam1/Sources/Workbench/WorkbenchSession.swift \
        spike/seam1/Sources/Workbench/WorkbenchView.swift && \
git commit -m "$(cat <<'EOF'
feat(workbench): cherry-pick from another branch or worktree

The Commits scope is base..HEAD, which is definitionally every commit you would
not pick — so the rail grows a `from:` menu of local branches with the
checked-out ones marked, and lists HEAD..<ref>. Bounded browsing: one ref, no
graph, no pagination. It does not reopen the question W5a closed.

Picks are reversed on the way out. The list is newest-first and cherry-pick
applies its arguments in order, so the display order would land them backwards
and apply each to a tree its author never saw.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: `RebasePlan` — the pure todo writer

The task where a wrong answer silently reverses a branch's history. Pure, and tested first.

**Files:**
- Create: `spike/seam1/Sources/Workbench/RebasePlan.swift`
- Create: `spike/seam1/Tests/RebasePlanTests.swift`
- Modify: `spike/seam1/project.yml`

**Interfaces:**
- Consumes: `Commit` (existing).
- Produces: `enum RebaseVerb: String, CaseIterable { case pick, reword, squash, fixup, drop }` with `title`/`help`/`needsMessage`; `struct PlanRow: Equatable, Identifiable { let commit: Commit; var verb: RebaseVerb; var message: String; var id: String }`; `RebasePlan.rows(from: [Commit]) -> [PlanRow]`; `RebasePlan.todo(for: [PlanRow]) -> String`; `RebasePlan.isNoOp(rows: [PlanRow], original: [Commit]) -> Bool`; `RebasePlan.blockedReason(rows: [PlanRow], original: [Commit]) -> String?`; `RebasePlan.messageEntry(rows: [PlanRow]) -> PlanRow?`.

- [ ] **Step 1: Write the failing test**

Create `spike/seam1/Tests/RebasePlanTests.swift`:

```swift
import XCTest
@testable import Shepherd

/// Rows on screen → a git todo.
///
/// Three things here can be wrong in ways nothing else would catch, and the first is the
/// worst: **git's todo is oldest-first and the rail is newest-first**, so emitting the display
/// order silently reverses a branch. That is the same read-it-either-way trap as `SplitAxis`,
/// where `.row` means side-by-side — which is why it is tested rather than reasoned about.
///
/// Verified against git 2.55: a todo of bare `<verb> <sha>` lines with **no subject at all**
/// rebases correctly, so nothing here needs to reproduce git's own
/// `pick <shortsha> # <subject>` format. We only ever write a todo, never parse one.
final class RebasePlanTests: XCTestCase {

    private func commit(_ sha: String, _ subject: String) -> Commit {
        Commit(sha: sha, shortSha: String(sha.prefix(7)), subject: subject,
               author: "A", timestamp: Date(timeIntervalSince1970: 1_000_000))
    }

    /// Newest first, exactly as `git log` and the rail present them.
    private var newestFirst: [Commit] {
        [commit("ccccccc3", "third"), commit("bbbbbbb2", "second"), commit("aaaaaaa1", "first")]
    }

    // MARK: rows

    func testRowsStartAsPickInDisplayOrder() {
        let rows = RebasePlan.rows(from: newestFirst)
        XCTAssertEqual(rows.map(\.verb), [.pick, .pick, .pick])
        XCTAssertEqual(rows.map(\.commit.subject), ["third", "second", "first"])
        XCTAssertEqual(rows.map(\.message), ["", "", ""])
    }

    // MARK: the todo, and the inversion

    /// **The load-bearing assertion.** The rail's top row is the newest commit; git applies
    /// the todo top-down starting from the base, so the emitted order is the reverse.
    func testTodoIsEmittedOldestFirst() {
        let todo = RebasePlan.todo(for: RebasePlan.rows(from: newestFirst))
        XCTAssertEqual(todo, "pick aaaaaaa1\npick bbbbbbb2\npick ccccccc3\n")
    }

    func testTodoCarriesEachVerb() {
        var rows = RebasePlan.rows(from: newestFirst)
        rows[0].verb = .fixup      // newest → last line
        rows[2].verb = .reword     // oldest → first line
        rows[2].message = "a better subject"
        let todo = RebasePlan.todo(for: rows)
        XCTAssertEqual(todo, "reword aaaaaaa1\npick bbbbbbb2\nfixup ccccccc3\n")
    }

    /// A dropped row is **absent**, not `drop <sha>`. Both work in git; leaving the line out
    /// is what an empty plan then looks like, which is the case git refuses cleanly.
    func testDroppedRowsAreOmitted() {
        var rows = RebasePlan.rows(from: newestFirst)
        rows[1].verb = .drop
        XCTAssertEqual(RebasePlan.todo(for: rows), "pick aaaaaaa1\npick ccccccc3\n")
    }

    func testAllDroppedIsAnEmptyTodo() {
        var rows = RebasePlan.rows(from: newestFirst)
        for i in rows.indices { rows[i].verb = .drop }
        XCTAssertEqual(RebasePlan.todo(for: rows), "")
    }

    /// A reorder on screen must survive into the todo, still inverted.
    func testReorderIsHonouredAndStillInverted() {
        var rows = RebasePlan.rows(from: newestFirst)
        rows.swapAt(0, 2)   // oldest to the top of the rail
        XCTAssertEqual(RebasePlan.todo(for: rows), "pick ccccccc3\npick bbbbbbb2\npick aaaaaaa1\n")
    }

    /// Nothing but the sha reaches the todo. A subject with a `#` in it must not be able to
    /// comment out its own line.
    func testSubjectsNeverReachTheTodo() {
        let rows = RebasePlan.rows(from: [commit("aaaaaaa1", "fix: # not a comment")])
        XCTAssertEqual(RebasePlan.todo(for: rows), "pick aaaaaaa1\n")
    }

    // MARK: no-op detection

    func testAllPickInOriginalOrderIsANoOp() {
        XCTAssertTrue(RebasePlan.isNoOp(rows: RebasePlan.rows(from: newestFirst),
                                        original: newestFirst))
    }

    func testAChangedVerbIsNotANoOp() {
        var rows = RebasePlan.rows(from: newestFirst)
        rows[0].verb = .drop
        XCTAssertFalse(RebasePlan.isNoOp(rows: rows, original: newestFirst))
    }

    func testAReorderIsNotANoOp() {
        var rows = RebasePlan.rows(from: newestFirst)
        rows.swapAt(0, 1)
        XCTAssertFalse(RebasePlan.isNoOp(rows: rows, original: newestFirst))
    }

    // MARK: refusals — each with a reason

    func testANoOpPlanIsBlockedWithAReason() {
        let reason = RebasePlan.blockedReason(rows: RebasePlan.rows(from: newestFirst),
                                              original: newestFirst)
        XCTAssertEqual(reason, "nothing to apply")
    }

    /// Rewriting for no reason is not harmless: every sha changes, which invalidates the
    /// branch's PR review state.
    func testEmptyPlanIsBlocked() {
        XCTAssertEqual(RebasePlan.blockedReason(rows: [], original: []), "nothing to apply")
    }

    func testDroppingEverythingIsBlocked() {
        var rows = RebasePlan.rows(from: newestFirst)
        for i in rows.indices { rows[i].verb = .drop }
        XCTAssertEqual(RebasePlan.blockedReason(rows: rows, original: newestFirst),
                       "every commit is dropped")
    }

    /// git errors out on a todo starting with squash/fixup — there is nothing before it to
    /// squash into. Refused here, with words, before git sees it.
    ///
    /// The **oldest** row is the todo's first line, so this is the *bottom* of the rail.
    func testTheOldestRowCannotBeASquash() {
        var rows = RebasePlan.rows(from: newestFirst)
        rows[2].verb = .squash
        XCTAssertEqual(RebasePlan.blockedReason(rows: rows, original: newestFirst),
                       "the first commit has nothing to squash into")

        rows[2].verb = .fixup
        XCTAssertEqual(RebasePlan.blockedReason(rows: rows, original: newestFirst),
                       "the first commit has nothing to squash into")
    }

    /// A squash below a dropped oldest commit is still the first line of the todo.
    func testSquashIsAlsoFirstWhenEverythingOlderIsDropped() {
        var rows = RebasePlan.rows(from: newestFirst)
        rows[2].verb = .drop
        rows[1].verb = .squash
        XCTAssertEqual(RebasePlan.blockedReason(rows: rows, original: newestFirst),
                       "the first commit has nothing to squash into")
    }

    /// The one-message rule. `GIT_EDITOR="cp '<file>'"` can supply exactly one message, so a
    /// plan with two editor-opening entries would give both commits the same subject.
    func testTwoMessageEntriesAreBlocked() {
        var rows = RebasePlan.rows(from: newestFirst)
        rows[0].verb = .reword
        rows[1].verb = .squash
        XCTAssertEqual(RebasePlan.blockedReason(rows: rows, original: newestFirst),
                       "one reword or squash per rewrite — apply this, then rewrite again")
    }

    /// `fixup` keeps the base commit's message and opens no editor, so any number is fine.
    func testManyFixupsAreAllowed() {
        var rows = RebasePlan.rows(from: newestFirst)
        rows[0].verb = .fixup
        rows[1].verb = .fixup
        XCTAssertNil(RebasePlan.blockedReason(rows: rows, original: newestFirst))
    }

    func testOneRewordIsAllowedAndIsTheMessageEntry() {
        var rows = RebasePlan.rows(from: newestFirst)
        rows[1].verb = .reword
        rows[1].message = "new subject"
        XCTAssertNil(RebasePlan.blockedReason(rows: rows, original: newestFirst))
        XCTAssertEqual(RebasePlan.messageEntry(rows: rows)?.commit.sha, "bbbbbbb2")
        XCTAssertEqual(RebasePlan.messageEntry(rows: rows)?.message, "new subject")
    }

    /// A reword with no text would hand git an empty message file and abort the commit.
    func testARewordWithNoMessageIsBlocked() {
        var rows = RebasePlan.rows(from: newestFirst)
        rows[0].verb = .reword
        XCTAssertEqual(RebasePlan.blockedReason(rows: rows, original: newestFirst),
                       "the reword needs a message")
    }

    func testNoMessageEntryWhenNothingNeedsOne() {
        XCTAssertNil(RebasePlan.messageEntry(rows: RebasePlan.rows(from: newestFirst)))
    }

    // MARK: verbs

    func testOnlyRewordAndSquashNeedAMessage() {
        XCTAssertTrue(RebaseVerb.reword.needsMessage)
        XCTAssertTrue(RebaseVerb.squash.needsMessage)
        XCTAssertFalse(RebaseVerb.fixup.needsMessage)
        XCTAssertFalse(RebaseVerb.pick.needsMessage)
        XCTAssertFalse(RebaseVerb.drop.needsMessage)
    }

    /// `edit` and `break` are deliberately absent: both stop the rebase for work that belongs
    /// in a terminal, and a verb the UI offers but cannot finish is worse than none.
    func testTheVerbSetIsDeliberatelySmall() {
        XCTAssertEqual(RebaseVerb.allCases.map(\.rawValue),
                       ["pick", "reword", "squash", "fixup", "drop"])
    }
}
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && xcodegen generate
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test \
  -only-testing:ShepherdModelTests/RebasePlanTests 2>&1 | tail -20
```
Expected: FAIL — `cannot find 'RebasePlan' in scope`.

- [ ] **Step 3: Write the implementation**

Create `spike/seam1/Sources/Workbench/RebasePlan.swift`:

```swift
import Foundation

/// What to do with one commit in a rewrite.
///
/// **`edit` and `break` are deliberately absent.** Both stop the rebase for work that is not
/// this window's shape — amend by hand, go and run something — and a verb the UI offers but
/// cannot finish is worse than one it never had.
enum RebaseVerb: String, CaseIterable, Equatable {
    case pick, reword, squash, fixup, drop

    var title: String { rawValue }

    var help: String {
        switch self {
        case .pick:   return "Keep this commit as it is"
        case .reword: return "Keep the changes, change the message"
        case .squash: return "Fold into the commit above and combine the messages"
        case .fixup:  return "Fold into the commit above, keeping that commit's message"
        case .drop:   return "Throw this commit away"
        }
    }

    /// Whether git will open an editor for this entry.
    ///
    /// `fixup` discards its own message and keeps the base commit's, so it opens nothing —
    /// which is why any number of fixups is allowed and only one reword-or-squash is.
    var needsMessage: Bool {
        switch self {
        case .reword, .squash: return true
        case .pick, .fixup, .drop: return false
        }
    }
}

/// One row of the rewrite plan.
struct PlanRow: Equatable, Identifiable {
    let commit: Commit
    var verb: RebaseVerb = .pick
    /// The message for a `reword` / `squash`, collected before Apply.
    var message: String = ""

    var id: String { commit.sha }
}

/// Rows on screen → a git todo, and whether the plan may run.
///
/// Pure, because the one thing here that cannot be caught by looking at it is the order.
enum RebasePlan {

    static func rows(from commits: [Commit]) -> [PlanRow] {
        commits.map { PlanRow(commit: $0) }
    }

    /// The todo git will execute.
    ///
    /// **Emitted oldest-first — the reverse of the rail.** git applies a todo top-down starting
    /// from the base, and the rail lists newest first like `git log`, so handing over the
    /// display order would reverse the branch. Nothing but the verb and the sha is written:
    /// verified against git 2.55, a todo of bare `<verb> <sha>` lines rebases correctly, and
    /// leaving the subject out means a subject containing `#` cannot comment out its own line.
    ///
    /// A `drop` emits no line at all. `drop <sha>` works equally well; omitting it is what
    /// makes "everything dropped" an empty todo, which git refuses cleanly with
    /// `error: nothing to do`.
    static func todo(for rows: [PlanRow]) -> String {
        rows.reversed()
            .filter { $0.verb != .drop }
            .map { "\($0.verb.rawValue) \($0.commit.sha)" }
            .joined(separator: "\n")
            .appendingNewlineIfNeeded()
    }

    /// Whether this plan would change nothing.
    ///
    /// Not a nicety: a rebase that rewrites every sha for no reason invalidates the branch's
    /// PR review state, so "apply" must not be reachable when there is nothing to apply.
    static func isNoOp(rows: [PlanRow], original: [Commit]) -> Bool {
        guard rows.allSatisfy({ $0.verb == .pick }) else { return false }
        return rows.map(\.commit.sha) == original.map(\.sha)
    }

    /// The single entry git will open an editor for, if any.
    static func messageEntry(rows: [PlanRow]) -> PlanRow? {
        rows.first { $0.verb.needsMessage }
    }

    /// Why Apply is disabled, or nil when the plan may run.
    ///
    /// Never nil when the plan cannot run — a dead button with no explanation is the thing
    /// this project keeps refusing to ship.
    static func blockedReason(rows: [PlanRow], original: [Commit]) -> String? {
        let kept = rows.filter { $0.verb != .drop }
        if rows.isEmpty || isNoOp(rows: rows, original: original) { return "nothing to apply" }
        if kept.isEmpty { return "every commit is dropped" }

        // The **oldest** kept row is the todo's first line — the bottom of the rail — and git
        // rejects a todo that starts with squash or fixup: there is nothing before it.
        if let first = kept.last, first.verb == .squash || first.verb == .fixup {
            return "the first commit has nothing to squash into"
        }

        // One editor-opening entry per plan. `GIT_EDITOR="cp '<file>'"` substitutes exactly one
        // message, so two rewords would give both commits the same subject. `fixup` opens
        // nothing, so any number of those is fine — which covers tidying a fixup chain.
        let needMessages = kept.filter { $0.verb.needsMessage }
        if needMessages.count > 1 {
            return "one reword or squash per rewrite — apply this, then rewrite again"
        }
        if let entry = needMessages.first,
           entry.message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return entry.verb == .reword
                ? "the reword needs a message"
                : "the squash needs a message"
        }
        return nil
    }
}

private extension String {
    /// A todo git reads must end in a newline; an empty todo must stay empty.
    func appendingNewlineIfNeeded() -> String {
        isEmpty || hasSuffix("\n") ? self : self + "\n"
    }
}
```

- [ ] **Step 4: Register, regenerate, run**

Add to `spike/seam1/project.yml` in `ShepherdModelTests`' `sources:`:
```yaml
      - path: Sources/Workbench/RebasePlan.swift
```

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && xcodegen generate
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test \
  -only-testing:ShepherdModelTests/RebasePlanTests 2>&1 | \
  grep -E "Test Case .* passed|failed|TEST" | tail -30
```
Expected: 21 tests passed.

- [ ] **Step 5: Commit**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd && \
git add spike/seam1/Sources/Workbench/RebasePlan.swift \
        spike/seam1/Tests/RebasePlanTests.swift spike/seam1/project.yml && \
git commit -m "$(cat <<'EOF'
feat(workbench): RebasePlan — rows on screen into a git todo

Emitted oldest-first, which is the reverse of the rail. git applies a todo
top-down from the base and the rail lists newest first, so handing over the
display order would silently reverse the branch — the same read-it-either-way
trap as SplitAxis's `.row`, and tested for the same reason.

Only the verb and the sha are written: measured on git 2.55, a todo of bare
`<verb> <sha>` lines rebases correctly, so nothing has to reproduce git's own
`pick <sha> # <subject>` format and a subject containing `#` cannot comment out
its own line.

Every refusal carries words: a no-op plan (rewriting every sha for nothing
invalidates the branch's PR), everything dropped, a squash with nothing above it,
and more than one editor-opening entry — `cp '<file>'` substitutes exactly one
message, and fixup opens none, so fixups are unlimited.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: `RebaseRunner` + the real-git proof

**Files:**
- Create: `spike/seam1/Sources/Workbench/RebaseRunner.swift`
- Create: `spike/seam1/Tests/RebasePlanIntegrationTests.swift`

**Interfaces:**
- Consumes: `RebasePlan`, `PlanRow` (Task 9); `GitStaging.run(_:cwd:stdin:env:)` (existing).
- Produces: `RebaseRunner.apply(cwd:base:rows:) -> GitResult`.

- [ ] **Step 1: Write the failing integration test**

Create `spike/seam1/Tests/RebasePlanIntegrationTests.swift`. **One file per commit**, so a
reorder does not conflict with itself — the first attempt at this fixture appended to a single
file and every reorder produced a conflict, which tested nothing about ordering.

```swift
import XCTest
@testable import Shepherd

/// A plan applied by real git.
///
/// The pure tests pin the todo's *text*; only git can confirm the text means what we think.
/// Verified here: the oldest-first inversion produces the intended history, `GIT_SEQUENCE_EDITOR`
/// works with no tty, and a todo carrying **no subjects at all** is accepted.
final class RebasePlanIntegrationTests: XCTestCase {

    private var repo: String!

    override func setUpWithError() throws {
        try super.setUpWithError()
        repo = NSTemporaryDirectory() + "shepherd-w5b-rw-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: repo, withIntermediateDirectories: true)
        git("init", "-b", "main")
        git("config", "user.email", "test@example.com")
        git("config", "user.name", "Test")
        git("config", "commit.gpgsign", "false")

        write("base.txt", "base\n")
        git("add", "-A"); git("commit", "-m", "base commit")
        git("checkout", "-b", "feature")
        // One file per commit: a reorder of commits that all touch one file conflicts with
        // itself and would test nothing about ordering.
        for name in ["one", "two", "three"] {
            write("\(name).txt", "\(name)\n")
            git("add", "\(name).txt")
            git("commit", "-m", "feat: \(name)")
        }
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

    /// Newest first, as the rail shows them.
    private func branchCommits() -> [Commit] {
        guard case .ok(let out) = GitStaging.run(CommitHistory.logArguments(base: "main"),
                                                cwd: repo) else { return [] }
        return CommitHistory.parse(out)
    }

    private func subjects() -> [String] {
        branchCommits().map(\.subject)
    }

    private var midRebase: Bool {
        let dir = git("rev-parse", "--git-path", "rebase-merge")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let path = dir.hasPrefix("/") ? dir : (repo as NSString).appendingPathComponent(dir)
        return FileManager.default.fileExists(atPath: path)
    }

    func testTheFixtureStartsNewestFirst() {
        XCTAssertEqual(subjects(), ["feat: three", "feat: two", "feat: one"])
    }

    /// **The inversion, proved.** Reversing the rail must reverse the history, not leave it
    /// alone and not scramble it.
    func testReversingTheRailReversesTheHistory() {
        var rows = RebasePlan.rows(from: branchCommits())
        rows.reverse()

        let result = RebaseRunner.apply(cwd: repo, base: "main", rows: rows)
        XCTAssertTrue(result.isOK, result.errorText ?? "")
        XCTAssertFalse(midRebase, "a clean rewrite must not leave the repo mid-rebase")
        XCTAssertEqual(subjects(), ["feat: one", "feat: two", "feat: three"])
    }

    /// A todo of bare `<verb> <sha>` lines — no subjects — is accepted. This is what lets the
    /// writer ignore git's own `pick <sha> # <subject>` format entirely.
    func testATodoWithNoSubjectsIsAccepted() {
        let rows = RebasePlan.rows(from: branchCommits())
        let todo = RebasePlan.todo(for: rows)
        XCTAssertFalse(todo.contains("feat:"), "the todo must carry no subjects")
        var reordered = rows
        reordered.swapAt(0, 1)
        XCTAssertTrue(RebaseRunner.apply(cwd: repo, base: "main", rows: reordered).isOK)
        XCTAssertEqual(subjects(), ["feat: two", "feat: three", "feat: one"])
    }

    func testDropRemovesACommitAndItsFile() {
        var rows = RebasePlan.rows(from: branchCommits())
        rows[1].verb = .drop     // "feat: two"

        XCTAssertTrue(RebaseRunner.apply(cwd: repo, base: "main", rows: rows).isOK)
        XCTAssertEqual(subjects(), ["feat: three", "feat: one"])
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: (repo as NSString).appendingPathComponent("two.txt")))
    }

    /// `fixup` folds and keeps the base commit's message, so no editor is involved.
    func testFixupFoldsIntoTheCommitBelowIt() {
        var rows = RebasePlan.rows(from: branchCommits())
        rows[0].verb = .fixup    // "feat: three" folds into "feat: two"

        XCTAssertTrue(RebaseRunner.apply(cwd: repo, base: "main", rows: rows).isOK)
        XCTAssertEqual(subjects(), ["feat: two", "feat: one"])
        // The folded commit's content survives even though its message did not.
        XCTAssertTrue(FileManager.default.fileExists(
            atPath: (repo as NSString).appendingPathComponent("three.txt")))
    }

    /// The one-message path: `GIT_EDITOR="cp '<file>'"`, no tty.
    func testRewordSubstitutesTheMessage() {
        var rows = RebasePlan.rows(from: branchCommits())
        rows[0].verb = .reword
        rows[0].message = "docs: a much better subject"

        XCTAssertTrue(RebaseRunner.apply(cwd: repo, base: "main", rows: rows).isOK)
        XCTAssertEqual(subjects(), ["docs: a much better subject", "feat: two", "feat: one"])
    }

    /// A squash combines two commits under the supplied message.
    func testSquashCombinesUnderTheSuppliedMessage() {
        var rows = RebasePlan.rows(from: branchCommits())
        rows[0].verb = .squash
        rows[0].message = "feat: two and three together"

        XCTAssertTrue(RebaseRunner.apply(cwd: repo, base: "main", rows: rows).isOK)
        XCTAssertEqual(subjects(), ["feat: two and three together", "feat: one"])
    }

    /// A refused plan must not reach git at all — no rebase started, nothing to abort.
    func testABlockedPlanIsRefusedBeforeGitRuns() {
        let head = git("rev-parse", "HEAD")
        var rows = RebasePlan.rows(from: branchCommits())
        rows[2].verb = .squash   // oldest — nothing to squash into

        let result = RebaseRunner.apply(cwd: repo, base: "main", rows: rows)
        XCTAssertFalse(result.isOK)
        XCTAssertEqual(result.errorText, "the first commit has nothing to squash into")
        XCTAssertEqual(git("rev-parse", "HEAD"), head, "HEAD must not have moved")
        XCTAssertFalse(midRebase)
    }

    func testANoOpPlanIsRefused() {
        let head = git("rev-parse", "HEAD")
        let result = RebaseRunner.apply(cwd: repo, base: "main",
                                        rows: RebasePlan.rows(from: branchCommits()))
        XCTAssertFalse(result.isOK)
        XCTAssertEqual(result.errorText, "nothing to apply")
        XCTAssertEqual(git("rev-parse", "HEAD"), head)
    }

    /// A conflicting reorder stops mid-rebase rather than failing outright — which is the
    /// hand-off to the existing Continue seam.
    func testAConflictingReorderStopsMidRebase() {
        // A fourth commit that edits one.txt, moved below the commit that creates it.
        write("one.txt", "one, edited\n")
        git("commit", "-am", "feat: edit one")

        var rows = RebasePlan.rows(from: branchCommits())
        // Put the edit (newest, index 0) at the bottom so it is replayed before one.txt exists.
        let edit = rows.removeFirst()
        rows.append(edit)

        _ = RebaseRunner.apply(cwd: repo, base: "main", rows: rows)
        // Either git stopped for us to resolve, or it applied cleanly; both are fine outcomes
        // for git to choose, but a stop must be *visible* as a stop.
        if midRebase {
            XCTAssertEqual(ConflictReader.read(cwd: repo).state.operation, .rebase)
        }
        git("rebase", "--abort")
    }
}
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && xcodegen generate
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test \
  -only-testing:ShepherdModelTests/RebasePlanIntegrationTests 2>&1 | tail -20
```
Expected: FAIL — `cannot find 'RebaseRunner' in scope`.

- [ ] **Step 3: Write `RebaseRunner`**

Create `spike/seam1/Sources/Workbench/RebaseRunner.swift`:

```swift
import Foundation

/// Starts an interactive rebase from a plan.
///
/// The whole trick, and it is the same one `SequenceRunner` already uses for `GIT_EDITOR`:
/// **`GIT_SEQUENCE_EDITOR` is a command string git appends the todo path to**, so
/// `cp '<our todo>'` becomes `cp '<our todo>' <git's todo>` — a substitution needing no tty.
/// Verified against git 2.55, including a path containing a space.
///
/// Left alone this is not a failure but a **hang**: an app-spawned `Process` has no tty, so
/// git's default editor waits forever holding the session's `writing` flag. That is the
/// recorded lesson from `GIT_EDITOR`, and it applies identically here.
enum RebaseRunner {

    /// Apply a plan. Refuses before git runs when the plan is not applyable, so a bad plan
    /// leaves nothing to abort.
    static func apply(cwd: String, base: String, rows: [PlanRow]) -> GitResult {
        let original = rows.map(\.commit)
        // `original` is the row order, so `isNoOp` compares against the plan's own starting
        // point — the caller holds the real original and checks it for the button state; this
        // guard exists so no path can start a rebase the model already refused.
        if let reason = RebasePlan.blockedReason(rows: rows, original: original) {
            return .failed(reason)
        }
        let todo = RebasePlan.todo(for: rows)
        guard !todo.isEmpty else { return .failed("every commit is dropped") }

        let temp = FileManager.default.temporaryDirectory
            .appendingPathComponent("shepherd-todo-\(UUID().uuidString).txt")
        do {
            try todo.write(to: temp, atomically: true, encoding: .utf8)
        } catch {
            return .failed("Could not stage the rebase plan: \(error.localizedDescription)")
        }
        defer { try? FileManager.default.removeItem(at: temp) }

        var env = ["GIT_SEQUENCE_EDITOR": "cp '\(temp.path)'"]

        // At most one entry opens an editor — `RebasePlan.blockedReason` enforces it, because
        // one `cp` can substitute exactly one message.
        var messageTemp: URL?
        if let entry = RebasePlan.messageEntry(rows: rows) {
            let file = FileManager.default.temporaryDirectory
                .appendingPathComponent("shepherd-msg-\(UUID().uuidString).txt")
            do {
                try (entry.message + "\n").write(to: file, atomically: true, encoding: .utf8)
            } catch {
                return .failed("Could not stage the commit message: \(error.localizedDescription)")
            }
            messageTemp = file
            env["GIT_EDITOR"] = "cp '\(file.path)'"
        } else {
            // Nothing should open an editor, but `true` rather than nothing at all: if git ever
            // asks, it gets an immediate zero-exit instead of hanging on a tty that is not there.
            env["GIT_EDITOR"] = "true"
        }
        defer { if let messageTemp { try? FileManager.default.removeItem(at: messageTemp) } }

        return GitStaging.run(["rebase", "-i", base], cwd: cwd, env: env)
    }
}
```

- [ ] **Step 4: Run the integration suite**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && xcodegen generate
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test \
  -only-testing:ShepherdModelTests/RebasePlanIntegrationTests 2>&1 | \
  grep -E "Test Case .* passed|failed|TEST" | tail -30
```
Expected: 10 tests passed. **If any of these hangs**, the `GIT_SEQUENCE_EDITOR` env is not
reaching git — check that `GitStaging.run` merges rather than replaces the environment, which
is the recorded trap (replacing it loses `HOME`, and so git's config).

- [ ] **Step 5: Commit**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd && \
git add spike/seam1/Sources/Workbench/RebaseRunner.swift \
        spike/seam1/Tests/RebasePlanIntegrationTests.swift && \
git commit -m "$(cat <<'EOF'
feat(workbench): apply a rewrite plan with no tty

GIT_SEQUENCE_EDITOR gets the same `cp '<file>'` treatment GIT_EDITOR already has:
git appends the todo path to the command string, so a copy substitutes our plan.
Left alone this hangs rather than failing — an app-spawned Process has no tty —
which is the recorded lesson from the message path, arriving one command earlier.

A refused plan never reaches git, so a bad plan leaves nothing to abort. GIT_EDITOR
is set to `true` even when nothing should open an editor: if git ever asks anyway
it gets an immediate zero exit instead of waiting on a terminal that is not there.

The fixture uses one file per commit — the first attempt appended to a single file
and every reorder conflicted with itself, testing nothing about order.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Rewrite mode on the session

**Files:**
- Modify: `spike/seam1/Sources/Workbench/WorkbenchSession.swift`

**Interfaces:**
- Consumes: `RebasePlan`, `PlanRow`, `RebaseVerb` (Task 9); `RebaseRunner.apply` (Task 10).
- Produces: on `WorkbenchSession` — `@Published private(set) var planRows: [PlanRow]?`, `var isRewriting: Bool`, `func beginRewrite()`, `func cancelRewrite()`, `func setVerb(_:forSha:)`, `func setPlanMessage(_:forSha:)`, `func movePlanRow(from:to:)`, `var rewriteBlockedReason: String?`, `func applyRewrite()`.

- [ ] **Step 1: Add the state and the mutations**

In `spike/seam1/Sources/Workbench/WorkbenchSession.swift`, beside the commits state (~line 71):

```swift
    /// The rewrite plan, or nil when not rewriting.
    ///
    /// **An explicit mode, not an always-live affordance.** The list you scroll while reviewing
    /// an agent's work must not be the list where a stray drag rewrites history, so entering
    /// copies `commits` and Apply is the only thing that runs git.
    @Published private(set) var planRows: [PlanRow]?

    var isRewriting: Bool { planRows != nil }

    /// The commits the plan started from, for no-op detection. Captured on entry so a
    /// background `loadCommits()` cannot change what "unchanged" means mid-edit.
    private var planOriginal: [Commit] = []
```

Then the mutations, near `loadCommits()`:

```swift
    /// Enter Rewrite mode. Nothing touches git.
    func beginRewrite() {
        // Rewriting a repo that is mid-sequence would stack one rebase on another, and the
        // lock already forbids leaving Files — this is belt and braces for the same reason.
        guard !isMidSequence, !commits.isEmpty else { return }
        selectCommit(nil)
        planOriginal = commits
        planRows = RebasePlan.rows(from: commits)
    }

    func cancelRewrite() {
        planRows = nil
        planOriginal = []
    }

    func setVerb(_ verb: RebaseVerb, forSha sha: String) {
        guard var rows = planRows, let index = rows.firstIndex(where: { $0.commit.sha == sha })
        else { return }
        rows[index].verb = verb
        // A message only means something for an entry that opens an editor; clearing it on the
        // way out stops a stale one being submitted if the verb comes back later.
        if !verb.needsMessage { rows[index].message = "" }
        planRows = rows
    }

    func setPlanMessage(_ message: String, forSha sha: String) {
        guard var rows = planRows, let index = rows.firstIndex(where: { $0.commit.sha == sha })
        else { return }
        rows[index].message = message
        planRows = rows
    }

    /// Reorder. Indices are into the **displayed** (newest-first) order; `RebasePlan.todo`
    /// inverts on the way out, and nothing here should second-guess that.
    func movePlanRow(from source: Int, to destination: Int) {
        guard var rows = planRows, rows.indices.contains(source) else { return }
        let clamped = max(0, min(destination, rows.count))
        let row = rows.remove(at: source)
        rows.insert(row, at: clamped > source ? clamped - 1 : clamped)
        planRows = rows
    }

    /// Why Apply is disabled, or nil when the plan may run. Never nil when it cannot.
    var rewriteBlockedReason: String? {
        guard let planRows else { return "not rewriting" }
        if writing { return "git is running" }
        return RebasePlan.blockedReason(rows: planRows, original: planOriginal)
    }

    /// Run the plan.
    ///
    /// Then `loadConflicts()` and nothing else, which is the whole of the stop handling: a
    /// conflicting pick fills `mergeFiles`, the lock re-engages, the scope forces to Files and
    /// the existing Continue drives the rest. A stopped `rebase -i` is structurally identical
    /// to the stopped plain rebase already handled — git 2.55 runs both through the merge
    /// backend and writes the same `rebase-merge` directory.
    func applyRewrite() {
        guard let rows = planRows, rewriteBlockedReason == nil,
              let base = baseName else { return }
        let cwd = self.cwd
        lastError = nil
        writing = true
        // Every sha is about to change, so every file's blame is against the wrong history.
        invalidateBlame()
        DispatchQueue.global(qos: .userInitiated).async {
            let result = RebaseRunner.apply(cwd: cwd, base: base, rows: rows)
            DispatchQueue.main.async {
                self.writing = false
                // Not every non-zero exit is a failure worth these words: a rebase that stops
                // at a conflict exits non-zero, and `loadConflicts` is about to explain that
                // far better than git's stderr does. Only report when nothing is in flight.
                let stopped = ConflictReader.read(cwd: cwd).state.isActive
                self.lastError = stopped ? nil : result.errorText
                // Rewrite mode is over either way: if the rebase stopped, the remaining todo is
                // git's, not ours, and the sequence panel owns the screen.
                self.planRows = nil
                self.planOriginal = []
                self.loadConflicts()
                self.load()
                self.loadCommits()
            }
        }
    }
```

**Note on the `ConflictReader.read` call above:** it runs on the background queue, before
hopping back — read the surrounding code and keep it there. It is a `Process` call, and moving
it inside the `DispatchQueue.main.async` block would put git on the main thread, which is the
rule `GitStaging`'s own doc comment sets.

- [ ] **Step 2: Clear the plan when the scope changes**

In `setScope`, in the `.commits` arm beside the `sourceRef` reset from Task 8:

```swift
            if isRewriting { cancelRewrite() }
```

and in the same function's general path — a plan must not survive leaving the scope. The
existing `if next != .commits { selectCommit(nil) }` line is the right neighbour:

```swift
        if next != .commits {
            selectCommit(nil)
            cancelRewrite()
        }
```

- [ ] **Step 3: Build**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test 2>&1 | tail -30
```
Expected: `** TEST SUCCEEDED **`, suite green.

- [ ] **Step 4: Commit**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd && \
git add spike/seam1/Sources/Workbench/WorkbenchSession.swift && \
git commit -m "$(cat <<'EOF'
feat(workbench): rewrite-mode state, and Apply

An explicit mode: entering copies the commit list and nothing else happens, so the
list you scroll while reviewing is not the list where a stray drag rewrites
history. The starting commits are captured on entry, so a background loadCommits
cannot change what "unchanged" means while you edit.

Apply then calls loadConflicts and nothing else — a stopped `rebase -i` is
structurally identical to the stopped plain rebase W5a already handles. A non-zero
exit is only reported when nothing is in flight: a rebase that stops at a conflict
also exits non-zero, and the panel explains it better than git's stderr.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Rewrite mode in the rail

**Files:**
- Modify: `spike/seam1/Sources/Workbench/WorkbenchView.swift` (`commitsRail`)

**Interfaces:**
- Consumes: `session.planRows`, `session.isRewriting`, `session.beginRewrite()`, `.cancelRewrite()`, `.setVerb(_:forSha:)`, `.setPlanMessage(_:forSha:)`, `.movePlanRow(from:to:)`, `.rewriteBlockedReason`, `.applyRewrite()`.
- Produces: no new API.

- [ ] **Step 1: Branch the rail on the mode**

In `commitsRail`'s list branch, wrap the existing content so Rewrite mode replaces it:

```swift
                LazyVStack(alignment: .leading, spacing: 0) {
                    if let rows = session.planRows {
                        rewriteHeader
                        ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                            planRowView(row, index: index, count: rows.count)
                        }
                        rewriteFooter
                    } else {
                        sourcePicker
                        // …the Task 8 body, unchanged…
                    }
                }
```

and add the `Rewrite` entry point to the non-rewriting branch, directly after `sourcePicker`:

```swift
                        rewriteEntryRow
```

- [ ] **Step 2: Add the views**

```swift
    /// Entering is a deliberate act, so it gets its own row rather than living on each commit.
    @ViewBuilder private var rewriteEntryRow: some View {
        if session.sourceRef == nil, !session.commits.isEmpty, !session.isMidSequence {
            HStack(spacing: 0) {
                Button { session.beginRewrite() } label: {
                    Text("Rewrite…")
                        .font(.ui(10, .medium)).foregroundStyle(Theme.textSecondary)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Theme.surface2)
                        .clipShape(RoundedRectangle(cornerRadius: 4))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).focusable(false)
                .help("Reorder, squash, reword or drop these commits")
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12).padding(.bottom, 4)
        }
    }

    private var rewriteHeader: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("REWRITE").font(.ui(9.5, .semibold)).foregroundStyle(Theme.blocked)
            Text("Drag to reorder. Nothing runs until Apply.")
                .font(.ui(9)).foregroundStyle(Theme.textDim)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 4)
    }

    /// One planned commit: a verb menu, the subject, and a message field when the verb needs
    /// one. Reordering is buttons rather than a drag gesture — the rail is a custom
    /// `ScrollView`, not a `List`, so `onMove` does not exist here and a hand-rolled drag is
    /// its own task. Buttons are unambiguous and keyboard-reachable.
    private func planRowView(_ row: PlanRow, index: Int, count: Int) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .top, spacing: 6) {
                VStack(spacing: 0) {
                    moveButton(up: true, enabled: index > 0) {
                        session.movePlanRow(from: index, to: index - 1)
                    }
                    moveButton(up: false, enabled: index < count - 1) {
                        session.movePlanRow(from: index, to: index + 2)
                    }
                }
                Menu {
                    ForEach(RebaseVerb.allCases, id: \.self) { verb in
                        Button(verb.title) { session.setVerb(verb, forSha: row.commit.sha) }
                    }
                } label: {
                    Text(row.verb.title)
                        .font(.mono(10))
                        .foregroundStyle(row.verb == .drop ? Theme.error : Theme.textSecondary)
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .focusable(false)
                .help(row.verb.help)

                VStack(alignment: .leading, spacing: 1) {
                    Text(row.commit.subject)
                        .font(.ui(11, row.verb == .drop ? .regular : .medium))
                        .foregroundStyle(row.verb == .drop ? Theme.textDim : Theme.textPrimary)
                        .strikethrough(row.verb == .drop)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                        .multilineTextAlignment(.leading)
                    Text(row.commit.shortSha).font(.mono(9)).foregroundStyle(Theme.textDim)
                }
                Spacer(minLength: 0)
            }
            // Collected before Apply, because `cp '<file>'` substitutes exactly one message —
            // a rebase that stops to ask a question is the failure mode this avoids.
            if row.verb.needsMessage {
                TextField("new message", text: Binding(
                    get: { row.message },
                    set: { session.setPlanMessage($0, forSha: row.commit.sha) }
                ))
                .textFieldStyle(.plain)
                .font(.mono(10))
                .padding(.horizontal, 5).padding(.vertical, 3)
                .background(Theme.surface2)
                .clipShape(RoundedRectangle(cornerRadius: 4))
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 4)
    }

    private func moveButton(up: Bool, enabled: Bool,
                            _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: up ? "chevron.up" : "chevron.down")
                .font(.system(size: 7, weight: .semibold))
                .foregroundStyle(enabled ? Theme.textSecondary : Theme.textDim.opacity(0.4))
                .frame(width: 12, height: 10)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).focusable(false).disabled(!enabled)
    }

    private var rewriteFooter: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Button { session.applyRewrite() } label: {
                    Text("Apply")
                        .font(.ui(11, .semibold))
                        .foregroundStyle(session.rewriteBlockedReason == nil
                                         ? Theme.working : Theme.textDim)
                        .padding(.horizontal, 10).padding(.vertical, 4)
                        .background((session.rewriteBlockedReason == nil
                                     ? Theme.working : Theme.textDim).opacity(0.14))
                        .clipShape(RoundedRectangle(cornerRadius: 5))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).focusable(false)
                .disabled(session.rewriteBlockedReason != nil)
                .help(session.rewriteBlockedReason ?? "Rewrite these commits")
                Button { session.cancelRewrite() } label: {
                    Text("Cancel").font(.ui(10)).foregroundStyle(Theme.textDim)
                }
                .buttonStyle(.plain).focusable(false)
                Spacer(minLength: 0)
            }
            // The reason is visible, not only on hover: a disabled button whose explanation
            // needs a mouse is a dead button to anyone driving by keyboard.
            if let reason = session.rewriteBlockedReason, reason != "not rewriting" {
                Text(reason)
                    .font(.ui(9)).foregroundStyle(Theme.textDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text("Every commit gets a new sha, which clears the branch's PR review state.")
                .font(.ui(9)).foregroundStyle(Theme.textDim)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 4)
    }
```

- [ ] **Step 3: Build**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd/spike/seam1 && \
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache test 2>&1 | tail -30
```
Expected: `** TEST SUCCEEDED **`, suite green.

- [ ] **Step 4: Commit**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd && \
git add spike/seam1/Sources/Workbench/WorkbenchView.swift && \
git commit -m "$(cat <<'EOF'
feat(workbench): Rewrite mode — the commit list as a rebase todo

The list W5a already shows is exactly a rebase todo's contents, so rewriting is
that list with a verb per row. An explicit mode behind a Rewrite button, because
the list you scroll while reviewing must not be the one a stray drag rewrites.

Reorder is buttons, not a drag: the rail is a custom ScrollView rather than a
List — deliberately, since List was a keyboard-focus sink — so `onMove` does not
exist here and a hand-rolled drag is its own piece of work. The blocked reason
renders as text as well as a tooltip; hover-only explanation is a dead button to
anyone on the keyboard. The footer says out loud that every sha changes.

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

In the progress block, close out W5b and recompute the overall bar:

```
W5b power tools            ██████████████████████  100%   stash, cherry-pick, rewrite mode
                           ──────────────────────
    overall                ██████████████████████  100%
```

Replace the "## W5b — Power tools (remaining)" section with a **W5b as built** section
recording: that this adds starters rather than an engine, and why; the measured git facts table
from this plan's header; that a stash is a 3-parent merge commit and therefore reads through
`readCommit` unchanged; that the todo is only ever *written*, never parsed; the one-message rule
and its reason; that `.loose` was a defect in the shipped build rather than a new feature; and
that cherry-pick progress is `N remaining` because no denominator exists. Then a short
**Deferred from W5b** section carrying the spec's deferred list verbatim.

- [ ] **Step 2: Add the gotchas to `CLAUDE.md`**

In the workbench section, describe Rewrite mode, the cherry-pick source picker and the STASHES
section in the existing voice. Add these to "Critical gotchas":

- **A conflicted stash apply is not a sequence.** It leaves unmerged files with **no**
  `MERGE_HEAD` / `CHERRY_PICK_HEAD` / `rebase-merge` / `sequencer`, so `mergeState.isActive` is
  false while `hasConflicts` is true. `SequencePolicy.context` names that `.loose`: no Continue
  (there is nothing to continue), and the exit is per-path `git checkout HEAD -- <paths>`, never
  `reset --hard`, which would take unrelated work that was never at risk.
- **A stash is a 3-parent merge commit**, so `DiffReader.readCommit` reads one unchanged — the
  `-m --first-parent` added for merge commits is what makes it work. Files stashed with `-u`
  live in the **third** parent and appear nowhere in the first-parent diff; they are listed, not
  drawn. `selectStash` funnels through `selectCommit` so `historicalSha` stays the only
  provenance state.
- **`GIT_SEQUENCE_EDITOR` takes the same `cp '<file>'` substitution `GIT_EDITOR` does**, and
  left alone it **hangs** rather than failing — no tty. `RebaseRunner` sets both, `GIT_EDITOR` to
  `true` even when nothing should ask.
- **A rebase todo's subject is decoration.** git 2.55 writes `pick <shortsha> # <subject>`, and a
  todo of bare `pick <sha>` lines rebases correctly — so `RebasePlan` only ever *writes* a todo
  and nothing parses git's format. **It emits oldest-first, the reverse of the rail**; the
  inversion is the `SplitAxis` trap again and is pinned by tests both pure and real-git.
- **One reword-or-squash per rewrite plan**, because one `cp` substitutes one message. `fixup`
  keeps the base commit's message, opens no editor, and is therefore unlimited.
- **A cherry-pick sequence has no `msgnum`/`end` and no record of its original total** — the
  `sequencer/todo` shrinks in place. `MergeProgress.remaining` exists for that; a denominator
  would be cached sequence state an abort in a terminal pane invalidates.

- [ ] **Step 3: Commit the docs**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd && \
git add CLAUDE.md docs/superpowers/plans/2026-07-26-unified-workbench-w1-w5-roadmap.md && \
git commit -m "$(cat <<'EOF'
docs(workbench): W5b as built; the workbench is done

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Run it in ShepherdDev — a required gate, not a formality**

Eleven defects in W1's first live run, nine across W3/W4, and W5a's own gate found more. **None
were visible to `xcodebuild` or to a green suite.** Drag-free reordering, a verb menu, three
confirmation dialogs and a locked-with-no-exit panel are all in the class only a person pressing
things can check. **W5b does not merge on green tests plus a clean build.**

```bash
cd /Users/eshaannileshshah/Home/dev/tools/shepherd && scripts/dev.sh
```

`scripts/dev.sh` builds reliably but its `open` loses the LaunchServices `-600` race perhaps half
the time — check `pgrep -x ShepherdDev` and re-`open` rather than assuming it relaunched. **Never
`killall Shepherd`**; `killall ShepherdDev` is the dev app only.

Rebuild the fixtures first:

```bash
~/Home/dev/tools/shepherd-w5b-fixture/setup.sh
```

Then check, in `ShepherdDev`:

**Loose conflicts** — in a throwaway repo, or `shepherd-w5b-fixture/rebase` after aborting:
1. Stash something, commit a conflicting change to the same line, then `git stash pop` in the
   pane. `⌘G` → the workbench locks to Files, the banner reads **"1 conflict · no operation in
   progress"**, and there is **no Continue and no Abort**. Confirm the explanation is on screen,
   not only in a tooltip.
2. Resolve the file → the lock lifts by itself, no Continue needed.
3. Redo it, then use **Discard changes…**. Confirm the dialog names the file, promises other
   modified files are untouched, mentions the surviving stash, and that an unrelated dirty file
   really does survive.

**Stash** — in `shepherd-w5b-fixture/history`:
4. Make an edit and use **Stash** beside Commit. The commit draft becomes the stash message and
   the tree goes clean. Repeat with *Stash staged only* and *Stash, including untracked*.
5. `⌃4` → STASHES shows them. Click one → its diff renders read-only with the header saying so
   and **no stage buttons**. For the `-u` one, confirm the untracked path is **listed** as "not
   previewed" and does not appear as diff rows.
6. **Expand a hunk gap inside a stash view** — the same provenance check W5a's gate makes for a
   commit, on the newest document type. The revealed lines must belong to the stash.
7. Apply / Pop / Drop. Confirm Drop asks, and that a pop consuming its entry removes the row.

**Cherry-pick** — in the shepherd repo itself, which has dozens of branches:
8. `⌃4` → `from:` lists branches newest-first with checked-out ones marked. Pick one → its
   commits list; confirm a branch with nothing new says so rather than showing an empty rail.
9. Click a source commit → read-only preview. Tick two, **Cherry-pick 2** → they land in
   **oldest-first** order (check `git log`). Confirm the counter reads `N remaining` if it stops.
10. Force a conflict, then drive resolve → Continue to the end.

**Rewrite mode** — in `shepherd-w5b-fixture/history` (four commits, one file each region):
11. `Rewrite…` → verbs and move buttons appear; Apply is disabled reading **"nothing to
    apply"**.
12. Reorder two commits, Apply, and confirm `git log` shows the **intended** order — not the
    reverse. **This is the single most important check here**; a reversed branch is the failure
    mode the inversion tests exist for, and it is worth confirming once by eye.
13. `fixup` a commit into the one below it → they fold, keeping the lower commit's message.
14. `reword` one → the message field appears, Apply is blocked until it has text, and the
    resulting commit carries it.
15. Two rewords → Apply is blocked reading **"one reword or squash per rewrite…"**. Drop every
    commit → blocked reading **"every commit is dropped"**. Make the *bottom* row a squash →
    blocked reading **"the first commit has nothing to squash into"**.
16. Force a conflicting reorder → the rebase stops, Rewrite mode exits, the sequence panel takes
    over, and resolve → Continue finishes it. Confirm no scope is reachable while stopped.
17. Leave the scope mid-plan (`⌃2`) and come back — the plan is gone, not half-remembered.

- [ ] **Step 5: Hand the branch over**

Report what was checked and what was found. Per the project's ship workflow, merging to local
`master`, rebuilding, resigning and pushing happen **only when the user asks**.

---

## Self-review

**Spec coverage.** § 1 Rewrite mode → Tasks 9 (plan + validity + inversion), 10 (apply, real
git), 11 (session state), 12 (rail UI); the one-message rule → Task 9's `blockedReason` and
Task 10's `RebaseRunner`; the no-op refusal → Task 9. § 2 cherry-pick → Task 6 (ref list, range
generalization), 8 (runner, picker, oldest-first reversal); the missing progress counter →
Task 7. § 3 stash → Tasks 3 (pure list + args), 4 (runner, the readCommit reuse, session), 5
(rail section, Stash button); untracked-listed-not-previewed → Tasks 3, 4, 5. § 4 loose
conflicts → Tasks 1 (pure context + copy), 2 (`restoreFiles`, session action, panel); the stash
note in the confirmation → Task 4 Step 8. New-units table → Tasks 1, 3, 4, 6, 7, 8, 9, 10.
Testing section → the per-task cycles plus the three real-git suites. The human gate → Task 13.

Deliberately **not** implemented, matching the spec's deferred list: several message-editing
entries per plan, `edit` / `break`, `rebase --edit-todo`, `--autosquash`, splitting a commit,
rebasing onto a different base, full-history browsing past one picked ref, previewing a stash's
untracked files as rows, `git stash branch`, and `--index` on apply.

**Type consistency.** `ConflictContext` / `SequencePolicy.context(operation:hasConflicts:)` keep
the same labels in Tasks 1, 2 and the CLAUDE.md note. `GitStaging.restoreFiles(_:cwd:)` is
spelled the same in Tasks 2 and its test. `StashList.parse` / `pushArguments(message:scope:)` /
`applyArguments(ref:pop:)` / `dropArguments(ref:)` / `untrackedArguments(ref:)` match between
Tasks 3, 4 and 5, and `StashScope`'s cases (`all` / `stagedOnly` / `includingUntracked`) are
used identically in Tasks 3, 4 and 5. `Stash.ref` drives commands while `Stash.id` is the sha,
consistently. `RefList.arguments()` / `parse(_:currentBranch:)` and `Ref.isCheckedOut` match
between Tasks 6 and 8. `CommitHistory.logArguments(range:)` is introduced in Task 6 and consumed
in Task 8. `MergeProgress.counted(done:total:)` / `.remaining(_)` / `.text` are used identically
in Task 7 and its two test edits. `RebaseVerb` / `PlanRow(commit:verb:message:)` /
`RebasePlan.rows(from:)` / `todo(for:)` / `isNoOp(rows:original:)` /
`blockedReason(rows:original:)` / `messageEntry(rows:)` keep the same labels across Tasks 9, 10,
11 and 12. `RebaseRunner.apply(cwd:base:rows:)` is spelled the same in Tasks 10 and 11.
`session.movePlanRow(from:to:)` takes displayed-order indices in both Tasks 11 and 12, and
Task 12's down-button passes `index + 2` because the mutation removes before inserting.

**Three places the plan is deliberately instructional rather than literal**, because the exact
surrounding code must be read first: the merge-section insertion in Task 2 Step 6 (which names
the invariant — the Continue/Abort block stays gated on `isActive`), the `commitsRail`
restructuring in Tasks 8 and 12 (which quotes the current body and names what replaces it), and
the two `SequenceIntegrationTests` assertions in Task 7 Step 4 (which says to keep the numbers
already there if they differ from the ones shown). Each names the precise transformation and the
invariant to preserve.

**~~One known imprecision~~ — this was a bug, and executing Task 10 found it.** The plan had
`RebaseRunner.apply` derive `original` from the rows themselves and called that harmless, on the
reasoning that the session does the real no-op check. It is not harmless: a reorder changes
neither the verbs nor the set of shas, so comparing a plan against itself makes **every
reorder-only plan** read as "nothing to apply" — the feature's main case, rejected before git
ran. `testANoOpPlanIsRefused` passed throughout, which is exactly what hid it; only
`testReversingTheRailReversesTheHistory` caught it.

`apply` now takes `original: [Commit]` as a required parameter, because it cannot be derived.
The lesson generalizes: a guard whose input is reconstructed from the thing it is guarding is
not a guard.
