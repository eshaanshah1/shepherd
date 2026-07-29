import XCTest
@testable import Shepherd

final class OnboardingGoalTests: XCTestCase {

    func testNoGoalIsAlwaysSatisfied() {
        XCTAssertTrue(OnboardingGoal.none.satisfied(by: TourProgress()))
    }

    func testSplitAndUnsplitReadPaneCount() {
        XCTAssertFalse(OnboardingGoal.splitPane.satisfied(by: TourProgress(demoPaneCount: 1)))
        XCTAssertTrue(OnboardingGoal.splitPane.satisfied(by: TourProgress(demoPaneCount: 2)))
        XCTAssertTrue(OnboardingGoal.unsplitPane.satisfied(by: TourProgress(demoPaneCount: 1)))
        XCTAssertFalse(OnboardingGoal.unsplitPane.satisfied(by: TourProgress(demoPaneCount: 2)))
    }

    // The sandbox ships with one file already staged, so "staged something" has to be a
    // delta against what was there when the step began, never a count above zero.
    func testStagingIsMeasuredAgainstABaseline() {
        let untouched = TourProgress(stagedCount: 1, stagedBaseline: 1)
        XCTAssertFalse(OnboardingGoal.stagedSomething.satisfied(by: untouched))
        let staged = TourProgress(stagedCount: 2, stagedBaseline: 1)
        XCTAssertTrue(OnboardingGoal.stagedSomething.satisfied(by: staged))
    }

    // A turn that ended under the user's eyes must NOT satisfy the away step — that
    // contrast is the whole reason both steps exist.
    func testWatchedTurnDoesNotSatisfyTheAwayGoal() {
        let watched = TourProgress(turnFinishedWatched: true)
        XCTAssertTrue(OnboardingGoal.turnFinished.satisfied(by: watched))
        XCTAssertFalse(OnboardingGoal.turnFinishedAway.satisfied(by: watched))

        let away = TourProgress(turnFinishedAway: true)
        XCTAssertTrue(OnboardingGoal.turnFinishedAway.satisfied(by: away))
        XCTAssertTrue(OnboardingGoal.turnFinished.satisfied(by: away))
    }

    func testWorktreeGoalNeedsASecondTab() {
        XCTAssertFalse(OnboardingGoal.worktreeTab.satisfied(by: TourProgress(demoTabCount: 1)))
        XCTAssertTrue(OnboardingGoal.worktreeTab.satisfied(by: TourProgress(demoTabCount: 2)))
    }

    func testSimpleFlagGoals() {
        XCTAssertTrue(OnboardingGoal.ephemeralOpen.satisfied(by: TourProgress(ephemeralOpen: true)))
        XCTAssertTrue(OnboardingGoal.agentRunning.satisfied(by: TourProgress(agentRunning: true)))
        XCTAssertTrue(OnboardingGoal.workbenchOpen.satisfied(by: TourProgress(workbenchOpen: true)))
        XCTAssertTrue(OnboardingGoal.bufferDirty.satisfied(by: TourProgress(bufferDirty: true)))
        XCTAssertTrue(OnboardingGoal.commented.satisfied(by: TourProgress(commentCount: 1)))
        XCTAssertTrue(OnboardingGoal.commitsScope.satisfied(by: TourProgress(inCommitsScope: true)))
        XCTAssertTrue(OnboardingGoal.cheatsheetOpen.satisfied(by: TourProgress(cheatsheetOpen: true)))
        XCTAssertFalse(OnboardingGoal.commented.satisfied(by: TourProgress()))
    }
}
