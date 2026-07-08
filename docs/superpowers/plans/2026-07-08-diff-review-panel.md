# Diff Review Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An in-app native SwiftUI panel that shows the focused pane's git diff (working-tree ⇄ branch-vs-base), syntax-highlighted, and lets you leave PR-style comments that batch into one prompt injected back to that pane's agent.

**Architecture:** A pure `DiffModel` + parser (no AppKit, unit-tested) is the core everything consumes. `DiffReader` shells out to `git` in a pane's cwd. `DiffReviewModel` (`@MainActor`) holds panel state and reads through `DiffReader`. `DiffPanelView` renders, using HighlighterSwift for syntax colors layered over diff-semantic backgrounds. Comment submission reuses the per-pane `NotificationCenter` surface channel to inject text into the live PTY.

**Tech Stack:** Swift 5, SwiftUI + AppKit, libghostty (GhosttyKit), HighlighterSwift (new SPM dep), xcodegen, XCTest.

## Global Constraints

- Deployment target **macOS 13.0** — `.onKeyPress` (macOS 14+) is unavailable; use `NSEvent` monitors for key handling in SwiftUI.
- Build is via **xcodegen**: run `xcodegen generate` after adding/removing any source file, before `xcodebuild`.
- Pure models (unit-tested) go in the **`ShepherdModelTests`** target's explicit `sources:` list in `project.yml`. **HighlighterSwift must NOT be linked into that target** — keep `DiffModel` dependency-free; highlighting is view-layer only.
- Do **not** `killall`/relaunch the running app — the user runs Shepherd as their daily terminal. Verify by compile + unit tests; the user drives runtime checks.
- All C API calls (`ghostty_surface_*`) happen on the **main thread**.
- Sidebar/panel SwiftUI controls stay `.focusable(false)` so keystrokes aren't stolen from the PTY (ADR 0009) — the diff panel's comment field is the one intentional exception while it has focus.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Keybinding: **⌘G toggles the diff panel**. Find Next/Previous lose their ⌘G/⌘⇧G bindings and move to **Return / Shift-Return** inside the open search field.
- Build command (from `spike/seam1`):
  ```
  xcodegen generate && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
    -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build
  ```
- Test command (from `spike/seam1`):
  ```
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
    -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO test -only-testing:ShepherdModelTests
  ```

---

## File Structure

**New (`spike/seam1/Sources/`):**
- `DiffModel.swift` — pure model (`DiffLine`/`DiffHunk`/`DiffFile`/`DiffStatus`/`DiffSide`), `DiffParser.parse`, `ReviewComment`, `ReviewPrompt.compose`, `HighlightMap.sourceLine`. No AppKit.
- `DiffReader.swift` — `DiffMode`, `DiffReadResult`, `DiffReader.read` + `DiffReader.fileBlob` (git subprocess). App target only.
- `DiffPanelView.swift` — `DiffPanelView` + `DiffReviewModel` (`@MainActor ObservableObject`) + `DiffSyntaxHighlighter`. App target; imports HighlighterSwift (module `Highlighter`).

**New (`spike/seam1/Tests/`):**
- `DiffModelTests.swift` — parser, prompt composition, highlight-map mapping.

**Modified:**
- `project.yml` — add HighlighterSwift SPM package to the `Shepherd` target; add `Sources/DiffModel.swift` to the `ShepherdModelTests` `sources:` list.
- `Sources/ShepherdApp.swift` — add ⌘G "Review Diff" command; remove the ⌘G/⌘⇧G Find Next/Previous commands.
- `Sources/SplitContainer.swift` — `PaneSearchOverlay`: add Shift-Return → previous.
- `Sources/GhosttyTerminal.swift` — add `shepherdInjectText` notification + observer that injects text via `ghostty_surface_key`; add `static func perform(paneID:injectText:)`.
- `Sources/AgentStore.swift` — `diffPanelOpen`/`diffPanelPaneID`/`diffTurnTick`/`diffTurnPane` published state; `toggleDiffPanel()`, `pane(_:)`, `hasLiveAgent(paneID:)`, `injectText(_:intoPane:)`, `submitReview(_:toPane:)`; emit the turn-ended signal in `apply`.
- `Sources/ContentView.swift` — mount `DiffPanelView` as a resizable right-hand panel when `store.diffPanelOpen`.

---

## Task 1: DiffModel — pure model + unified-diff parser

**Files:**
- Create: `spike/seam1/Sources/DiffModel.swift`
- Test: `spike/seam1/Tests/DiffModelTests.swift`
- Modify: `spike/seam1/project.yml` (add `Sources/DiffModel.swift` to `ShepherdModelTests` sources)

**Interfaces:**
- Produces:
  - `enum DiffLineKind { case context, added, removed }`
  - `enum DiffSide { case old, new }`
  - `struct DiffLine: Equatable { let kind: DiffLineKind; let text: String; let oldLineNo: Int?; let newLineNo: Int? }`
  - `struct DiffHunk: Equatable { let header: String; let oldStart, oldCount, newStart, newCount: Int; let lines: [DiffLine] }`
  - `enum DiffStatus: Equatable { case added, modified, deleted, renamed }`
  - `struct DiffFile: Equatable { let path: String; let oldPath: String?; let status: DiffStatus; let isBinary: Bool; let hunks: [DiffHunk]; let addedCount: Int; let removedCount: Int }`
  - `enum DiffParser { static func parse(_ unified: String) -> [DiffFile] }`

- [ ] **Step 1: Add DiffModel.swift to the test target in project.yml**

In `spike/seam1/project.yml`, under `ShepherdModelTests: > sources:`, add after the `Sources/StopPolicy.swift` line:

```yaml
      - path: Sources/DiffModel.swift
```

- [ ] **Step 2: Write the failing tests**

Create `spike/seam1/Tests/DiffModelTests.swift`:

