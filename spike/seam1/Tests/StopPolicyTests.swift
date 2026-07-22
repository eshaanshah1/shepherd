import XCTest

/// Covers the pure `applyEvent` transition — especially telling a real turn-end
/// `Stop` from a `Stop` that only pauses while a background task is still in
/// flight. The in-flight signal is the `Stop` payload's `background_tasks` count
/// (passed through `detail` by `report.sh`), not an event-counting heuristic.
final class StopPolicyTests: XCTestCase {

    // MARK: turn boundaries

    func testUserPromptSubmitStartsTurnFromAnyState() {
        let t = applyEvent("UserPromptSubmit", detail: "", current: .idle, reason: nil)
        XCTAssertEqual(t.state, .working)
        XCTAssertTrue(t.applied)
    }

    func testSessionStartIsIdleAndClearsTitle() {
        let t = applyEvent("SessionStart", detail: "", current: .shell, reason: nil)
        XCTAssertEqual(t.state, .idle)
        XCTAssertTrue(t.clearTitle)
    }

    // MARK: Stop — decided by the background-task count in `detail`

    func testStopWithNoBackgroundTasksFinishesTheTurn() {
        let t = applyEvent("Stop", detail: "0", current: .working, reason: nil)
        XCTAssertEqual(t.state, .needsCheck)
        XCTAssertFalse(t.heldForBackground)
        XCTAssertTrue(t.applied)
    }

    func testStopWithABackgroundTaskStaysWorking() {
        let t = applyEvent("Stop", detail: "1", current: .working, reason: nil)
        XCTAssertEqual(t.state, .working)        // NOT need-to-check — the turn only paused
        XCTAssertTrue(t.heldForBackground)
        XCTAssertTrue(t.applied)
    }

    func testStopWithSeveralBackgroundTasksStaysWorking() {
        let t = applyEvent("Stop", detail: "3", current: .working, reason: nil)
        XCTAssertEqual(t.state, .working)
        XCTAssertTrue(t.heldForBackground)
    }

    func testStopWithEmptyDetailFinishes() {
        // Fail-safe: if `report.sh` could not parse a count (no jq), treat as none
        // in flight and finish — reverts to plain finish-on-Stop, never sticks.
        let t = applyEvent("Stop", detail: "", current: .working, reason: nil)
        XCTAssertEqual(t.state, .needsCheck)
        XCTAssertFalse(t.heldForBackground)
    }

    func testStopWithGarbageDetailFinishes() {
        let t = applyEvent("Stop", detail: "nope", current: .working, reason: nil)
        XCTAssertEqual(t.state, .needsCheck)
    }

    func testStopWhenNotMidTurnIsIgnored() {
        // A stray Stop after the turn already ended must not reopen it, even if a
        // background task is somehow reported.
        let t = applyEvent("Stop", detail: "1", current: .needsCheck, reason: nil)
        XCTAssertFalse(t.applied)
        XCTAssertEqual(t.state, .needsCheck)
    }

    // MARK: subagent / tool events no longer count anything

    func testAgentToolLaunchJustStaysWorking() {
        let t = applyEvent("PreToolUse", detail: "Agent", current: .working, reason: nil)
        XCTAssertEqual(t.state, .working)
        XCTAssertTrue(t.applied)
    }

    func testSubagentStopStaysWorkingMidTurn() {
        let t = applyEvent("SubagentStop", detail: "Explore", current: .working, reason: nil)
        XCTAssertEqual(t.state, .working)
    }

    func testSubagentStopIgnoredWhenNotMidTurn() {
        let t = applyEvent("SubagentStop", detail: "Explore", current: .needsCheck, reason: nil)
        XCTAssertFalse(t.applied)
    }

    func testAskUserQuestionBlocks() {
        let t = applyEvent("PreToolUse", detail: "AskUserQuestion", current: .working, reason: nil)
        XCTAssertEqual(t.state, .blocked)
        XCTAssertEqual(t.reason, "answer needed")
    }

    // MARK: the bug — a turn that pauses on a background agent

    func testBackgroundAgentTurnDoesNotFalselyFinishThenFinishesForReal() {
        var state: AgentState = .idle
        func step(_ event: String, _ detail: String = "") {
            let t = applyEvent(event, detail: detail, current: state, reason: nil)
            if t.applied { state = t.state }
        }

        step("UserPromptSubmit")
        XCTAssertEqual(state, .working)

        step("PreToolUse", "Agent")          // launch a background agent
        XCTAssertEqual(state, .working)

        step("Stop", "1")                    // main loop yields to wait — bg task in flight
        XCTAssertEqual(state, .working)      // must NOT read as done

        step("SubagentStop", "Agent")        // background agent finishes
        XCTAssertEqual(state, .working)      // resumed work tracks normally

        step("PreToolUse", "Read")           // post-resume work
        XCTAssertEqual(state, .working)

        step("Stop", "0")                    // real end of turn, nothing in flight
        XCTAssertEqual(state, .needsCheck)
    }

    func testTurnPausedOnBackgroundShellStaysWorking() {
        // A background shell counts toward suppression too (report.sh allow-lists it).
        let t = applyEvent("Stop", detail: "1", current: .working, reason: nil)
        XCTAssertEqual(t.state, .working)
        XCTAssertTrue(t.heldForBackground)
    }

    func testForegroundSubagentStillFinishesNormally() {
        var state: AgentState = .working
        func step(_ event: String, _ detail: String = "") {
            let t = applyEvent(event, detail: detail, current: state, reason: nil)
            if t.applied { state = t.state }
        }
        step("PreToolUse", "Agent")          // foreground subagent
        step("SubagentStop", "Agent")        // finishes before the agent stops
        step("Stop", "0")                    // nothing backgrounded → real done
        XCTAssertEqual(state, .needsCheck)
    }

    // MARK: session ownership (nested `claude -p` isolation)

    func testUnlockedPaneAcceptsAnySession() {
        // owner nil ⇒ the first SessionStart claims; nothing is dropped beforehand.
        XCTAssertTrue(sessionEventAccepted(sid: "abc", owner: nil))
    }

    func testMissingSessionIdFailsSafeAndIsAccepted() {
        // Old plugin (no `sid`) must behave exactly as before — never stricter.
        XCTAssertTrue(sessionEventAccepted(sid: "", owner: "owner-1"))
    }

    func testOwningSessionEventAccepted() {
        XCTAssertTrue(sessionEventAccepted(sid: "owner-1", owner: "owner-1"))
    }

    func testForeignNestedSessionEventDropped() {
        // A nested `claude -p` reports the parent's pane id with its own session_id.
        XCTAssertFalse(sessionEventAccepted(sid: "nested-2", owner: "owner-1"))
    }

    func testEmptyOwnerAcceptsEvenWithSid() {
        XCTAssertTrue(sessionEventAccepted(sid: "abc", owner: ""))
    }
}
