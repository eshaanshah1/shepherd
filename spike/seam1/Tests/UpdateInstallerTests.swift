import XCTest
@testable import Shepherd

final class UpdateInstallerTests: XCTestCase {
    func testScriptUsesPositionalArgsNotInterpolation() {
        let s = UpdateInstaller.swapScript()
        // Paths arrive as $1…$4 and are only ever referenced through quoted
        // shell variables — never interpolated — so a hostile path can't inject.
        XCTAssertTrue(s.contains(#"pid="$1""#))
        XCTAssertTrue(s.contains(#"newBundle="$2""#))
        XCTAssertTrue(s.contains(#"installedPath="$3""#))
        XCTAssertTrue(s.contains(#"logPath="$4""#))
        XCTAssertTrue(s.contains(#"ditto "$newBundle" "$installedPath""#))
        XCTAssertTrue(s.contains(#"xattr -dr com.apple.quarantine "$installedPath""#))
        XCTAssertTrue(s.contains(#"open "$installedPath""#))
    }

    func testScriptIsDataIndependent() {
        // The script body embeds no concrete path — nothing to break out of.
        let s = UpdateInstaller.swapScript()
        XCTAssertFalse(s.contains("/Applications"))
        XCTAssertFalse(s.contains("/tmp/"))
        XCTAssertFalse(s.contains("Shepherd.app"))
    }

    func testWaitPrecedesOverwrite() {
        let s = UpdateInstaller.swapScript()
        let waitIdx = s.range(of: "kill -0")!.lowerBound
        let dittoIdx = s.range(of: #"ditto "$newBundle""#)!.lowerBound
        XCTAssertLessThan(waitIdx, dittoIdx)  // never overwrite before the app has exited
    }

    func testUniqueTempDirIsPrivateAndDistinct() {
        let a = UpdateInstaller.uniqueTempDir()
        let b = UpdateInstaller.uniqueTempDir()
        XCTAssertNotEqual(a, b)                       // unpredictable, never reused
        var isDir: ObjCBool = false
        XCTAssertTrue(FileManager.default.fileExists(atPath: a, isDirectory: &isDir))
        XCTAssertTrue(isDir.boolValue)
        let perms = (try? FileManager.default.attributesOfItem(atPath: a)[.posixPermissions]) as? NSNumber
        XCTAssertEqual(perms?.intValue, 0o700)        // owner-only
        try? FileManager.default.removeItem(atPath: a)
        try? FileManager.default.removeItem(atPath: b)
    }
}