```swift
import XCTest
@testable import Shepherd

final class DiffModelTests: XCTestCase {
    func test_parsesSingleModifiedFileWithOneHunk() {
        let diff = """
        diff --git a/foo.txt b/foo.txt
        index 0000001..0000002 100644
        --- a/foo.txt
        +++ b/foo.txt
        @@ -1,3 +1,3 @@
         one
        -two
        +TWO
         three
        """
        let files = DiffParser.parse(diff)
        XCTAssertEqual(files.count, 1)
        let f = files[0]
        XCTAssertEqual(f.path, "foo.txt")
        XCTAssertNil(f.oldPath)
        XCTAssertEqual(f.status, .modified)
        XCTAssertFalse(f.isBinary)
        XCTAssertEqual(f.addedCount, 1)
        XCTAssertEqual(f.removedCount, 1)
        XCTAssertEqual(f.hunks.count, 1)
        let h = f.hunks[0]
        XCTAssertEqual(h.oldStart, 1); XCTAssertEqual(h.newStart, 1)
        XCTAssertEqual(h.lines.map(\.kind),
                       [.context, .removed, .added, .context])
        // Line numbering: context "one" is old1/new1; removed "two" is old2/nil;
        // added "TWO" is nil/new2; context "three" is old3/new3.
        XCTAssertEqual(h.lines[0].oldLineNo, 1); XCTAssertEqual(h.lines[0].newLineNo, 1)
        XCTAssertEqual(h.lines[1].oldLineNo, 2); XCTAssertNil(h.lines[1].newLineNo)
        XCTAssertNil(h.lines[2].oldLineNo);      XCTAssertEqual(h.lines[2].newLineNo, 2)
        XCTAssertEqual(h.lines[3].oldLineNo, 3); XCTAssertEqual(h.lines[3].newLineNo, 3)
    }

    func test_parsesAddedFile() {
        let diff = """
        diff --git a/new.txt b/new.txt
        new file mode 100644
        index 0000000..0000003
        --- /dev/null
        +++ b/new.txt
        @@ -0,0 +1,2 @@
        +alpha
        +beta
        """
        let f = DiffParser.parse(diff)[0]
        XCTAssertEqual(f.status, .added)
        XCTAssertEqual(f.addedCount, 2)
        XCTAssertEqual(f.removedCount, 0)
    }

    func test_parsesDeletedFile() {
        let diff = """
        diff --git a/gone.txt b/gone.txt
        deleted file mode 100644
        index 0000004..0000000
        --- a/gone.txt
        +++ /dev/null
        @@ -1,1 +0,0 @@
        -bye
        """
        let f = DiffParser.parse(diff)[0]
        XCTAssertEqual(f.status, .deleted)
        XCTAssertEqual(f.removedCount, 1)
    }

    func test_parsesRename() {
        let diff = """
        diff --git a/old/name.rb b/new/name.rb
        similarity index 92%
        rename from old/name.rb
        rename to new/name.rb
        index 0000005..0000006 100644
        --- a/old/name.rb
        +++ b/new/name.rb
        @@ -1,1 +1,1 @@
        -x = 1
        +x = 2
        """
        let f = DiffParser.parse(diff)[0]
        XCTAssertEqual(f.status, .renamed)
        XCTAssertEqual(f.oldPath, "old/name.rb")
        XCTAssertEqual(f.path, "new/name.rb")
    }

    func test_parsesBinaryFile() {
        let diff = """
        diff --git a/logo.png b/logo.png
        index 0000007..0000008 100644
        Binary files a/logo.png and b/logo.png differ
        """
        let f = DiffParser.parse(diff)[0]
        XCTAssertTrue(f.isBinary)
        XCTAssertTrue(f.hunks.isEmpty)
    }

    func test_parsesMultipleFilesAndHunks() {
        let diff = """
        diff --git a/a.txt b/a.txt
        index 1..2 100644
        --- a/a.txt
        +++ b/a.txt
        @@ -1,1 +1,1 @@
        -a
        +A
        diff --git a/b.txt b/b.txt
        index 3..4 100644
        --- a/b.txt
        +++ b/b.txt
        @@ -1,1 +1,1 @@
        -b
        +B
        @@ -5,1 +5,1 @@
        -e
        +E
        """
        let files = DiffParser.parse(diff)
        XCTAssertEqual(files.map(\.path), ["a.txt", "b.txt"])
        XCTAssertEqual(files[1].hunks.count, 2)
    }

    func test_handlesNoNewlineAtEOFMarker() {
        let diff = """
        diff --git a/n.txt b/n.txt
        index 1..2 100644
        --- a/n.txt
        +++ b/n.txt
        @@ -1,1 +1,1 @@
        -old
        \\ No newline at end of file
        +new
        \\ No newline at end of file
        """
        let f = DiffParser.parse(diff)[0]
        // The "\ No newline" markers are not diff lines.
        XCTAssertEqual(f.hunks[0].lines.map(\.kind), [.removed, .added])
    }

    func test_emptyDiffReturnsNoFiles() {
        XCTAssertTrue(DiffParser.parse("").isEmpty)
        XCTAssertTrue(DiffParser.parse("\n\n").isEmpty)
    }
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd spike/seam1 && xcodegen generate && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO test -only-testing:ShepherdModelTests 2>&1 | tail -20`
Expected: FAIL — `cannot find 'DiffParser' in scope`.

- [ ] **Step 4: Write the model + parser**

Create `spike/seam1/Sources/DiffModel.swift`:

