import XCTest
@testable import Shepherd

final class NudgeRegistryTests: XCTestCase {

    // MARK: fixtures

    private func facts(conflicts: Int = 0,
                       operation: MergeState.Operation = .none,
                       dirty: Int = 0,
                       ahead: Int = 0,
                       agentState: AgentState = .idle,
                       hasPR: Bool = false,
                       workbenchOpen: Bool = false,
                       isRemote: Bool = false,
                       provisioning: Bool = false,
                       ghInstalled: Bool = true,
                       onboarding: Bool = false) -> PaneFacts {
        var repo = RepoSignals()
        repo.conflicts = conflicts
        repo.dirty = dirty
        repo.ahead = ahead
        repo.state = MergeState(operation: operation, oursLabel: "main",
                                theirsLabel: "feature", progress: nil)
        return PaneFacts(agentState: agentState, repo: repo, hasPR: hasPR,
                         workbenchOpen: workbenchOpen, isRemote: isRemote,
                         provisioning: provisioning, ghInstalled: ghInstalled,
                         onboarding: onboarding)
    }

    private func ids(_ f: PaneFacts) -> [NudgeID] {
        NudgeRegistry.nudges(for: f).map(\.id)
    }

    // MARK: resolveConflicts

    func testConflictsProduceResolveNudge() {
        let n = NudgeRegistry.nudges(for: facts(conflicts: 3, operation: .merge))
        let first = n.first
        XCTAssertEqual(first?.id, .resolveConflicts)
        XCTAssertEqual(first?.count, 3)
        XCTAssertEqual(first?.bar, .always)
        XCTAssertEqual(first?.urgency, .attention)
        XCTAssertEqual(first?.action, .openWorkbench(scope: .files))
    }

    /// A conflicted stash apply — conflicts with no operation. Still resolvable.
    func testLooseConflictsProduceResolveNudge() {
        XCTAssertEqual(ids(facts(conflicts: 1, operation: .none)).first, .resolveConflicts)
    }

    // MARK: continueSequence

    func testActiveSequenceWithNoConflictsProducesContinue() {
        let n = NudgeRegistry.nudges(for: facts(conflicts: 0, operation: .rebase))
        XCTAssertEqual(n.first?.id, .continueSequence)
        XCTAssertEqual(n.first?.bar, .always)
        XCTAssertEqual(n.first?.urgency, .attention)
        XCTAssertNil(n.first?.count, "there is nothing to count once conflicts are resolved")
    }

    func testResolveAndContinueAreMutuallyExclusive() {
        let both = ids(facts(conflicts: 2, operation: .rebase))
        XCTAssertTrue(both.contains(.resolveConflicts))
        XCTAssertFalse(both.contains(.continueSequence))
    }

    // MARK: reviewChanges

    func testDirtyIdlePaneProducesReviewNudge() {
        let n = NudgeRegistry.nudges(for: facts(dirty: 14, agentState: .idle))
        let review = n.first { $0.id == .reviewChanges }
        XCTAssertEqual(review?.count, 14)
        XCTAssertEqual(review?.bar, .firstFire)
        XCTAssertEqual(review?.urgency, .informational)
        XCTAssertEqual(review?.action, .openWorkbench(scope: .workingTree))
    }

    func testDirtyNeedsCheckPaneProducesReviewNudge() {
        XCTAssertTrue(ids(facts(dirty: 1, agentState: .needsCheck)).contains(.reviewChanges))
    }

    /// Mid-turn there is nothing settled to review.
    func testWorkingPaneProducesNoReviewNudge() {
        XCTAssertFalse(ids(facts(dirty: 9, agentState: .working)).contains(.reviewChanges))
    }

    func testCleanTreeProducesNoReviewNudge() {
        XCTAssertFalse(ids(facts(dirty: 0, agentState: .idle)).contains(.reviewChanges))
    }

    /// You are already looking at the diff.
    func testOpenWorkbenchSuppressesReviewNudge() {
        XCTAssertFalse(ids(facts(dirty: 4, agentState: .idle, workbenchOpen: true))
            .contains(.reviewChanges))
    }

    // MARK: createPR

    func testCommitsAheadWithNoPRProducesCreatePR() {
        let n = NudgeRegistry.nudges(for: facts(ahead: 3))
        let pr = n.first { $0.id == .createPR }
        XCTAssertEqual(pr?.count, 3)
        XCTAssertEqual(pr?.bar, .firstFire)
        XCTAssertEqual(pr?.urgency, .informational)
        XCTAssertEqual(pr?.action, .createPR)
    }

    func testExistingPRSuppressesCreatePR() {
        XCTAssertFalse(ids(facts(ahead: 3, hasPR: true)).contains(.createPR))
    }

