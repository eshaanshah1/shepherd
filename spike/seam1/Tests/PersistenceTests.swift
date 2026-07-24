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

    func testStrippingSessionIDsClearsAllPanesButKeepsLayout() throws {
        // A split tab with two agent panes + an ephemeral, all carrying session ids.
        var t = tab("left", cwd: "/tmp/a", sessionID: "sess-left")
        let leftID = t.root.firstLeafID!
        var right = Pane(paneID: UUID().uuidString); right.cwd = "/tmp/b"; right.sessionID = "sess-right"
        _ = t.root.split(paneID: leftID, axis: .row, newPane: right)
        let ws = Workspace(userTitle: "proj", tabs: [t])
        var state = snapshotState([ws], selectedWorkspaceID: ws.id,
                                  ephemeral: [EphemeralPane(pane: { var p = Pane(); p.sessionID = "sess-eph"; return p }(), collapsed: true)])

        state = state.strippingSessionIDs()

        let panes = state.workspaces[0].tabs[0].root.panes
        XCTAssertEqual(panes.count, 2)                                   // layout preserved
        XCTAssertTrue(panes.allSatisfy { $0.sessionID == nil })          // no agent resumes
        XCTAssertEqual(panes.map(\.cwd), ["/tmp/a", "/tmp/b"])           // cwds intact
        XCTAssertNil(state.ephemeral?.first?.sessionID)
    }

    func testClaudeResumeInput() {
        XCTAssertEqual(claudeResumeInput(sessionID: "abc-123"), "claude --resume abc-123\n")
    }

    func testDefaultPathRoundTrips() throws {
        let ws = Workspace(userTitle: "proj", tabs: [tab("t")], defaultPath: "~/dev/shepherd")
        let data = try JSONEncoder().encode(snapshotState([ws], selectedWorkspaceID: ws.id))
        let rebuilt = buildWorkspaces(from: try JSONDecoder().decode(PersistedState.self, from: data))
        XCTAssertEqual(rebuilt[0].defaultPath, "~/dev/shepherd")
    }

    func testMissingDefaultPathKeyDecodesToNil() throws {
        // A nil optional is OMITTED by JSONEncoder, so this blob is shaped like a pre-feature one.
        let ws = Workspace(tabs: [tab("t")])   // defaultPath nil
        let data = try JSONEncoder().encode(snapshotState([ws], selectedWorkspaceID: ws.id))
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("defaultPath"))
        let rebuilt = buildWorkspaces(from: try JSONDecoder().decode(PersistedState.self, from: data))
        XCTAssertNil(rebuilt.first?.defaultPath)
    }

    func testEmptyWorkspaceSurvivesRoundTrip() throws {
        let empty = Workspace(userTitle: "cleared", tabs: [])
        let data = try JSONEncoder().encode(snapshotState([empty], selectedWorkspaceID: empty.id))
        let rebuilt = buildWorkspaces(from: try JSONDecoder().decode(PersistedState.self, from: data))
        XCTAssertEqual(rebuilt.count, 1)                 // NOT dropped
        XCTAssertTrue(rebuilt[0].tabs.isEmpty)
        XCTAssertNil(rebuilt[0].selectedTabID)
        XCTAssertEqual(rebuilt[0].userTitle, "cleared")
    }

    func testMixedEmptyAndNonEmptyWorkspacesRoundTrip() throws {
        let empty = Workspace(userTitle: "empty", tabs: [])
        let full = Workspace(userTitle: "full", tabs: [tab("t")])
        let data = try JSONEncoder().encode(snapshotState([empty, full], selectedWorkspaceID: full.id))
        let rebuilt = buildWorkspaces(from: try JSONDecoder().decode(PersistedState.self, from: data))
        XCTAssertEqual(rebuilt.map(\.userTitle), ["empty", "full"])
        XCTAssertTrue(rebuilt[0].tabs.isEmpty)
        XCTAssertEqual(rebuilt[1].tabs.count, 1)
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

    func testWorkspaceIDSurvivesSnapshotRoundTrip() throws {
        // The stable id is what worktree archives key on to reopen in the same folder.
        let ws = Workspace(userTitle: "WS", tabs: [tab("one", cwd: "/tmp/a")])
        let data = try JSONEncoder().encode(snapshotState([ws], selectedWorkspaceID: ws.id))
        let rebuilt = buildWorkspaces(from: try JSONDecoder().decode(PersistedState.self, from: data))
        XCTAssertEqual(rebuilt.first?.id, ws.id)
    }

    func testOldBlobWithoutWorkspaceIDGetsFreshID() throws {
        let json = #"{"workspaces":[{"userTitle":"WS","selectedTabIndex":0,"tabs":[]}],"selectedWorkspaceIndex":0}"#
        let state = try JSONDecoder().decode(PersistedState.self, from: Data(json.utf8))
        let rebuilt = buildWorkspaces(from: state)
        XCTAssertEqual(rebuilt.count, 1)
        XCTAssertFalse(rebuilt[0].id.isEmpty)   // regenerated, not empty
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

    func testWorktreeHookSurvivesRoundTrip() {
        let ws = Workspace(userTitle: "W", tabs: [Tab(pane: Pane())],
                           worktreeHook: "cp \"$WORKTREE_SRC/.env\" \"$WORKTREE_DIR/.env\"")
        let snap = snapshotState([ws], selectedWorkspaceID: ws.id)
        let rebuilt = buildWorkspaces(from: snap)
        XCTAssertEqual(rebuilt.first?.worktreeHook,
                       "cp \"$WORKTREE_SRC/.env\" \"$WORKTREE_DIR/.env\"")
    }

    func testOldBlobDecodesWithNilHook() throws {
        let json = #"{"selectedTabIndex":0,"tabs":[]}"#.data(using: .utf8)!
        let pw = try JSONDecoder().decode(PersistedWorkspace.self, from: json)
        XCTAssertNil(pw.worktreeHook)
    }

    func testEphemeralRoundTripRestoresCollapsedShellWithSessionAndCwd() {
        var p = Pane()
        p.cwd = "/Users/x"; p.sessionID = "sess-1"; p.userTitle = "scratch"; p.state = .working
        let live = [EphemeralPane(pane: p, collapsed: false)]

        let snap = snapshotEphemerals(live)
        XCTAssertEqual(snap.count, 1)
        XCTAssertEqual(snap[0].cwd, "/Users/x")
        XCTAssertEqual(snap[0].sessionID, "sess-1")
        XCTAssertEqual(snap[0].userTitle, "scratch")

        let rebuilt = buildEphemerals(from: snap)
        XCTAssertEqual(rebuilt.count, 1)
        XCTAssertTrue(rebuilt[0].collapsed)                 // always restored to PiP
        XCTAssertEqual(rebuilt[0].pane.state, .shell)       // live state never persists
        XCTAssertEqual(rebuilt[0].pane.cwd, "/Users/x")
        XCTAssertEqual(rebuilt[0].pane.sessionID, "sess-1")
        XCTAssertEqual(rebuilt[0].pane.userTitle, "scratch")
    }

    func testBuildEphemeralsNilYieldsEmpty() {
        XCTAssertTrue(buildEphemerals(from: nil).isEmpty)
    }

    func testPersistedStateDecodesWithoutEphemeralField() throws {
        // A pre-feature blob has no `ephemeral` key — must still decode (nil).
        let json = #"{"workspaces":[],"selectedWorkspaceIndex":0}"#
        let state = try JSONDecoder().decode(PersistedState.self, from: Data(json.utf8))
        XCTAssertNil(state.ephemeral)
    }
}