```swift
import Foundation

/// Pure diff model — no AppKit. Rendered by the SwiftUI panel, and (future) shipped
/// over the wire to the remote client. Highlighting is layered on at render time; the
/// model itself is plain text.

enum DiffLineKind: Equatable { case context, added, removed }
enum DiffSide: Equatable { case old, new }

struct DiffLine: Equatable {
    let kind: DiffLineKind
    let text: String
    let oldLineNo: Int?
    let newLineNo: Int?
}

struct DiffHunk: Equatable {
    let header: String
    let oldStart: Int
    let oldCount: Int
    let newStart: Int
    let newCount: Int
    let lines: [DiffLine]
}

enum DiffStatus: Equatable { case added, modified, deleted, renamed }

struct DiffFile: Equatable {
    let path: String
    let oldPath: String?
    let status: DiffStatus
    let isBinary: Bool
    let hunks: [DiffHunk]
    let addedCount: Int
    let removedCount: Int
}

enum DiffParser {
    /// Parse `git diff` unified output (with `--git` headers) into files.
    static func parse(_ unified: String) -> [DiffFile] {
        var files: [DiffFile] = []
        let lines = unified.components(separatedBy: "\n")
        var i = 0
        while i < lines.count {
            guard lines[i].hasPrefix("diff --git ") else { i += 1; continue }
            var oldPath: String? = nil
            var newPath: String? = nil
            var status: DiffStatus = .modified
            var isBinary = false
            var hunks: [DiffHunk] = []
            var added = 0, removed = 0
            i += 1
            // File header lines until the first hunk (@@) or the next file.
            while i < lines.count,
                  !lines[i].hasPrefix("@@"),
                  !lines[i].hasPrefix("diff --git ") {
                let l = lines[i]
                if l.hasPrefix("new file") { status = .added }
                else if l.hasPrefix("deleted file") { status = .deleted }
                else if l.hasPrefix("rename from ") { status = .renamed; oldPath = String(l.dropFirst("rename from ".count)) }
                else if l.hasPrefix("rename to ") { newPath = String(l.dropFirst("rename to ".count)) }
                else if l.hasPrefix("--- ") { oldPath = oldPath ?? headerPath(l.dropFirst(4)) }
                else if l.hasPrefix("+++ ") { newPath = newPath ?? headerPath(l.dropFirst(4)) }
                else if l.hasPrefix("Binary files ") { isBinary = true }
                i += 1
            }
            // Hunks.
            while i < lines.count, lines[i].hasPrefix("@@") {
                let (hunk, a, r, next) = parseHunk(lines, from: i)
                hunks.append(hunk); added += a; removed += r; i = next
            }
            let path = newPath ?? oldPath ?? "?"
            files.append(DiffFile(
                path: path,
                oldPath: (status == .renamed) ? oldPath : nil,
                status: status,
                isBinary: isBinary,
                hunks: hunks,
                addedCount: added,
                removedCount: removed))
        }
        return files
    }

    /// `a/foo.txt` / `b/foo.txt` / `/dev/null` → `foo.txt` / nil.
    private static func headerPath<S: StringProtocol>(_ s: S) -> String? {
        let t = s.trimmingCharacters(in: .whitespaces)
        if t == "/dev/null" { return nil }
        if t.hasPrefix("a/") || t.hasPrefix("b/") { return String(t.dropFirst(2)) }
        return t
    }

    /// Parse one hunk beginning at `start` (an `@@` line). Returns the hunk, its
    /// added/removed counts, and the index of the next unconsumed line.
    private static func parseHunk(_ lines: [String], from start: Int)
        -> (DiffHunk, Int, Int, Int) {
        let header = lines[start]
        let (os, oc, ns, nc) = parseHunkRanges(header)
        var body: [DiffLine] = []
        var oldNo = os, newNo = ns, added = 0, removed = 0
        var i = start + 1
        while i < lines.count,
              !lines[i].hasPrefix("@@"),
              !lines[i].hasPrefix("diff --git ") {
            let l = lines[i]
            if l.hasPrefix("\\") { i += 1; continue }   // "\ No newline at end of file"
            let text = l.isEmpty ? "" : String(l.dropFirst())
            if l.hasPrefix("+") {
                body.append(DiffLine(kind: .added, text: text, oldLineNo: nil, newLineNo: newNo))
                newNo += 1; added += 1
            } else if l.hasPrefix("-") {
                body.append(DiffLine(kind: .removed, text: text, oldLineNo: oldNo, newLineNo: nil))
                oldNo += 1; removed += 1
            } else {
                // Context (leading space) or a stray blank line inside the hunk.
                body.append(DiffLine(kind: .context, text: text, oldLineNo: oldNo, newLineNo: newNo))
                oldNo += 1; newNo += 1
            }
            i += 1
        }
        return (DiffHunk(header: header, oldStart: os, oldCount: oc,
                         newStart: ns, newCount: nc, lines: body), added, removed, i)
    }

    /// `@@ -1,3 +1,3 @@ optional section` → (1,3,1,3).
    private static func parseHunkRanges(_ header: String) -> (Int, Int, Int, Int) {
        // Between the two "@@" markers: "-oldStart,oldCount +newStart,newCount"
        let parts = header.components(separatedBy: " ")
        var os = 0, oc = 1, ns = 0, nc = 1
        for p in parts {
            if p.hasPrefix("-") { (os, oc) = parseRange(p.dropFirst()) }
            else if p.hasPrefix("+") { (ns, nc) = parseRange(p.dropFirst()) }
        }
        return (os, oc, ns, nc)
    }

    /// "1,3" → (1,3); "5" → (5,1).
    private static func parseRange<S: StringProtocol>(_ s: S) -> (Int, Int) {
        let c = s.components(separatedBy: ",")
        let start = Int(c[0]) ?? 0
        let count = c.count > 1 ? (Int(c[1]) ?? 1) : 1
        return (start, count)
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO test -only-testing:ShepherdModelTests 2>&1 | tail -20`
Expected: PASS (all `DiffModelTests` green).

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/DiffModel.swift spike/seam1/Tests/DiffModelTests.swift spike/seam1/project.yml
git commit -m "feat(diff): pure DiffModel + unified-diff parser

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Review comment model + prompt composition

**Files:**
- Modify: `spike/seam1/Sources/DiffModel.swift` (append)
- Modify: `spike/seam1/Tests/DiffModelTests.swift` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `struct ReviewComment: Equatable, Identifiable { let id: UUID; let file: String; let line: Int; let side: DiffSide; let text: String }`
  - `enum ReviewPrompt { static func compose(_ comments: [ReviewComment]) -> String }`
  - `enum HighlightMap { static func sourceLine(for line: DiffLine) -> (side: DiffSide, lineNo: Int)? }`

- [ ] **Step 1: Write the failing tests**

Append to `spike/seam1/Tests/DiffModelTests.swift`:

```swift
extension DiffModelTests {
    func test_composesEmptyReviewToEmptyString() {
        XCTAssertEqual(ReviewPrompt.compose([]), "")
    }

    func test_composesNumberedReviewPrompt() {
        let comments = [
            ReviewComment(id: UUID(), file: "src/foo.rb", line: 42, side: .new,
                          text: "this should handle the nil case"),
            ReviewComment(id: UUID(), file: "lib/bar.swift", line: 10, side: .new,
                          text: "extract this into a helper"),
        ]
        let expected = """
        Review feedback on your changes:

        1. src/foo.rb:42 — this should handle the nil case
        2. lib/bar.swift:10 — extract this into a helper

        Please address these.
        """
        XCTAssertEqual(ReviewPrompt.compose(comments), expected)
    }

    func test_highlightMapPicksCorrectSide() {
        let added = DiffLine(kind: .added, text: "x", oldLineNo: nil, newLineNo: 7)
        let removed = DiffLine(kind: .removed, text: "y", oldLineNo: 3, newLineNo: nil)
        let ctx = DiffLine(kind: .context, text: "z", oldLineNo: 5, newLineNo: 5)
        XCTAssertEqual(HighlightMap.sourceLine(for: added)?.side, .new)
        XCTAssertEqual(HighlightMap.sourceLine(for: added)?.lineNo, 7)
        XCTAssertEqual(HighlightMap.sourceLine(for: removed)?.side, .old)
        XCTAssertEqual(HighlightMap.sourceLine(for: removed)?.lineNo, 3)
        XCTAssertEqual(HighlightMap.sourceLine(for: ctx)?.side, .new)
        XCTAssertEqual(HighlightMap.sourceLine(for: ctx)?.lineNo, 5)
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO test -only-testing:ShepherdModelTests 2>&1 | tail -20`
Expected: FAIL — `cannot find 'ReviewPrompt' in scope`.

- [ ] **Step 3: Implement**

Append to `spike/seam1/Sources/DiffModel.swift`:

