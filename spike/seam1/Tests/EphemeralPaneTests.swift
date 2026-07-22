import XCTest

final class EphemeralPaneTests: XCTestCase {
    private func makePane(state: AgentState = .shell) -> EphemeralPane {
        var p = Pane()
        p.state = state
        return EphemeralPane(pane: p, collapsed: true)
    }

    func testCapBlocksSixth() {
        XCTAssertTrue(canSpawnEphemeral(count: 0))
        XCTAssertTrue(canSpawnEphemeral(count: 4))
        XCTAssertFalse(canSpawnEphemeral(count: 5))
        XCTAssertFalse(canSpawnEphemeral(count: 6))
    }

    func testExpandingOneCollapsesAllOthers() {
        let a = makePane(), b = makePane(), c = makePane()
        let panes = [a, b, c]
        let expanded = collapsingAllExcept(b.id, in: panes)
        XCTAssertEqual(expanded.filter { !$0.collapsed }.count, 1)
        XCTAssertFalse(expanded.first { $0.id == b.id }!.collapsed)
        XCTAssertTrue(expanded.first { $0.id == a.id }!.collapsed)
        XCTAssertTrue(expanded.first { $0.id == c.id }!.collapsed)
    }

    func testCollapsingAllExceptNilCollapsesEverything() {
        let panes = [makePane(), makePane()].map { var e = $0; e.collapsed = false; return e }
        let collapsed = collapsingAllExcept(nil, in: panes)
        XCTAssertTrue(collapsed.allSatisfy { $0.collapsed })
    }

    func testAttentionCountOnlyCountsWantsAttentionStates() {
        let panes = [
            makePane(state: .shell), makePane(state: .working), makePane(state: .idle),
            makePane(state: .blocked), makePane(state: .needsCheck), makePane(state: .error),
        ]
        XCTAssertEqual(ephemeralAttentionCount(panes), 3)   // blocked + needsCheck + error
        XCTAssertTrue(anyEphemeralBusy(panes))              // working counts as busy
    }

    func testAnyBusyFalseWhenAllShellOrIdle() {
        let panes = [makePane(state: .shell), makePane(state: .idle)]
        XCTAssertFalse(anyEphemeralBusy(panes))
        XCTAssertEqual(ephemeralAttentionCount(panes), 0)
    }
}
