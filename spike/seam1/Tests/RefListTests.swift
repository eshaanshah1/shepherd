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
