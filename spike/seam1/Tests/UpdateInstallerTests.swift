import XCTest
@testable import Shepherd

final class UpdateInstallerTests: XCTestCase {
    func testSwapScriptContainsRequiredSteps() {
        let s = UpdateInstaller.swapScript(
            pid: 4242,
            newBundle: "/tmp/unpacked/Shepherd.app",
            installedPath: "/Applications/Shepherd.app",
            logPath: "/tmp/shepherd-update.log")
        XCTAssertTrue(s.contains("kill -0 4242"))                       // waits for the app to quit
        XCTAssertTrue(s.contains("ditto \"/tmp/unpacked/Shepherd.app\" \"/Applications/Shepherd.app\""))
        XCTAssertTrue(s.contains("xattr -dr com.apple.quarantine \"/Applications/Shepherd.app\""))
        XCTAssertTrue(s.contains("open \"/Applications/Shepherd.app\""))
        XCTAssertTrue(s.contains("/tmp/shepherd-update.log"))
    }

    func testSwapScriptOverwriteIsAfterWait() {
        let s = UpdateInstaller.swapScript(pid: 1, newBundle: "/a/Shepherd.app",
                                           installedPath: "/b/Shepherd.app", logPath: "/tmp/x.log")
        let waitIdx = s.range(of: "kill -0 1")!.lowerBound
        let dittoIdx = s.range(of: "ditto \"/a/Shepherd.app\"")!.lowerBound
        XCTAssertLessThan(waitIdx, dittoIdx)  // never overwrite before the app has exited
    }
}
