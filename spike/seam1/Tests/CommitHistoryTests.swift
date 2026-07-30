import XCTest
@testable import Shepherd

/// The log parse is NUL-delimited on purpose: a commit subject can contain anything,
/// including `|` and quotes, so a human-readable delimiter would eventually split one.
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

    /// **No argument may contain a NUL.**
    ///
    /// `Process` converts every argument to a C string via `fileSystemRepresentation`, and a
    /// Swift string holding a NUL has none — so `run()` throws `NSInvalidArgumentException`,
    /// which is an **ObjC** exception that `GitStaging.run`'s `try`/`catch` cannot see, and the
    /// app terminates. This crashed the workbench on ⌘G.
    ///
    /// The separators must therefore be git's own `%x00` / `%x1e` *format escapes* — four ASCII
    /// characters that git expands in its **output** — not literal control characters in the
    /// argument. Passing `%x00` in a shell and writing `"\u{0}"` in Swift produce identical
    /// output and completely different arguments, which is exactly how this got through.
    func testLogArgumentsContainNoControlCharacters() {
        // The offending scalars are named, never interpolated: a failure message carrying a
        // raw NUL is itself unprintable and takes the test runner down with it.
        for (index, argument) in CommitHistory.logArguments(base: "master").enumerated() {
            let bad = argument.unicodeScalars
                .filter { $0.value < 0x20 }
                .map { String(format: "U+%04X", $0.value) }
            XCTAssertTrue(bad.isEmpty,
                          "argument \(index) carries control characters \(bad.joined(separator: ", ")) "
                          + "— Process.run() cannot form a C string from a NUL")
        }
    }

    /// And the format has to actually ask git for those bytes.
    func testLogFormatUsesGitsEscapes() {
        let format = CommitHistory.logArguments(base: "master")
            .first { $0.hasPrefix("--format=") } ?? ""
        XCTAssertTrue(format.contains("%x00"), "fields must be NUL-separated in the output")
        XCTAssertTrue(format.contains("%x1e"), "records must be RS-terminated in the output")
    }

    /// The Commits scope asks for `base..HEAD`; the cherry-pick picker asks for `HEAD..<ref>`
    /// — what that branch has and this one does not. One builder, so the two cannot drift in
    /// format, which matters because `parse` is shared.
    func testLogArgumentsTakeAnArbitraryRange() {
        let args = CommitHistory.logArguments(range: "HEAD..feature/auth")
        XCTAssertEqual(args.first, "log")
        XCTAssertTrue(args.contains("HEAD..feature/auth"))
        XCTAssertEqual(args.first { $0.hasPrefix("--format=") },
                       CommitHistory.logArguments(base: "master")
                           .first { $0.hasPrefix("--format=") })
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
