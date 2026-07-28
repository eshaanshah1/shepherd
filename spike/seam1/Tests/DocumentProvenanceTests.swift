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