    /// Every PR feature is gated on `gh`, since a GUI .app misses Homebrew's PATH.
    func testNoGhSuppressesCreatePR() {
        XCTAssertFalse(ids(facts(ahead: 3, ghInstalled: false)).contains(.createPR))
    }

    // MARK: precedence

    func testConflictOutranksReviewAndPR() {
        let order = ids(facts(conflicts: 1, operation: .merge, dirty: 5, ahead: 2))
        XCTAssertEqual(order.first, .resolveConflicts)
    }

    func testReviewOutranksCreatePR() {
        let order = ids(facts(dirty: 5, ahead: 2, agentState: .idle))
        XCTAssertEqual(order, [.reviewChanges, .createPR])
    }

    /// A waiting agent is more urgent than a conflict, so the pane offers no nudge glyph
    /// that could displace the blocked dot.
    func testBlockedAgentOutranksEverything() {
        XCTAssertTrue(NudgeRegistry.nudges(for: facts(conflicts: 2, operation: .merge,
                                                      agentState: .blocked)).isEmpty)
    }

    func testErrorAgentOutranksEverything() {
        XCTAssertTrue(NudgeRegistry.nudges(for: facts(conflicts: 2, operation: .merge,
                                                      agentState: .error)).isEmpty)
    }

    // MARK: suppressions

    func testOnboardingSuppressesEverything() {
        XCTAssertTrue(NudgeRegistry.nudges(for: facts(conflicts: 3, operation: .merge,
                                                      onboarding: true)).isEmpty)
    }

    func testRemoteWorkspaceSuppressesEverything() {
        XCTAssertTrue(NudgeRegistry.nudges(for: facts(conflicts: 3, operation: .merge,
                                                      isRemote: true)).isEmpty)
    }

    func testProvisioningPaneSuppressesEverything() {
        XCTAssertTrue(NudgeRegistry.nudges(for: facts(conflicts: 3, operation: .merge,
                                                      provisioning: true)).isEmpty)
    }

    func testNoRepoProducesNothing() {
        let f = PaneFacts(agentState: .idle, repo: nil, hasPR: false, workbenchOpen: false,
                          isRemote: false, provisioning: false, ghInstalled: true,
                          onboarding: false)
        XCTAssertTrue(NudgeRegistry.nudges(for: f).isEmpty)
    }

    // MARK: bar policy — independent of urgency

    func testAlwaysBarShowsEvenWhenSeen() {
        let n = NudgeRegistry.nudges(for: facts(conflicts: 1, operation: .merge))[0]
        XCTAssertTrue(NudgeRegistry.showsBar(n, seen: [NudgeID.resolveConflicts.rawValue]))
    }

    func testFirstFireBarShowsOnceThenNever() {
        let n = NudgeRegistry.nudges(for: facts(dirty: 2, agentState: .idle))[0]
        XCTAssertEqual(n.id, .reviewChanges)
        XCTAssertTrue(NudgeRegistry.showsBar(n, seen: []))
        XCTAssertFalse(NudgeRegistry.showsBar(n, seen: [NudgeID.reviewChanges.rawValue]))
    }

    /// `bar` and `urgency` are separate axes. Collapsing them is the obvious future
    /// regression, so it is pinned: an informational nudge can still be barred, and an
    /// attention nudge's bar policy says nothing about the badge.
    func testBarAndUrgencyAreIndependent() {
        let conflict = NudgeRegistry.nudges(for: facts(conflicts: 1, operation: .merge))[0]
        let review = NudgeRegistry.nudges(for: facts(dirty: 2, agentState: .idle))[0]
        XCTAssertEqual(conflict.urgency, .attention)
        XCTAssertEqual(conflict.bar, .always)
        XCTAssertEqual(review.urgency, .informational)
        XCTAssertEqual(review.bar, .firstFire)
    }

    // MARK: catalogue integrity

    func testEveryNudgeIDIsReachable() {
        var seen = Set<NudgeID>()
        seen.formUnion(ids(facts(conflicts: 1, operation: .merge)))
        seen.formUnion(ids(facts(operation: .rebase)))
        seen.formUnion(ids(facts(dirty: 3, ahead: 1, agentState: .idle)))
        XCTAssertEqual(seen, Set(NudgeID.allCases))
    }

    func testRawValuesAreStableAndUnique() {
        // These strings are persisted in `shepherd.nudge.seen` — renaming one silently
        // re-shows a tip the user already dismissed.
        XCTAssertEqual(Set(NudgeID.allCases.map(\.rawValue)).count, NudgeID.allCases.count)
        XCTAssertEqual(NudgeID.reviewChanges.rawValue, "reviewChanges")
        XCTAssertEqual(NudgeID.createPR.rawValue, "createPR")
    }
}
