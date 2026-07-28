import XCTest
@testable import Shepherd

/// Listing files for `⌘P`. The Files scope is a plain editor, so this has to work in a
/// directory that is not a git repo — which is what `walk` is for.
final class FileListerTests: XCTestCase {

    private var root: String!

    override func setUpWithError() throws {
        try super.setUpWithError()
        root = NSTemporaryDirectory() + "shepherd-lister-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let root { try? FileManager.default.removeItem(atPath: root) }
        try super.tearDownWithError()
    }

    private func write(_ path: String) {
        let full = (root as NSString).appendingPathComponent(path)
        try? FileManager.default.createDirectory(
            atPath: (full as NSString).deletingLastPathComponent,
            withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: full, contents: Data("x".utf8))
    }

    // MARK: - walk

    /// Also the symlink regression test, and the reason it is not written synthetically:
    /// the temp directory is `/var/…`, which is a symlink, and `FileManager` hands back the
    /// `/private/var/…` form. Comparing those unnormalized made every file in the directory
    /// list as an absolute path. Only a real path on disk exercises it — `resolvingSymlinks`
    /// does nothing to one that doesn't exist.
    func testWalkFindsFilesInAPlainDirectory() {
        write("a.txt")
        write("nested/b.swift")
        XCTAssertEqual(FileLister.walk(cwd: root), ["a.txt", "nested/b.swift"])
    }

    func testWalkReturnsPathsRelativeToTheDirectory() {
        write("deep/deeper/c.md")
        XCTAssertEqual(FileLister.walk(cwd: root), ["deep/deeper/c.md"])
    }

    /// The list exists so a naive walk of a home directory doesn't take minutes.
    func testWalkSkipsTheHeavyDirectories() {
        write("keep.swift")
        write("node_modules/pkg/index.js")
        write("build/artifact.o")
        write(".git/config")
        XCTAssertEqual(FileLister.walk(cwd: root), ["keep.swift"])
    }

    func testWalkSkipsHiddenFiles() {
        write("visible.txt")
        write(".hidden")
        XCTAssertEqual(FileLister.walk(cwd: root), ["visible.txt"])
    }

    func testWalkOfAnEmptyDirectoryFindsNothing() {
        XCTAssertTrue(FileLister.walk(cwd: root).isEmpty)
    }

    func testWalkOfAMissingDirectoryIsSafe() {
        XCTAssertTrue(FileLister.walk(cwd: root + "/nope").isEmpty)
    }

    // MARK: - relative

    func testAPathUnderTheDirectoryComesBackRelative() {
        XCTAssertEqual(FileLister.relative("/repo/src/a.swift", to: "/repo"), "src/a.swift")
    }

    func testATrailingSlashOnTheDirectoryIsHandled() {
        XCTAssertEqual(FileLister.relative("/repo/a.swift", to: "/repo/"), "a.swift")
    }

    /// The load-bearing one: a file outside the pane's directory stays absolute, because
    /// `WorkbenchSession.source(of:)` joins relative paths onto `cwd` and would otherwise
    /// produce `/repo/Users/me/elsewhere.txt`.
    func testAPathOutsideTheDirectoryStaysAbsolute() {
        XCTAssertEqual(FileLister.relative("/elsewhere/a.swift", to: "/repo"),
                       "/elsewhere/a.swift")
    }

    /// macOS resolves `/tmp` and `/var` into `/private`, and `FileManager` hands back the
    /// resolved form — so comparing against the unresolved directory left every file in it
    /// looking like it lived somewhere else entirely.
    /// A sibling directory sharing a name prefix is not inside it.
    func testASiblingWithASharedPrefixIsNotTreatedAsInside() {
        XCTAssertEqual(FileLister.relative("/repo-other/a.swift", to: "/repo"),
                       "/repo-other/a.swift")
    }
}

/// `list` unions git's view with the directory walk. Exercised against a real repo because
/// the whole point is what happens when the two disagree.
final class FileListerUnionTests: XCTestCase {

    private var repo: String!

    override func setUpWithError() throws {
        try super.setUpWithError()
        repo = NSTemporaryDirectory() + "shepherd-union-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: repo, withIntermediateDirectories: true)
        git("init", "-b", "main")
        git("config", "user.email", "t@e.com")
        git("config", "user.name", "T")
    }

    override func tearDownWithError() throws {
        if let repo { try? FileManager.default.removeItem(atPath: repo) }
        try super.tearDownWithError()
    }

    private func git(_ args: String...) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["-C", repo] + args
        process.standardOutput = Pipe()
        process.standardError = Pipe()
        try? process.run()
        process.waitUntilExit()
    }

    private func write(_ path: String, _ contents: String = "x") {
        let full = (repo as NSString).appendingPathComponent(path)
        try? FileManager.default.createDirectory(
            atPath: (full as NSString).deletingLastPathComponent,
            withIntermediateDirectories: true)
        try? contents.write(toFile: full, atomically: true, encoding: .utf8)
    }

    /// The reason for the union: an editor that cannot open a gitignored file is not a
    /// general editor, and `git ls-files` will never mention one.
    func testAGitignoredFileIsStillListed() {
        write(".gitignore", "secret.env\n")
        write("tracked.swift")
        write("secret.env")
        git("add", "-A")
        git("commit", "-m", "base")

        let listed = FileLister.list(cwd: repo)
        XCTAssertTrue(listed.contains("tracked.swift"))
        XCTAssertTrue(listed.contains("secret.env"), "gitignored files must still be openable")
    }

    func testEachFileIsListedOnce() {
        write("a.swift")
        git("add", "-A")
        git("commit", "-m", "base")
        let listed = FileLister.list(cwd: repo)
        XCTAssertEqual(listed.filter { $0 == "a.swift" }.count, 1,
                       "git and the walk both see a tracked file")
    }

    /// Tracked files come first, so a repo large enough to hit the walk's cap still surfaces
    /// the files you are most likely to want.
    func testTrackedFilesComeBeforeUntrackedOnes() {
        write(".gitignore", "ignored.txt\n")
        write("ignored.txt")
        write("tracked.swift")
        git("add", "tracked.swift", ".gitignore")
        git("commit", "-m", "base")

        let listed = FileLister.list(cwd: repo)
        let tracked = listed.firstIndex(of: "tracked.swift")
        let ignored = listed.firstIndex(of: "ignored.txt")
        XCTAssertNotNil(tracked)
        XCTAssertNotNil(ignored)
        XCTAssertLessThan(tracked ?? .max, ignored ?? .min)
    }
}
