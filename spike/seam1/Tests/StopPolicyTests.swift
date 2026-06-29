import XCTest

/// Covers the pure `applyEvent` transition — especially telling a real turn-end
/// `Stop` from a `Stop` that only pauses to wait on a background agent.
final class StopPolicyTests: XCTestCase {

    // MARK: single-event behavior

    func testUserPromptSubmitStartsTurnAndResetsCount() {
        let t = applyEvent("UserPromptSubmit", detail: "", current: .idle, reason: nil, outstanding: 3)
        XCTAssertEqual(t.state, .working)
        XCTAssertEqual(t.outstanding, 0)
        XCTAssertTrue(t.applied)
    }

    func testStopWithNoBackgroundAgentsFinishesTheTurn() {
        let t = applyEvent("Stop", detail: "", current: .working, reason: nil, outstanding: 0)
        XCTAssertEqual(t.state, .needsCheck)
        XCTAssertFalse(t.heldForBackground)
    }

    func testStopWhileBackgroundAgentOutstandingStaysWorking() {
        let t = applyEvent("Stop", detail: "", current: .working, reason: nil, outstanding: 1)
        XCTAssertEqual(t.state, .working)        // NOT need-to-check — the turn only paused
        XCTAssertTrue(t.heldForBackground)
        XCTAssertEqual(t.outstanding, 1)         // still waiting on it
        XCTAssertTrue(t.applied)
    }

    func testStopWhenNotMidTurnIsIgnored() {
        let t = applyEvent("Stop", detail: "", current: .needsCheck, reason: nil, outstanding: 0)
        XCTAssertFalse(t.applied)
        XCTAssertEqual(t.state, .needsCheck)
    }

    func testAgentToolLaunchIncrementsOutstanding() {
        let t = applyEvent("PreToolUse", detail: "Agent", current: .working, reason: nil, outstanding: 0)
        XCTAssertEqual(t.state, .working)
        XCTAssertEqual(t.outstanding, 1)
    }

    func testNonAgentToolDoesNotCount() {
        let t = applyEvent("PreToolUse", detail: "Bash", current: .working, reason: nil, outstanding: 0)
        XCTAssertEqual(t.outstanding, 0)
    }

    func testSubagentStopDecrementsOutstanding() {
        let t = applyEvent("SubagentStop", detail: "", current: .working, reason: nil, outstanding: 2)
        XCTAssertEqual(t.outstanding, 1)
        XCTAssertEqual(t.state, .working)        // mid-turn → keeps working
    }

    func testSubagentStopFloorsAtZero() {
        // Fail-safe for Workflow-style fan-out where SubagentStops outnumber [Agent] launches.
        let t = applyEvent("SubagentStop", detail: "", current: .working, reason: nil, outstanding: 0)
        XCTAssertEqual(t.outstanding, 0)
    }

    // MARK: the bug — full background-agent turn

    func testBackgroundAgentTurnDoesNotFalselyFinishThenFinishesForReal() {
        var state: AgentState = .idle
        var out = 0
        func step(_ event: String, _ detail: String = "") {
            let t = applyEvent(event, detail: detail, current: state, reason: nil, outstanding: out)
            if t.applied { state = t.state }
            out = t.outstanding
        }

        step("UserPromptSubmit")
        XCTAssertEqual(state, .working); XCTAssertEqual(out, 0)

        step("PreToolUse", "Agent")      // launch a background agent
        XCTAssertEqual(out, 1)

        step("Stop")                     // main loop yields to wait — must NOT read as done
        XCTAssertEqual(state, .working)

        step("SubagentStop")             // background agent finishes
        XCTAssertEqual(out, 0)
        XCTAssertEqual(state, .working)  // resumed work tracks normally

        step("PreToolUse", "Read")       // post-resume work
        XCTAssertEqual(state, .working)

        step("Stop")                     // real end of turn
        XCTAssertEqual(state, .needsCheck)
    }

    func testForegroundSubagentStillFinishesNormally() {
        var state: AgentState = .working
        var out = 0
        func step(_ event: String, _ detail: String = "") {
            let t = applyEvent(event, detail: detail, current: state, reason: nil, outstanding: out)
            if t.applied { state = t.state }
            out = t.outstanding
        }
        step("PreToolUse", "Agent")      // foreground subagent
        step("SubagentStop")             // finishes before the agent stops
        XCTAssertEqual(out, 0)
        step("Stop")
        XCTAssertEqual(state, .needsCheck) // balanced → real done
    }
}