```swift
struct ReviewComment: Equatable, Identifiable {
    let id: UUID
    let file: String
    let line: Int
    let side: DiffSide
    let text: String
}

enum ReviewPrompt {
    /// Compose accumulated comments into one prompt for the agent. Empty → "".
    static func compose(_ comments: [ReviewComment]) -> String {
        guard !comments.isEmpty else { return "" }
        let body = comments.enumerated().map { idx, c in
            "\(idx + 1). \(c.file):\(c.line) — \(c.text)"
        }.joined(separator: "\n")
        return "Review feedback on your changes:\n\n\(body)\n\nPlease address these."
    }
}

enum HighlightMap {
    /// Which source-file side + line number a diff line pulls its syntax highlight
    /// from. Added/context use the new side; removed uses the old side. Nil never
    /// happens for real diff lines (all carry a number on at least one side) but
    /// keeps the call site total.
    static func sourceLine(for line: DiffLine) -> (side: DiffSide, lineNo: Int)? {
        switch line.kind {
        case .added:   return line.newLineNo.map { (.new, $0) }
        case .removed: return line.oldLineNo.map { (.old, $0) }
        case .context: return line.newLineNo.map { (.new, $0) }
        }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO test -only-testing:ShepherdModelTests 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/DiffModel.swift spike/seam1/Tests/DiffModelTests.swift
git commit -m "feat(diff): review comment model + prompt composition + highlight mapping

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: DiffReader — git subprocess shell

**Files:**
- Create: `spike/seam1/Sources/DiffReader.swift`

**Interfaces:**
- Consumes: `DiffParser.parse`, `DiffFile`, `DiffSide` (Task 1).
- Produces:
  - `enum DiffMode: Equatable { case workingTree, branchVsBase }`
  - `struct DiffReadResult: Equatable { let files: [DiffFile]; let baseLabel: String?; let isRepo: Bool }`
  - `enum DiffReader { static func read(cwd: String, mode: DiffMode) -> DiffReadResult; static func fileBlob(cwd: String, path: String, side: DiffSide, baseLabel: String?) -> String? }`

This task shells out to `git`; it is verified at runtime, not by unit tests.

- [ ] **Step 1: Implement DiffReader**

Create `spike/seam1/Sources/DiffReader.swift`:

```swift
import Foundation

enum DiffMode: Equatable { case workingTree, branchVsBase }

struct DiffReadResult: Equatable {
    let files: [DiffFile]
    let baseLabel: String?   // e.g. "master"; nil in working-tree mode / not a repo
    let isRepo: Bool

    static let notRepo = DiffReadResult(files: [], baseLabel: nil, isRepo: false)
}

enum DiffReader {
    /// Read the diff for a cwd. `-M` so renames render as renames. Runs `git`
    /// synchronously; callers dispatch this off the main thread.
    static func read(cwd: String, mode: DiffMode) -> DiffReadResult {
        guard isGitRepo(cwd) else { return .notRepo }
        switch mode {
        case .workingTree:
            var text = git(cwd, ["diff", "-M", "HEAD"]) ?? ""
            text += untrackedDiff(cwd)
            return DiffReadResult(files: DiffParser.parse(text), baseLabel: nil, isRepo: true)
        case .branchVsBase:
            let base = detectBase(cwd)
            // Committed-since-base ∪ uncommitted, so the mode reads as "total vs base".
            let committed = git(cwd, ["diff", "-M", "\(base)...HEAD"]) ?? ""
            let working = (git(cwd, ["diff", "-M", "HEAD"]) ?? "") + untrackedDiff(cwd)
            let merged = mergeByPath(DiffParser.parse(committed) + DiffParser.parse(working))
            return DiffReadResult(files: merged, baseLabel: base, isRepo: true)
        }
    }

    /// Whole-file text for syntax highlighting. New side = the file on disk; old side
    /// = the blob at HEAD (working-tree) or the base (branch mode). Nil if unavailable.
    static func fileBlob(cwd: String, path: String, side: DiffSide, baseLabel: String?) -> String? {
        switch side {
        case .new:
            return try? String(contentsOfFile: (cwd as NSString).appendingPathComponent(path), encoding: .utf8)
        case .old:
            let ref = baseLabel ?? "HEAD"
            return git(cwd, ["show", "\(ref):\(path)"])
        }
    }

    // MARK: - internals

    private static func isGitRepo(_ cwd: String) -> Bool {
        git(cwd, ["rev-parse", "--is-inside-work-tree"])?.trimmingCharacters(in: .whitespacesAndNewlines) == "true"
    }

    /// origin/HEAD → main → master.
    private static func detectBase(_ cwd: String) -> String {
        if let sym = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"])?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           let name = sym.components(separatedBy: "/").last, !name.isEmpty {
            return name
        }
        if git(cwd, ["rev-parse", "--verify", "main"]) != nil { return "main" }
        return "master"
    }

    /// Synthesize an all-added diff for every untracked file so new files show.
    private static func untrackedDiff(_ cwd: String) -> String {
        guard let out = git(cwd, ["ls-files", "--others", "--exclude-standard"]) else { return "" }
        var acc = ""
        for path in out.split(separator: "\n").map(String.init) where !path.isEmpty {
            // `--no-index` exits non-zero when files differ; capture stdout regardless.
            if let d = git(cwd, ["diff", "--no-index", "--", "/dev/null", path], allowFailure: true) {
                acc += d
            }
        }
        return acc
    }

    /// When branch mode unions committed + working diffs, the same path can appear
    /// twice. Prefer the later (working-tree) entry — it's the current on-disk truth.
    private static func mergeByPath(_ files: [DiffFile]) -> [DiffFile] {
        var order: [String] = []
        var byPath: [String: DiffFile] = [:]
        for f in files {
            if byPath[f.path] == nil { order.append(f.path) }
            byPath[f.path] = f
        }
        return order.compactMap { byPath[$0] }
    }

    @discardableResult
    private static func git(_ cwd: String, _ args: [String], allowFailure: Bool = false) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["-C", cwd] + args
        let out = Pipe(); let err = Pipe()
        p.standardOutput = out; p.standardError = err
        do { try p.run() } catch { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        if p.terminationStatus != 0 && !allowFailure { return nil }
        return String(data: data, encoding: .utf8)
    }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd spike/seam1 && xcodegen generate && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -5`
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 3: Commit**

```bash
git add spike/seam1/Sources/DiffReader.swift
git commit -m "feat(diff): DiffReader git subprocess shell (working-tree + branch modes)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Live PTY text-injection seam

**Files:**
- Modify: `spike/seam1/Sources/GhosttyTerminal.swift`
- Modify: `spike/seam1/Sources/AgentStore.swift`

**Interfaces:**
- Consumes: existing `GhosttySurfaceView` per-pane notification pattern, `ghostty_surface_key`, `ghostty_input_key_s`.
- Produces:
  - `Notification.Name.shepherdInjectText`
  - `GhosttySurfaceView.perform(paneID:injectText:)` (static)
  - `AgentStore.injectText(_ text: String, intoPane paneID: String)`

- [ ] **Step 1: Add the injection notification + observer to GhosttyTerminal**

In `spike/seam1/Sources/GhosttyTerminal.swift`, inside `GhosttySurfaceView.init`, after the existing `shepherdPerformBinding` observer registration (line ~37), add:

```swift
        NotificationCenter.default.addObserver(self, selector: #selector(injectText(_:)),
                                               name: .shepherdInjectText, object: nil)
```

Add the static poster next to the existing `perform(paneID:binding:)` (after line ~47):

```swift
    /// Inject a text string straight into this pane's PTY (as if typed). Used by the
    /// diff-review "send to agent" action. Posted per pane; runs on main.
    static func perform(paneID: String, injectText text: String) {
        NotificationCenter.default.post(name: .shepherdInjectText, object: nil,
                                        userInfo: ["paneID": paneID, "text": text])
    }
```

