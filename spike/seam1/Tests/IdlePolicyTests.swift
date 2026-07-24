import XCTest
@testable import Shepherd

final class IdlePolicyTests: XCTestCase {
    func testAgentStatesGateCorrectly() {
        // A live agent still running/waiting blocks a restart.
        XCTAssertTrue(IdlePolicy.paneBlocksRestart(state: .working, shellHasForegroundProcess: false))
        XCTAssertTrue(IdlePolicy.paneBlocksRestart(state: .blocked, shellHasForegroundProcess: false))
        // A finished/idle/errored agent does NOT block — sessions resume on relaunch.
        XCTAssertFalse(IdlePolicy.paneBlocksRestart(state: .idle, shellHasForegroundProcess: true))
        XCTAssertFalse(IdlePolicy.paneBlocksRestart(state: .needsCheck, shellHasForegroundProcess: true))
        XCTAssertFalse(IdlePolicy.paneBlocksRestart(state: .error, shellHasForegroundProcess: true))
    }

    func testShellPaneGatedByForegroundProcess() {
        XCTAssertTrue(IdlePolicy.paneBlocksRestart(state: .shell, shellHasForegroundProcess: true))
        XCTAssertFalse(IdlePolicy.paneBlocksRestart(state: .shell, shellHasForegroundProcess: false))
    }

    func testAllIdle() {
        XCTAssertTrue(IdlePolicy.allIdle([(.idle, false), (.shell, false), (.needsCheck, true)]))
        XCTAssertFalse(IdlePolicy.allIdle([(.idle, false), (.working, false)]))
        XCTAssertFalse(IdlePolicy.allIdle([(.shell, true)]))
        XCTAssertTrue(IdlePolicy.allIdle([]))
    }
}
