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
