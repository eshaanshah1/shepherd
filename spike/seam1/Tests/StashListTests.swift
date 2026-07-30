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
    /// drive `git stash drop` at the wrong entry, which nothing undoes.
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
        XCTAssertEqual(Array(args.prefix(2)), ["stash", "push"])
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
