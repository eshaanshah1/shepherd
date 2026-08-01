import XCTest

final class NotificationRoutingPolicyTests: XCTestCase {

    private func decide(away: Bool = false, viewing: Bool = false,
                        macs: [String] = []) -> Routing {
        NotificationRoutingPolicy.decide(isAway: away, viewing: viewing, macViewers: macs)
    }

    func testPresentRoutesToLocalSurfacesOnly() {
        XCTAssertEqual(decide(),
                       Routing(banner: true, sound: true, chimeDevices: [], fcm: false))
    }

    func testAwayRoutesToPushOnly() {
        // Away ⇒ NO local surface (no banner, no sound — a closed machine stays silent).
        XCTAssertEqual(decide(away: true),
                       Routing(banner: false, sound: false, chimeDevices: [], fcm: true))
    }

    func testViewingHereSuppressesEveryLocalSurface() {
        // ADR 0020: a turn finishing under your eyes is not an alert.
        XCTAssertEqual(decide(viewing: true),
                       Routing(banner: false, sound: false, chimeDevices: [], fcm: false))
    }

    func testStreamingMacChimesAlongsideThePresentHost() {
        XCTAssertEqual(decide(macs: ["mac-1"]),
                       Routing(banner: true, sound: true, chimeDevices: ["mac-1"], fcm: false))
    }

    func testStreamingMacChimesEvenWhileViewingHere() {
        // The deliberate departure from ADR 0020: on a mirror the chime is the point of having
        // the pane open, so it fires even though this Mac stays silent.
        XCTAssertEqual(decide(viewing: true, macs: ["mac-1"]),
                       Routing(banner: false, sound: false, chimeDevices: ["mac-1"], fcm: false))
    }

    func testStreamingMacBeatsThePhoneWhenAway() {
        // A present Mac is a better destination than a push, so FCM stays off.
        XCTAssertEqual(decide(away: true, macs: ["mac-1"]),
                       Routing(banner: false, sound: false, chimeDevices: ["mac-1"], fcm: false))
    }

    func testAwayWithNoMacViewerStillPushes() {
        XCTAssertEqual(decide(away: true, macs: []),
                       Routing(banner: false, sound: false, chimeDevices: [], fcm: true))
    }

    func testCatchUpTargetsAreOnlyAttentionStates() {
        let panes: [(id: String, state: AgentState)] = [
            ("a", .blocked), ("b", .working), ("c", .needsCheck),
            ("d", .idle), ("e", .error), ("f", .shell),
        ]
        XCTAssertEqual(NotificationRoutingPolicy.catchUpTargets(panes), ["a", "c", "e"])
    }
}