Add the observer method after `performBinding(_:)` (after line ~56):

```swift
    @objc private func injectText(_ note: Notification) {
        guard note.userInfo?["paneID"] as? String == paneID,
              let text = note.userInfo?["text"] as? String,
              let surface else { return }
        var key = ghostty_input_key_s()
        key.action = GHOSTTY_ACTION_PRESS
        key.mods = ghostty_input_mods_e(GHOSTTY_MODS_NONE.rawValue)
        key.consumed_mods = ghostty_input_mods_e(GHOSTTY_MODS_NONE.rawValue)
        key.keycode = 0
        key.composing = false
        key.unshifted_codepoint = 0
        _ = text.withCString { ptr -> Bool in
            key.text = ptr
            return ghostty_surface_key(surface, key)
        }
    }
```

Register the notification name next to the existing `shepherdPerformBinding` declaration (after line ~362):

```swift
    /// Posted (userInfo `["paneID": String, "text": String]`) to inject text into a
    /// pane's PTY — the diff-review comment→prompt channel.
    static let shepherdInjectText = Notification.Name("shepherd.injectText")
```

- [ ] **Step 2: Add the store method**

In `spike/seam1/Sources/AgentStore.swift`, near the other per-pane surface helpers (after `cwd(forPane:)`, ~line 465), add:

```swift
    /// Inject text into a live pane's PTY (diff-review "send to agent").
    func injectText(_ text: String, intoPane paneID: String) {
        GhosttySurfaceView.perform(paneID: paneID, injectText: text)
    }
```

- [ ] **Step 3: Verify it compiles**

Run: `cd spike/seam1 && xcodegen generate && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -5`
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 4: Commit**

```bash
git add spike/seam1/Sources/GhosttyTerminal.swift spike/seam1/Sources/AgentStore.swift
git commit -m "feat(diff): per-pane live PTY text-injection seam

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Free ⌘G — rebind Find navigation to Return / Shift-Return

**Files:**
- Modify: `spike/seam1/Sources/ShepherdApp.swift`
- Modify: `spike/seam1/Sources/SplitContainer.swift`

**Interfaces:**
- Consumes: existing `store.navigateSearch(_:paneID:)`, `store.searches`, `PaneSearchOverlay`.
- Produces: no new API. `navigateFocusedSearch(_:)` becomes unused by menu (leave the store method in place; harmless).

- [ ] **Step 1: Remove the ⌘G / ⌘⇧G Find menu commands**

In `spike/seam1/Sources/ShepherdApp.swift`, delete these three lines (the `Find Next` and `Find Previous` buttons; keep `Find` on ⌘F):

```swift
                Button("Find Next") { AgentStore.shared.navigateFocusedSearch(.next) }
                    .keyboardShortcut("g", modifiers: .command)
                Button("Find Previous") { AgentStore.shared.navigateFocusedSearch(.previous) }
                    .keyboardShortcut("g", modifiers: [.command, .shift])
```

Leave the preceding `Button("Find") { ... }.keyboardShortcut("f", ...)` and the `Divider()` intact.

- [ ] **Step 2: Add Shift-Return → previous in the search field**

In `spike/seam1/Sources/SplitContainer.swift`, in `PaneSearchOverlay`, the `TextField` already has `.onSubmit { store.navigateSearch(.next, paneID: paneID) }` (Return → next). Add a Shift-Return handler via a local key monitor scoped to the overlay's lifetime (macOS 13-safe — no `.onKeyPress`).

Add a state property to `PaneSearchOverlay`:

```swift
    @State private var shiftReturnMonitor: Any?
```

Add these modifiers to the overlay's root view (next to the existing `.onExitCommand`):

```swift
        .onAppear {
            shiftReturnMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
                // keyCode 36 = Return. Shift-Return → previous match; swallow it.
                if event.keyCode == 36, event.modifierFlags.contains(.shift) {
                    store.navigateSearch(.previous, paneID: paneID)
                    return nil
                }
                return event
            }
        }
        .onDisappear {
            if let m = shiftReturnMonitor { NSEvent.removeMonitor(m) }
            shiftReturnMonitor = nil
        }
```

- [ ] **Step 3: Verify it compiles**

Run: `cd spike/seam1 && xcodegen generate && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -5`
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 4: Commit**

```bash
git add spike/seam1/Sources/ShepherdApp.swift spike/seam1/Sources/SplitContainer.swift
git commit -m "feat(search): move Find Next/Prev to Return/Shift-Return, free cmd-G

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Store wiring — panel state, turn signal, accessors, submit

**Files:**
- Modify: `spike/seam1/Sources/AgentStore.swift`

**Interfaces:**
- Consumes: `ReviewComment`, `ReviewPrompt.compose` (Task 2); `injectText(_:intoPane:)` (Task 4); existing `locatePane`, `selectedTab`, `currentWorkspace`, `apply`.
- Produces:
  - `@Published var diffPanelOpen: Bool`
  - `@Published var diffPanelPaneID: String?`
  - `@Published private(set) var diffTurnTick: Int` + `private(set) var diffTurnPane: String?`
  - `func toggleDiffPanel()`
  - `func pane(_ paneID: String) -> Pane?`
  - `func hasLiveAgent(paneID: String) -> Bool`
  - `func submitReview(_ comments: [ReviewComment], toPane paneID: String)`

- [ ] **Step 1: Add published panel state**

In `spike/seam1/Sources/AgentStore.swift`, near the other `@Published` properties (around `searches`, ~line 27), add:

```swift
    @Published var diffPanelOpen = false
    @Published var diffPanelPaneID: String? = nil
    /// Bumped when the reviewed pane finishes a turn, so an open panel can offer a refresh.
    @Published private(set) var diffTurnTick = 0
    private(set) var diffTurnPane: String? = nil
```

- [ ] **Step 2: Add the accessors + toggle + submit**

Near `cwd(forPane:)` (~line 465), add:

```swift
    func pane(_ paneID: String) -> Pane? {
        guard let (w, t) = locatePane(paneID, in: workspaces) else { return nil }
        return workspaces[w].tabs[t].root.pane(paneID)
    }

    /// A pane running a live Claude session (so the comment→prompt composer applies).
    func hasLiveAgent(paneID: String) -> Bool {
        (pane(paneID)?.sessionID?.isEmpty == false)
    }

    /// ⌘G — toggle the diff panel for the selected tab's focused pane.
    func toggleDiffPanel() {
        if diffPanelOpen { diffPanelOpen = false; return }
        guard let tab = tabs.first(where: { $0.tabID == selectedTab }) else { return }
        diffPanelPaneID = tab.focusedPaneID
        diffPanelOpen = true
    }

    /// Compose review comments into one prompt and inject it into the pane's agent.
    /// `shepherd.diff.autoReviewSubmit` (default true) appends a newline to send it;
    /// false stages the text for the user to press Enter.
    func submitReview(_ comments: [ReviewComment], toPane paneID: String) {
        guard !comments.isEmpty else { return }
        let auto = (UserDefaults.standard.object(forKey: "shepherd.diff.autoReviewSubmit") as? Bool) ?? true
        let prompt = ReviewPrompt.compose(comments) + (auto ? "\n" : "")
        injectText(prompt, intoPane: paneID)
    }
```

