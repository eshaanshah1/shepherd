import XCTest

final class NotificationRoutingPolicyTests: XCTestCase {

    func testPresentRoutesToLocalSurfacesOnly() {
        XCTAssertEqual(NotificationRoutingPolicy.decide(isAway: false), Routing(local: true, fcm: false))
    }

    func testAwayRoutesToPushOnly() {
        // Away ⇒ NO local surface (no banner, no sound — a closed machine stays silent).
        XCTAssertEqual(NotificationRoutingPolicy.decide(isAway: true), Routing(local: false, fcm: true))
    }

    func testCatchUpTargetsAreOnlyAttentionStates() {
        let panes: [(id: String, state: AgentState)] = [
            ("a", .blocked), ("b", .working), ("c", .needsCheck),
            ("d", .idle), ("e", .error), ("f", .shell),
        ]
        XCTAssertEqual(NotificationRoutingPolicy.catchUpTargets(panes), ["a", "c", "e"])
    }
}
