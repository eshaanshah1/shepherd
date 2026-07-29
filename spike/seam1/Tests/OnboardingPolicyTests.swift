import XCTest
@testable import Shepherd

final class OnboardingPolicyTests: XCTestCase {

    private func preflight(claude: Bool, plugin: Bool, sandbox: Bool) -> Preflight {
        Preflight(claudePath: claude ? "/opt/homebrew/bin/claude" : nil,
                  pluginInstalled: plugin,
                  gitAvailable: true,
                  sandboxBuilt: sandbox)
    }

    func testFullPreflightYieldsTheWholeScriptAndNoSubstitutes() {
        let steps = OnboardingPolicy.steps(for: preflight(claude: true, plugin: true, sandbox: true))
        XCTAssertEqual(steps.map(\.id), OnboardingPolicy.script.map(\.id))
        XCTAssertFalse(steps.contains { $0.id == "agentLegend" })
        XCTAssertFalse(steps.contains { $0.id == "noSandbox" })
    }

    // Missing claude, missing plugin, or both — same outcome: the three live-agent
    // steps go, one legend card replaces them.
    func testLiveAgentStepsCollapseToOneLegendCard() {
        for (c, p) in [(false, true), (true, false), (false, false)] {
            let steps = OnboardingPolicy.steps(for: preflight(claude: c, plugin: p, sandbox: true))
            let ids = steps.map(\.id)
            XCTAssertFalse(ids.contains("agentStart"), "claude=\(c) plugin=\(p)")
            XCTAssertFalse(ids.contains("agentWatched"), "claude=\(c) plugin=\(p)")
            XCTAssertFalse(ids.contains("agentUnwatched"), "claude=\(c) plugin=\(p)")
            XCTAssertEqual(ids.filter { $0 == "agentLegend" }.count, 1, "claude=\(c) plugin=\(p)")
        }
    }

    // The legend takes the dropped steps' slot: after the last step that preceded them,
    // before the first that followed.
    func testLegendCardSitsWhereTheAgentStepsWere() {
        let steps = OnboardingPolicy.steps(for: preflight(claude: false, plugin: false, sandbox: true))
        let ids = steps.map(\.id)
        let legend = ids.firstIndex(of: "agentLegend")!
        let scriptIDs = OnboardingPolicy.script.map(\.id)
        let firstAgent = scriptIDs.firstIndex(of: "agentStart")!
        XCTAssertEqual(ids[legend - 1], scriptIDs[firstAgent - 1])
        XCTAssertEqual(ids[legend + 1], scriptIDs[scriptIDs.firstIndex(of: "agentUnwatched")! + 1])
    }

    func testFailedSandboxDropsEveryRepoStepAndAddsOneCard() {
        let steps = OnboardingPolicy.steps(for: preflight(claude: true, plugin: true, sandbox: false))
        let ids = steps.map(\.id)
        let repoSteps = OnboardingPolicy.script
            .filter { $0.requires.contains(.sandbox) }
            .map(\.id)
        XCTAssertFalse(repoSteps.isEmpty)
        for dropped in repoSteps {
            XCTAssertFalse(ids.contains(dropped), "\(dropped) survived a failed sandbox")
        }
        XCTAssertEqual(ids.filter { $0 == "noSandbox" }.count, 1)
        XCTAssertEqual(ids.first, "welcome")
        XCTAssertEqual(ids.last, "done")
    }

    // A failed sandbox already removed the agent steps; a second substitute card
    // explaining the same absence would be noise.
    func testFailedSandboxDoesNotAlsoAddTheLegendCard() {
        let steps = OnboardingPolicy.steps(for: preflight(claude: false, plugin: false, sandbox: false))
        XCTAssertFalse(steps.contains { $0.id == "agentLegend" })
    }

    func testWelcomeAndDoneSurviveEveryPreflight() {
        for c in [true, false] {
            for p in [true, false] {
                for s in [true, false] {
                    let ids = OnboardingPolicy.steps(for: preflight(claude: c, plugin: p, sandbox: s)).map(\.id)
                    XCTAssertEqual(ids.first, "welcome", "c=\(c) p=\(p) s=\(s)")
                    XCTAssertEqual(ids.last, "done", "c=\(c) p=\(p) s=\(s)")
                }
            }
        }
    }

