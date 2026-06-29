import XCTest

final class SleepPolicyTests: XCTestCase {
    func testOffNeverStaysAwake() {
        XCTAssertFalse(shouldStayAwake(mode: .off, hasBusyAgent: true,  thermalSuppressed: false))
        XCTAssertFalse(shouldStayAwake(mode: .off, hasBusyAgent: false, thermalSuppressed: false))
    }
    func testAlwaysStaysAwakeIgnoringBusy() {
        XCTAssertTrue(shouldStayAwake(mode: .always, hasBusyAgent: false, thermalSuppressed: false))
        XCTAssertTrue(shouldStayAwake(mode: .always, hasBusyAgent: true,  thermalSuppressed: false))
    }
    func testWhileAgentsFollowsBusy() {
        XCTAssertTrue (shouldStayAwake(mode: .whileAgents, hasBusyAgent: true,  thermalSuppressed: false))
        XCTAssertFalse(shouldStayAwake(mode: .whileAgents, hasBusyAgent: false, thermalSuppressed: false))
    }
    func testThermalSuppressionBeatsEveryMode() {
        XCTAssertFalse(shouldStayAwake(mode: .always,      hasBusyAgent: true, thermalSuppressed: true))
        XCTAssertFalse(shouldStayAwake(mode: .whileAgents, hasBusyAgent: true, thermalSuppressed: true))
    }
}
