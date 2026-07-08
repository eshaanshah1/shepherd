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