    func testTeardownIsTheLastStepsActionInEveryPreflight() {
        for s in [true, false] {
            let steps = OnboardingPolicy.steps(for: preflight(claude: true, plugin: true, sandbox: s))
            XCTAssertEqual(steps.last?.action, .teardown)
        }
    }

    func testScriptIDsAreUnique() {
        let ids = OnboardingPolicy.script.map(\.id)
        XCTAssertEqual(Set(ids).count, ids.count, "duplicate step ids in the script")
    }

    func testEveryStepHasCopy() {
        for s in OnboardingPolicy.script + [OnboardingPolicy.agentLegendCard, OnboardingPolicy.noSandboxCard] {
            XCTAssertFalse(s.title.isEmpty, "\(s.id) has no title")
            XCTAssertFalse(s.body.isEmpty, "\(s.id) has no body")
        }
    }

    // Pane/tab indices the tour anchors to must exist by the time their step runs:
    // the split step creates pane 1, the worktree step creates tab 1.
    func testAnchorIndicesNeverExceedOne() {
        for s in OnboardingPolicy.script {
            switch s.anchor {
            case .stateDot(let i): XCTAssertLessThanOrEqual(i, 1, "\(s.id) anchors past pane 1")
            case .tabRow(let i):   XCTAssertLessThanOrEqual(i, 1, "\(s.id) anchors past tab 1")
            default: break
            }
        }
    }

    // The conflict demo merges inside the worktree, because the main clone's tree is
    // dirty and git refuses to merge over a modified index. So the worktree must
    // already exist by the time that step runs.
    func testTheConflictStepComesAfterTheWorktreeStep() {
        let ids = OnboardingPolicy.script.map(\.id)
        XCTAssertLessThan(ids.firstIndex(of: "worktree")!, ids.firstIndex(of: "conflict")!)
    }

    // Every step that asks for something must both say what to do and have a goal to
    // watch — an instruction with no goal can never be ticked off, and a goal with no
    // instruction leaves Next disabled with nothing telling the user why.
    func testInstructionsAndGoalsComeInPairs() {
        for s in OnboardingPolicy.script {
            XCTAssertEqual(s.instruction.isEmpty, s.goal == .none,
                           "\(s.id): instruction and goal disagree")
        }
    }

    // The point of the redesign: the user drives. Only the things they cannot reasonably
    // do by hand stay as performed actions.
    func testOnlyUnperformableStepsActOnTheUsersBehalf() {
        let acting = OnboardingPolicy.script.filter { $0.action != .none }.map(\.id)
        XCTAssertEqual(Set(acting), ["welcome", "terminal", "conflict", "done"])
    }

    // The workbench is the app's largest surface; a single card for it was the original
    // flaw. Guard the sequence against being collapsed back into one.
    func testTheWorkbenchGetsItsOwnSequence() {
        let ids = OnboardingPolicy.script.map(\.id)
        for step in ["workbench", "workbenchStage", "workbenchEdit",
                     "workbenchComment", "workbenchCommits"] {
            XCTAssertTrue(ids.contains(step), "\(step) is missing from the script")
        }
    }

    // An ephemeral pane is a scratch shell; it needs no repo and no agent, so it must
    // survive even the most degraded preflight.
    func testTheEphemeralStepNeedsNothing() {
        let step = OnboardingPolicy.script.first { $0.id == "ephemeral" }
        XCTAssertEqual(step?.requires, [])
        let ids = OnboardingPolicy.steps(for: preflight(claude: false, plugin: false, sandbox: false))
            .map(\.id)
        XCTAssertTrue(ids.contains("ephemeral"))
    }

    func testLiveAgentStepsAlsoRequireTheSandbox() {
        for s in OnboardingPolicy.script where s.requires.contains(.liveAgent) {
            XCTAssertTrue(s.requires.contains(.sandbox), "\(s.id) runs claude without a repo")
        }
    }
}
