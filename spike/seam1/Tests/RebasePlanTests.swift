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

    /// **The load-bearing assertion.** The rail's top row is the newest commit; git applies the
    /// todo top-down starting from the base, so the emitted order is the reverse.
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

    /// A dropped row is **absent**, not `drop <sha>`. Both work in git; leaving the line out is
    /// what makes an all-dropped plan an empty todo, which git refuses cleanly.
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
        XCTAssertEqual(RebasePlan.todo(for: rows),
                       "pick ccccccc3\npick bbbbbbb2\npick aaaaaaa1\n")
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
        rows[0].message = "one"
        rows[1].verb = .squash
        rows[1].message = "two"
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

    func testASquashWithNoMessageIsBlocked() {
        var rows = RebasePlan.rows(from: newestFirst)
        rows[0].verb = .squash
        XCTAssertEqual(RebasePlan.blockedReason(rows: rows, original: newestFirst),
                       "the squash needs a message")
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