- [ ] **Step 3: Emit the turn-ended signal in `apply`**

In `apply(event:detail:paneID:payload:)`, immediately after the `updatePane` block that sets `$0.state = res.state` (after line ~511), add:

```swift
        if res.state == .needsCheck {
            diffTurnPane = paneID
            diffTurnTick += 1   // an open diff panel watches this to offer a refresh
        }
```

- [ ] **Step 4: Verify it compiles**

Run: `cd spike/seam1 && xcodegen generate && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -5`
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/AgentStore.swift
git commit -m "feat(diff): store wiring — panel state, turn signal, review submit

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: HighlighterSwift dependency + DiffReviewModel + DiffPanelView

**Files:**
- Modify: `spike/seam1/project.yml` (add HighlighterSwift to the `Shepherd` target)
- Create: `spike/seam1/Sources/DiffPanelView.swift`

**Interfaces:**
- Consumes: `DiffFile`/`DiffLine`/`DiffMode`/`DiffReadResult`/`DiffReader`/`ReviewComment`/`HighlightMap` (Tasks 1–3); `AgentStore.diffPanelPaneID`/`diffTurnTick`/`cwd(forPane:)`/`hasLiveAgent`/`submitReview` (Task 6); `Theme`.
- Produces: `struct DiffPanelView: View`, `final class DiffReviewModel: ObservableObject`, `enum DiffSyntaxHighlighter`.

- [ ] **Step 1: Add HighlighterSwift to the app target**

In `spike/seam1/project.yml`, add a top-level `packages:` block (after the `options:` block, before `settings:`):

```yaml
packages:
  Highlighter:
    url: https://github.com/smittytone/HighlighterSwift
    from: 3.1.0
```

Under `targets: > Shepherd: > dependencies:`, add:

```yaml
      - package: Highlighter
```

(Do **not** add it to `ShepherdModelTests` — the pure model must not depend on it.)

- [ ] **Step 2: Write the DiffReviewModel + highlighter + panel**

Create `spike/seam1/Sources/DiffPanelView.swift`:

