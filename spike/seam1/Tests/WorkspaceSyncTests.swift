import XCTest

/// Per-device workspace selection. The decision itself is one predicate on PairedDevice; the
/// host applies it in RemoteServer (broadcast + the attach snapshot), so getting this wrong
/// leaks a workspace rather than merely mis-drawing one.
final class WorkspaceSyncTests: XCTestCase {

    private func device(_ synced: [String]?) -> PairedDevice {
        PairedDevice(deviceID: "d1", secret: "s", name: "Mac", fcmToken: nil,
                     altSecrets: nil, syncedWorkspaceIDs: synced)
    }

    func testNilMeansEveryWorkspace() {
        // The default, and what every record written before this field decodes to — so an
        // existing pairing keeps mirroring everything with no migration.
        let d = device(nil)
        XCTAssertTrue(d.syncs("ws-a"))
        XCTAssertTrue(d.syncs("anything-at-all"))
    }

    func testEmptyIsARealChoiceAndMirrorsNothing() {
        // Distinct from nil: the user unticked everything.
        let d = device([])
        XCTAssertFalse(d.syncs("ws-a"))
    }

    func testSubsetMirrorsOnlyItsMembers() {
        let d = device(["ws-a", "ws-c"])
        XCTAssertTrue(d.syncs("ws-a"))
        XCTAssertTrue(d.syncs("ws-c"))
        XCTAssertFalse(d.syncs("ws-b"))
    }

    func testSelectionSurvivesACodableRoundTrip() throws {
        // It rides the existing paired-devices blob, so it has to encode and decode.
        let d = device(["ws-a"])
        let back = try JSONDecoder().decode(PairedDevice.self, from: JSONEncoder().encode(d))
        XCTAssertEqual(back.syncedWorkspaceIDs, ["ws-a"])
        XCTAssertTrue(back.syncs("ws-a"))
        XCTAssertFalse(back.syncs("ws-b"))
    }

    func testARecordWithoutTheFieldDecodesAsMirrorEverything() throws {
        // Old blobs on disk have no syncedWorkspaceIDs key at all.
        let json = #"{"deviceID":"d1","secret":"s","name":"Mac"}"#
        let d = try JSONDecoder().decode(PairedDevice.self, from: Data(json.utf8))
        XCTAssertNil(d.syncedWorkspaceIDs)
        XCTAssertTrue(d.syncs("ws-a"))
    }

    func testAcceptingASecretKeepsTheSelection() {
        // accepting() rebuilds the record for a second route; the selection must ride along or
        // pairing the same Mac over the LAN would silently widen it back to everything.
        let d = device(["ws-a"]).accepting("second-secret")
        XCTAssertEqual(d.syncedWorkspaceIDs, ["ws-a"])
        XCTAssertFalse(d.syncs("ws-b"))
    }

    func testCatalogueEntryRoundTrips() throws {
        let e = WorkspaceCatalogueEntry(workspaceID: "ws-a", name: "shepherd", synced: true)
        let back = try JSONDecoder().decode(WorkspaceCatalogueEntry.self,
                                            from: JSONEncoder().encode(e))
        XCTAssertEqual(back, e)
    }
}
