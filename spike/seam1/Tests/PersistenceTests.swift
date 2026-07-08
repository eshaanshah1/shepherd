import XCTest

final class PersistenceTests: XCTestCase {
    private func tab(_ title: String?, cwd: String? = nil, sessionID: String? = nil) -> Tab {
        var p = Pane(paneID: UUID().uuidString)
        p.userTitle = title; p.cwd = cwd; p.sessionID = sessionID
        return Tab(pane: p)
    }

    func testSessionIDSurvivesSnapshotRoundTrip() throws {
        let t = tab("agent", cwd: "/tmp/proj", sessionID: "abc-123")
        let ws = Workspace(tabs: [t])
        let data = try JSONEncoder().encode(snapshotState([ws], selectedWorkspaceID: ws.id))
        let rebuilt = buildWorkspaces(from: try JSONDecoder().decode(PersistedState.self, from: data))
        // sessionID persists so the agent can be resumed; run state does not (fresh shell otherwise).
        XCTAssertEqual(rebuilt[0].tabs[0].root.panes.first?.sessionID, "abc-123")
        XCTAssertEqual(rebuilt[0].tabs[0].root.panes.first?.state, .shell)
    }

    func testClaudeResumeInput() {
        XCTAssertEqual(claudeResumeInput(sessionID: "abc-123"), "claude --resume abc-123\n")
    }

    func testSnapshotRoundTripPreservesStructureAndSelection() throws {
        let t1 = tab("one", cwd: "/tmp/a")
        let t2 = tab("two", cwd: "/tmp/b")
        let ws1 = Workspace(userTitle: "WS", tabs: [t1, t2], selectedTabID: t2.tabID)

        let state = snapshotState([ws1], selectedWorkspaceID: ws1.id)
        XCTAssertEqual(state.workspaces.count, 1)
        XCTAssertEqual(state.workspaces[0].selectedTabIndex, 1)   // t2 selected
        XCTAssertEqual(state.selectedWorkspaceIndex, 0)

        let data = try JSONEncoder().encode(state)
        let back = try JSONDecoder().decode(PersistedState.self, from: data)
        let rebuilt = buildWorkspaces(from: back)

        XCTAssertEqual(rebuilt.count, 1)
        XCTAssertEqual(rebuilt[0].userTitle, "WS")
        XCTAssertEqual(rebuilt[0].tabs.count, 2)
        // selection restored by index (tab ids are regenerated)
        XCTAssertEqual(rebuilt[0].selectedTabID, rebuilt[0].tabs[1].tabID)
        // persisted pane fields survive
        XCTAssertEqual(rebuilt[0].tabs[0].root.panes.first?.userTitle, "one")
        XCTAssertEqual(rebuilt[0].tabs[1].root.panes.first?.cwd, "/tmp/b")
    }

    func testMigrationWrapsLegacyTabsIntoOneWorkspace() throws {
        let legacy = [PersistedTab(userTitle: "a", root: .leaf(Pane(paneID: "x"))),
                      PersistedTab(userTitle: "b", root: .leaf(Pane(paneID: "y")))]
        let data = try JSONEncoder().encode(legacy)

        let migrated = migrateLegacyTabs(data)
        XCTAssertEqual(migrated?.workspaces.count, 1)
        XCTAssertEqual(migrated?.workspaces.first?.tabs.count, 2)
        XCTAssertNil(migrated?.workspaces.first?.userTitle)        // default name
        XCTAssertEqual(migrated?.selectedWorkspaceIndex, 0)

        let rebuilt = buildWorkspaces(from: migrated!)
        XCTAssertEqual(rebuilt.count, 1)
        XCTAssertEqual(rebuilt[0].tabs.count, 2)
    }

    func testCollapsedSurvivesSnapshotRoundTrip() throws {
        let open = Workspace(userTitle: "Open", tabs: [tab("a")], collapsed: false)
        let shut = Workspace(userTitle: "Shut", tabs: [tab("b")], collapsed: true)

        let data = try JSONEncoder().encode(snapshotState([open, shut], selectedWorkspaceID: open.id))
        let rebuilt = buildWorkspaces(from: try JSONDecoder().decode(PersistedState.self, from: data))

        XCTAssertEqual(rebuilt.count, 2)
        XCTAssertFalse(rebuilt[0].collapsed)
        XCTAssertTrue(rebuilt[1].collapsed)
    }

    // A pre-accordion blob has no `collapsed` key; it must still decode (→ expanded).
    func testLegacyWorkspaceWithoutCollapsedKeyDecodesAsExpanded() throws {
        // Build a real blob, then strip every `collapsed` key to mimic old data.
        let ws = Workspace(userTitle: "Legacy", tabs: [tab("t")], collapsed: true)
        let data = try JSONEncoder().encode(snapshotState([ws], selectedWorkspaceID: ws.id))
        var obj = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        var pws = obj["workspaces"] as! [[String: Any]]
        pws[0].removeValue(forKey: "collapsed")
        obj["workspaces"] = pws
        let stripped = try JSONSerialization.data(withJSONObject: obj)

        let state = try JSONDecoder().decode(PersistedState.self, from: stripped)
        XCTAssertNil(state.workspaces[0].collapsed)
        let rebuilt = buildWorkspaces(from: state)
        XCTAssertEqual(rebuilt.count, 1)
        XCTAssertFalse(rebuilt[0].collapsed)   // nil ⇒ expanded
    }

    func testMigrationReturnsNilForEmptyOrGarbage() {
        XCTAssertNil(migrateLegacyTabs(Data()))
        XCTAssertNil(migrateLegacyTabs("not json".data(using: .utf8)!))
        let empty = try! JSONEncoder().encode([PersistedTab]())
        XCTAssertNil(migrateLegacyTabs(empty))
    }
}
