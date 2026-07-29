import XCTest
@testable import Shepherd

final class ClaudePluginInstallerTests: XCTestCase {
    private let bundled = "/Applications/Shepherd.app/Contents/Resources/claude-plugin"

    func testNoBundledCopyIsUnavailable() {
        XCTAssertEqual(ClaudePluginInstaller.state(entry: .absent, bundled: nil), .unavailable)
        // Even a matching link reads unavailable — there is nothing to point at.
        XCTAssertEqual(ClaudePluginInstaller.state(entry: .symlink(destination: bundled), bundled: nil),
                       .unavailable)
    }

    func testAbsentIsInstallable() {
        let s = ClaudePluginInstaller.state(entry: .absent, bundled: bundled)
        XCTAssertEqual(s, .notInstalled)
        XCTAssertTrue(s.canInstall)
    }

    func testLinkToOurBundleIsInstalled() {
        XCTAssertEqual(ClaudePluginInstaller.state(entry: .symlink(destination: bundled), bundled: bundled),
                       .installed)
    }

    /// A trailing slash on either side must not read as a different plugin.
    func testTrailingSlashStillCountsAsInstalled() {
        XCTAssertEqual(ClaudePluginInstaller.state(entry: .symlink(destination: bundled + "/"), bundled: bundled),
                       .installed)
        XCTAssertEqual(ClaudePluginInstaller.state(entry: .symlink(destination: bundled), bundled: bundled + "/"),
                       .installed)
    }

    /// A source checkout's symlink is somebody's working setup — never replaced.
    func testForeignLinkIsLeftAlone() {
        let other = "/Users/me/dev/shepherd/claude-plugin"
        let s = ClaudePluginInstaller.state(entry: .symlink(destination: other), bundled: bundled)
        XCTAssertEqual(s, .linkedElsewhere(other))
        XCTAssertFalse(s.canInstall)
    }

    /// A real dir/file may be a hand-made install; installing over it would delete it.
    func testRealEntryIsOccupiedAndNotInstallable() {
        for entry in [SkillsEntry.directory, .file] {
            let s = ClaudePluginInstaller.state(entry: entry, bundled: bundled)
            XCTAssertEqual(s, .occupied)
            XCTAssertFalse(s.canInstall)
        }
    }

    func testNormalizeOnlyStripsTrailingSlashes() {
        XCTAssertEqual(ClaudePluginInstaller.normalize("/a/b/"), "/a/b")
        XCTAssertEqual(ClaudePluginInstaller.normalize("/a/b///"), "/a/b")
        XCTAssertEqual(ClaudePluginInstaller.normalize("/a/b"), "/a/b")
        // Root must survive — stripping to "" would make every comparison wrong.
        XCTAssertEqual(ClaudePluginInstaller.normalize("/"), "/")
    }
}