```swift
import SwiftUI
import AppKit
import Highlighter

/// Panel state: current diff, mode, in-progress comments, and the background-staged
/// `pendingDiff` for the GitHub-style "changes available" refresh.
@MainActor
final class DiffReviewModel: ObservableObject {
    @Published var mode: DiffMode = .workingTree
    @Published var files: [DiffFile] = []
    @Published var baseLabel: String? = nil
    @Published var isRepo = true
    @Published var loading = false
    @Published var comments: [ReviewComment] = []
    @Published var staleAvailable = false

    private var pending: DiffReadResult? = nil
    private(set) var cwd: String? = nil

    func load(cwd: String?, mode: DiffMode) {
        self.cwd = cwd
        self.mode = mode
        guard let cwd else { files = []; isRepo = false; return }
        loading = true
        let m = mode
        DispatchQueue.global(qos: .userInitiated).async {
            let result = DiffReader.read(cwd: cwd, mode: m)
            DispatchQueue.main.async {
                self.files = result.files
                self.baseLabel = result.baseLabel
                self.isRepo = result.isRepo
                self.loading = false
                self.staleAvailable = false
                self.pending = nil
            }
        }
    }

    /// A turn ended while the panel is open: rebuild in the background, keep showing
    /// the current diff, and light the refresh banner.
    func onTurnEnded() {
        guard let cwd else { return }
        let m = mode
        DispatchQueue.global(qos: .userInitiated).async {
            let result = DiffReader.read(cwd: cwd, mode: m)
            DispatchQueue.main.async { self.pending = result; self.staleAvailable = true }
        }
    }

    /// Swap the pre-built pending diff in (instant); or synchronously reload if none.
    func applyRefresh() {
        if let p = pending {
            files = p.files; baseLabel = p.baseLabel; isRepo = p.isRepo
            pending = nil; staleAvailable = false
        } else {
            load(cwd: cwd, mode: mode)
        }
    }

    func addComment(file: String, line: Int, side: DiffSide, text: String) {
        comments.append(ReviewComment(id: UUID(), file: file, line: line, side: side, text: text))
    }
}

/// Whole-file syntax highlighting (HighlighterSwift / Highlight.js). Highlight each file
/// once, cache the per-line attributed result, and map onto diff lines by line number.
/// Large / minified files skip highlighting and fall back to plain diff coloring.
enum DiffSyntaxHighlighter {
    private static let maxBytes = 500_000
    private static let highlighter: Highlighter? = {
        let h = Highlighter()
        _ = h?.setTheme("atom-one-dark")
        return h
    }()
    // key: "\(path)#\(side)#\(hashValue)"
    private static var cache: [String: [NSAttributedString]] = [:]

    /// Per-line highlighted attributed strings for a blob, or nil to fall back to plain.
    static func lines(forBlob blob: String, path: String, side: DiffSide) -> [NSAttributedString]? {
        guard blob.utf8.count <= maxBytes else { return nil }
        let key = "\(path)#\(side)#\(blob.hashValue)"
        if let hit = cache[key] { return hit }
        let lang = language(forPath: path)
        guard let attr = (lang != nil
            ? highlightr?.highlight(blob, as: lang)
            : highlightr?.highlight(blob)) else { return nil }
        // Split the highlighted attributed string on newlines, preserving attributes.
        let ns = attr
        var result: [NSAttributedString] = []
        var start = 0
        let plain = ns.string as NSString
        plain.enumerateSubstrings(in: NSRange(location: 0, length: plain.length),
                                  options: [.byLines, .substringNotRequired]) { _, range, _, _ in
            result.append(ns.attributedSubstring(from: NSRange(location: range.location,
                                                               length: range.length)))
            start = range.location + range.length
        }
        _ = start
        cache[key] = result
        return result
    }

    /// Highlight.js language name from a file extension, or nil (auto-detect).
    private static func language(forPath path: String) -> String? {
        switch (path as NSString).pathExtension.lowercased() {
        case "swift": return "swift"
        case "rb": return "ruby"
        case "kt", "kts": return "kotlin"
        case "ts", "tsx": return "typescript"
        case "js", "jsx": return "javascript"
        case "py": return "python"
        case "go": return "go"
        case "java": return "java"
        case "json": return "json"
        case "yml", "yaml": return "yaml"
        case "sh", "bash": return "bash"
        case "md": return "markdown"
        default: return nil
        }
    }
}

struct DiffPanelView: View {
    @EnvironmentObject var store: AgentStore
    @StateObject private var model = DiffReviewModel()

    var body: some View {
        VStack(spacing: 0) {
            header
            if model.staleAvailable { refreshBanner }
            Divider().overlay(Theme.hairline)
            content
        }
        .background(Theme.ground)
        .onAppear { reload() }
        .onChange(of: store.diffPanelPaneID) { _ in reload() }
        .onChange(of: model.mode) { _ in reload() }
        .onChange(of: store.diffTurnTick) { _ in
            if store.diffTurnPane == store.diffPanelPaneID { model.onTurnEnded() }
        }
    }

    private func reload() {
        guard let pid = store.diffPanelPaneID else { return }
        model.load(cwd: store.cwd(forPane: pid), mode: model.mode)
    }

    private var header: some View {
        HStack(spacing: 10) {
            Text("Review").font(.system(size: 12, weight: .semibold))
                .foregroundColor(Theme.textBright)
            Picker("", selection: $model.mode) {
                Text("Working tree").tag(DiffMode.workingTree)
                Text("vs \(model.baseLabel ?? "base")").tag(DiffMode.branchVsBase)
            }
            .pickerStyle(.segmented).labelsHidden().frame(width: 180).focusable(false)
            Spacer()
            if !model.comments.isEmpty {
                Text("\(model.comments.count) comments").font(.system(size: 11))
                    .foregroundColor(Theme.textDim)
                Button("Send to agent") {
                    if let pid = store.diffPanelPaneID {
                        store.submitReview(model.comments, toPane: pid)
                        model.comments.removeAll()
                        store.diffPanelOpen = false
                    }
                }.focusable(false)
            }
            Button { model.applyRefresh() } label: { Image(systemName: "arrow.clockwise") }
                .focusable(false)
            Button { store.diffPanelOpen = false } label: { Image(systemName: "xmark") }
                .focusable(false)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    private var refreshBanner: some View {
        Button { model.applyRefresh() } label: {
            HStack(spacing: 6) {
                Image(systemName: "arrow.clockwise")
                Text("Changes available — refresh")
            }
            .font(.system(size: 11)).frame(maxWidth: .infinity)
            .padding(.vertical, 5).background(Theme.working.opacity(0.18))
        }
        .buttonStyle(.plain).focusable(false)
    }

    @ViewBuilder private var content: some View {
        if !model.isRepo {
            centered("Not a git repository")
        } else if model.files.isEmpty {
            centered(model.loading ? "Loading…" : "No changes")
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(model.files, id: \.path) { file in
                        DiffFileView(file: file, model: model,
                                     hasAgent: store.diffPanelPaneID.map { store.hasLiveAgent(paneID: $0) } ?? false,
                                     cwd: model.cwd, baseLabel: model.baseLabel)
                    }
                }
                .padding(12)
            }
        }
    }

    private func centered(_ s: String) -> some View {
        VStack { Spacer(); Text(s).foregroundColor(Theme.textDim).font(.system(size: 12)); Spacer() }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct DiffFileView: View {
    let file: DiffFile
    @ObservedObject var model: DiffReviewModel
    let hasAgent: Bool
    let cwd: String?
    let baseLabel: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(statusGlyph).font(.system(size: 11, weight: .bold)).foregroundColor(statusColor)
                Text(file.path).font(.system(size: 12, weight: .medium)).foregroundColor(Theme.textBright)
                Spacer()
                Text("+\(file.addedCount)").foregroundColor(Theme.done).font(.system(size: 11))
                Text("−\(file.removedCount)").foregroundColor(Theme.error).font(.system(size: 11))
            }
            .padding(.bottom, 4)
            if file.isBinary {
                Text("Binary file").foregroundColor(Theme.textDim).font(.system(size: 11))
            } else {
                ForEach(Array(file.hunks.enumerated()), id: \.offset) { _, hunk in
                    ForEach(Array(hunk.lines.enumerated()), id: \.offset) { _, line in
                        DiffLineRow(line: line, file: file, model: model, hasAgent: hasAgent)
                    }
                }
            }
        }
    }

    private var statusGlyph: String {
        switch file.status { case .added: return "A"; case .modified: return "M"
        case .deleted: return "D"; case .renamed: return "R" }
    }
    private var statusColor: Color {
        switch file.status { case .added: return Theme.done; case .deleted: return Theme.error
        default: return Theme.textDim }
    }
}

private struct DiffLineRow: View {
    let line: DiffLine
    let file: DiffFile
    @ObservedObject var model: DiffReviewModel
    let hasAgent: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Text(gutter).frame(width: 44, alignment: .trailing)
                .foregroundColor(Theme.textDim).font(.system(size: 11, design: .monospaced))
            Text(sign + line.text).font(.system(size: 12, design: .monospaced))
                .foregroundColor(fg).frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(bg)
        .contentShape(Rectangle())
        .onTapGesture(count: 2) { if hasAgent { promptComment() } }
    }

    private func promptComment() {
        guard let anchor = HighlightMap.sourceLine(for: line) else { return }
        let alert = NSAlert()
        alert.messageText = "Comment on \(file.path):\(anchor.lineNo)"
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        alert.accessoryView = field
        alert.addButton(withTitle: "Add"); alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn, !field.stringValue.isEmpty {
            model.addComment(file: file.path, line: anchor.lineNo, side: anchor.side, text: field.stringValue)
        }
    }

    private var sign: String {
        switch line.kind { case .added: return "+"; case .removed: return "-"; case .context: return " " }
    }
    private var gutter: String {
        "\(line.oldLineNo.map(String.init) ?? " ") \(line.newLineNo.map(String.init) ?? " ")"
    }
    private var fg: Color {
        switch line.kind { case .added: return Theme.done; case .removed: return Theme.error
        case .context: return Theme.text }
    }
    private var bg: Color {
        switch line.kind {
        case .added: return Theme.done.opacity(0.10)
        case .removed: return Theme.error.opacity(0.10)
        case .context: return .clear
        }
    }
}
```

> Note on highlighting: this task lands the panel with **diff-semantic coloring**
> and wires `DiffSyntaxHighlighter` + `HighlightMap`. Layering the highlighter's
> per-line foreground spans onto `DiffLineRow` (via `AttributedString`, keyed by
> `HighlightMap.sourceLine`) is the final polish step below — kept separate so the
> panel is reviewable working before the highlighter is threaded through.

- [ ] **Step 3: Verify Theme has the referenced tokens**

Run: `grep -nE "textBright|textDim|\btext\b|\bdone\b|\berror\b|\bworking\b|\bground\b|hairline" spike/seam1/Sources/Theme.swift`
Expected: each token used above (`textBright`, `textDim`, `text`, `done`, `error`, `working`, `ground`, `hairline`) resolves to a `Theme` member. If any name differs, adjust the references in `DiffPanelView.swift` to the actual `Theme` member names (do not add new tokens unless one is genuinely missing).

- [ ] **Step 4: Verify it compiles**

Run: `cd spike/seam1 && xcodegen generate && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -8`
Expected: `** BUILD SUCCEEDED **` (HighlighterSwift resolves via SPM on first generate — network needed once).

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/project.yml spike/seam1/Sources/DiffPanelView.swift
git commit -m "feat(diff): DiffReviewModel + panel view + HighlighterSwift dependency

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Mount the panel + ⌘G command + thread syntax highlighting

