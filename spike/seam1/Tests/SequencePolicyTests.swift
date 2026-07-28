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

    /// Measured: a rebase parks its message in `rebase-merge/message`; merge and cherry-pick
    /// both use `MERGE_MSG`.
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

    // MARK: classifying a --continue

    /// The real-git finding this exists for: `git rebase --continue` **exits non-zero when it
    /// stops at the next commit's conflict**, so the loop working correctly looks like a failed
    /// command. Reported as an error, it would show git's words every time a multi-commit
    /// rebase behaved exactly as designed.
    func testAdvancedThenHitTheNextConflictIsAStopNotAFailure() {
        XCTAssertEqual(SequencePolicy.outcome(succeeded: false,
                                              errorText: "could not apply 2b8a260…",
                                              headMoved: true, stillActive: true,
                                              unmergedAfter: 3),
                       .stopped)
    }

    /// And the case that rules out the easy discriminators: a refused `--continue` also exits
    /// non-zero and also leaves unmerged files. Only "did a commit get made" separates them.
    func testRefusalWithNothingCommittedIsAFailure() {
        XCTAssertEqual(SequencePolicy.outcome(succeeded: false,
                                              errorText: "you must edit all merge conflicts",
                                              headMoved: false, stillActive: true,
                                              unmergedAfter: 3),
                       .failed("you must edit all merge conflicts"))
    }

    func testRanToTheEnd() {
        XCTAssertEqual(SequencePolicy.outcome(succeeded: true, errorText: nil,
                                              headMoved: true, stillActive: false,
                                              unmergedAfter: 0),
                       .finished)
    }

    /// A rebase stopped on an `edit` or `break` todo: it succeeded, nothing is unmerged, but
    /// the sequence is still in flight — so it is a stop, and Continue stays available.
    func testStoppedOnATodoWithNoConflict() {
        XCTAssertEqual(SequencePolicy.outcome(succeeded: true, errorText: nil,
                                              headMoved: true, stillActive: true,
                                              unmergedAfter: 0),
                       .stopped)
    }

    /// A failure with no stderr still has to say something.
    func testFailureAlwaysCarriesText() {
        guard case .failed(let reason) = SequencePolicy.outcome(
            succeeded: false, errorText: nil, headMoved: false,
            stillActive: true, unmergedAfter: 1) else {
            return XCTFail("expected a failure")
        }
        XCTAssertFalse(reason.isEmpty)
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

    /// Whenever the button is disabled there is something to say. Asserted over the whole
    /// space rather than case by case, because the pairing is the actual invariant.
    func testEveryBlockedStateHasAReason() {
        for isActive in [true, false] {
            for unresolved in [0, 1, 5] {
                for writing in [true, false] {
                    let can = SequencePolicy.canContinue(isActive: isActive,
                                                         unresolved: unresolved,
                                                         writing: writing)
                    let reason = SequencePolicy.blockedReason(isActive: isActive,
                                                             unresolved: unresolved,
                                                             writing: writing)
                    XCTAssertEqual(can, reason == nil,
                                   "active=\(isActive) unresolved=\(unresolved) writing=\(writing)")
                }
            }
        }
    }
}