**Files:**
- Modify: `spike/seam1/Sources/ContentView.swift`
- Modify: `spike/seam1/Sources/ShepherdApp.swift`
- Modify: `spike/seam1/Sources/DiffPanelView.swift`

**Interfaces:**
- Consumes: `store.diffPanelOpen`, `DiffPanelView` (Task 7); `store.toggleDiffPanel()` (Task 6); `DiffSyntaxHighlighter`, `HighlightMap` (Tasks 2, 7).

- [ ] **Step 1: Add the ⌘G menu command**

In `spike/seam1/Sources/ShepherdApp.swift`, where the `Find` command lives (after the `Button("Find")…` block, in the same `Divider()`-separated group), add:

```swift
                Button("Review Diff") { AgentStore.shared.toggleDiffPanel() }
                    .keyboardShortcut("g", modifiers: .command)
```

- [ ] **Step 2: Mount the panel as a right-hand strip in ContentView**

In `spike/seam1/Sources/ContentView.swift`, add a persisted width and wrap the terminal area so the panel occupies the right edge when open. Add near the other `@AppStorage`:

```swift
    @AppStorage("shepherd.diffPanelWidth") private var diffPanelWidth: Double = 460
```

Change the terminal-layer `HStack` in `body` to trail with the panel:

```swift
            HStack(spacing: 0) {
                Color.clear.frame(width: sidebarWidth + dividerWidth)
                terminalArea
                if store.diffPanelOpen {
                    Rectangle().fill(Theme.hairline).frame(width: 1)
                    DiffPanelView()
                        .environmentObject(store)
                        .frame(width: diffPanelWidth)
                        .transition(.move(edge: .trailing))
                }
            }
```

Add an animation modifier to the `ZStack` in `body` (next to the existing `.animation(...)` lines):

```swift
        .animation(.easeOut(duration: 0.16), value: store.diffPanelOpen)
```

- [ ] **Step 3: Thread syntax highlighting into DiffLineRow**

In `spike/seam1/Sources/DiffPanelView.swift`, replace the `Text(sign + line.text)` in `DiffLineRow.body` with a highlighted variant. `DiffFileView` already knows `cwd`/`baseLabel`; pass them into `DiffLineRow` and build the highlighted line lazily.

Add stored properties to `DiffLineRow`:

```swift
    let cwd: String?
    let baseLabel: String?
```

Pass them where `DiffFileView` constructs `DiffLineRow`:

```swift
                        DiffLineRow(line: line, file: file, model: model, hasAgent: hasAgent,
                                    cwd: cwd, baseLabel: baseLabel)
```

Replace the content `Text` with:

```swift
            highlightedText
                .font(.system(size: 12, design: .monospaced))
                .frame(maxWidth: .infinity, alignment: .leading)
```

And add:

```swift
    @ViewBuilder private var highlightedText: some View {
        if let attr = highlightedLine {
            Text(AttributedString(attr))
        } else {
            Text(sign + line.text).foregroundColor(fg)
        }
    }

    /// The syntax-highlighted attributed line (foreground tokens), prefixed with the
    /// diff sign, or nil to fall back to plain diff coloring (binary/large/no blob).
    private var highlightedLine: NSAttributedString? {
        guard let cwd, let anchor = HighlightMap.sourceLine(for: line) else { return nil }
        guard let blob = DiffReader.fileBlob(cwd: cwd, path: file.path, side: anchor.side, baseLabel: baseLabel),
              let lines = DiffSyntaxHighlighter.lines(forBlob: blob, path: file.path, side: anchor.side),
              anchor.lineNo - 1 >= 0, anchor.lineNo - 1 < lines.count else { return nil }
        let m = NSMutableAttributedString(string: sign)
        m.append(lines[anchor.lineNo - 1])
        return m
    }
```

> The line-background (`bg`) still comes from the diff kind, so highlighted foreground
> tokens sit over the added/removed background — the two-layer coloring from the spec.

- [ ] **Step 4: Verify it compiles**

Run: `cd spike/seam1 && xcodegen generate && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -8`
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 5: Run the full model test suite (regression)**

Run: `cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO test -only-testing:ShepherdModelTests 2>&1 | tail -12`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/ContentView.swift spike/seam1/Sources/ShepherdApp.swift spike/seam1/Sources/DiffPanelView.swift
git commit -m "feat(diff): mount panel + cmd-G toggle + thread syntax highlighting

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 7: Hand off to the user for runtime verification**

Ask the user to build, ad-hoc sign, relaunch Shepherd, and check end-to-end (do NOT do this — the user runs the live app):
- `⌘G` opens the panel for the focused pane; toggles closed.
- Working-tree ⇄ branch-vs-base toggle shows the expected files (untracked included).
- Syntax highlighting renders; a huge/minified file falls back to plain coloring without jank.
- Double-click a line → comment; "Send to agent" injects the composed prompt into the pane's Claude (auto-submits with `shepherd.diff.autoReviewSubmit` unset/true).
- `⌘F` search still works; Return → next match, Shift-Return → previous.

---

## Self-Review

**Spec coverage:**
- Pure `DiffModel` + parser → Task 1. ✅
- Working-tree + branch-vs-base modes, base detection, untracked, renames → Task 3. ✅
- Refresh model (pending-diff + banner, background rebuild, apply on click) → `DiffReviewModel.onTurnEnded`/`applyRefresh` (Task 7) + turn signal (Task 6). ✅
- Whole-file syntax highlighting via HighlighterSwift, line-number mapping, large-file fallback → `DiffSyntaxHighlighter` (Task 7) + `HighlightMap` (Task 2) + threading (Task 8). ✅
- Comment → prompt, batched, PR-style, injected via PTY seam, `shepherd.diff.autoReviewSubmit` default auto, agent-gating → Tasks 2, 4, 6, 7. ✅
- ⌘G trigger, right-hand panel, empty states, `.focusable(false)` → Task 8, Task 7. ✅
- Search rebind to Return/Shift-Return (freeing ⌘G) → Task 5. ✅
- Tests in `ShepherdModelTests`, HighlighterSwift kept out of the test target → Tasks 1, 2, 7. ✅

**Placeholder scan:** No TBD/TODO code paths remain. The comment flow uses the `NSAlert` in `DiffLineRow.promptComment`; no dead scaffolding state.

**Type consistency:** `DiffSide`/`DiffLine`/`DiffFile`/`DiffMode`/`ReviewComment` names are used identically across Tasks 1–8. `HighlightMap.sourceLine(for:)` returns `(side, lineNo)` consumed the same way in `DiffLineRow`. `store.diffPanelPaneID`/`diffTurnTick`/`diffTurnPane`/`toggleDiffPanel`/`submitReview`/`cwd(forPane:)`/`hasLiveAgent` names match between Task 6 (definition) and Tasks 7–8 (use). `GhosttySurfaceView.perform(paneID:injectText:)` matches between Task 4 (def) and `AgentStore.injectText` (use).
