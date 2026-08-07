import XCTest
@testable import Shepherd

final class ClaudeProfilesTests: XCTestCase {
    private let work = ClaudeProfile(id: "w", name: "Work", configDir: "~/.claude-work")
    private let personal = ClaudeProfile(id: "p", name: "Personal", configDir: "/tmp/x")

    // MARK: environment

    /// The one that would log everyone out: Claude Code hashes CLAUDE_CONFIG_DIR into its
    /// macOS Keychain service name *iff the variable is set*, so the default profile must
    /// export nothing at all — not even the path it would resolve to.
    func testDefaultProfileInjectsNoEnvironment() {
        XCTAssertTrue(ClaudeProfiles.environment(for: ClaudeProfiles.defaultProfile).isEmpty)
        XCTAssertTrue(ClaudeProfiles.environment(for: ClaudeProfile(name: "Blank", configDir: "  ")).isEmpty)
    }

    func testProfileInjectsExpandedConfigDir() {
        let env = ClaudeProfiles.environment(for: work)
        XCTAssertEqual(env["CLAUDE_CONFIG_DIR"],
                       (NSHomeDirectory() as NSString).appendingPathComponent(".claude-work"))
        XCTAssertEqual(env.count, 1)
    }

    // MARK: resolution

    func testPaneOverrideBeatsWorkspaceBeatsDefault() {
        let all = [work, personal]
        XCTAssertEqual(ClaudeProfiles.resolve(paneOverride: "p", workspace: "w", profiles: all).id, "p")
        XCTAssertEqual(ClaudeProfiles.resolve(paneOverride: nil, workspace: "w", profiles: all).id, "w")
        XCTAssertEqual(ClaudeProfiles.resolve(paneOverride: nil, workspace: nil, profiles: all).id,
                       ClaudeProfiles.defaultID)
    }

    /// An explicit "default" on the pane must win over the workspace's profile, or a tab
    /// can never opt back out of an account its workspace chose.
    func testExplicitDefaultOnPaneWins() {
        XCTAssertEqual(ClaudeProfiles.resolve(paneOverride: ClaudeProfiles.defaultID,
                                              workspace: "w", profiles: [work]).id,
                       ClaudeProfiles.defaultID)
    }

    /// A deleted profile falls back to default rather than to the workspace's account —
    /// inheriting silently would run a pane as somebody it was never pointed at.
    func testDanglingIDFallsBackToDefault() {
        XCTAssertEqual(ClaudeProfiles.resolve(paneOverride: "gone", workspace: nil, profiles: [work]).id,
                       ClaudeProfiles.defaultID)
        XCTAssertEqual(ClaudeProfiles.resolve(paneOverride: "gone", workspace: "w", profiles: [work]).id,
                       ClaudeProfiles.defaultID)
    }

    // MARK: paths

    func testPathsFollowTheConfigDir() {
        XCTAssertEqual(ClaudeProfiles.projectsDir(for: personal), "/tmp/x/projects")
        XCTAssertEqual(ClaudeProfiles.skillsDir(for: personal), "/tmp/x/skills")
        XCTAssertEqual(ClaudePluginInstaller.linkPath(for: personal), "/tmp/x/skills/shepherd")
    }

    func testDefaultPathsAreClaudeCodesOwn() {
        let home = NSHomeDirectory() as NSString
        XCTAssertEqual(ClaudeProfiles.projectsDir(for: .init(id: "default", name: "Default")),
                       home.appendingPathComponent(".claude/projects"))
        // The default account file sits at ~/.claude.json — home root, NOT inside ~/.claude.
        XCTAssertEqual(ClaudeProfiles.accountFile(for: ClaudeProfiles.defaultProfile),
                       home.appendingPathComponent(".claude.json"))
        // A profile's does live inside its dir.
        XCTAssertEqual(ClaudeProfiles.accountFile(for: personal), "/tmp/x/.claude.json")
    }

    // MARK: keychain naming (display only)

    func testKeychainServiceMatchesClaudeCodesConstruction() {
        XCTAssertEqual(ClaudeProfiles.keychainService(for: ClaudeProfiles.defaultProfile),
                       "Claude Code-credentials")
        // sha256("/tmp/x") = 2e56aa36…, sha256("$HOME/.claude-personal") = 4b3b1072…
        XCTAssertEqual(ClaudeProfiles.keychainService(for: personal),
                       "Claude Code-credentials-2e56aa36")
        XCTAssertEqual(ClaudeProfiles.keychainService(for: .init(name: "P", configDir: "~/.claude-personal")),
                       "Claude Code-credentials-4b3b1072")
    }

    // MARK: validation

    func testValidation() {
        XCTAssertNil(ClaudeProfiles.validate(configDir: "~/.claude-work"))
        XCTAssertNotNil(ClaudeProfiles.validate(configDir: ""))
        XCTAssertNotNil(ClaudeProfiles.validate(configDir: "relative/path"))
        // Pointing a profile at the default dir is the trap in testDefaultProfileInjects…
        XCTAssertNotNil(ClaudeProfiles.validate(configDir: "~/.claude"))
    }

    // MARK: persistence

    func testWorkspaceAndPaneProfilesRoundTrip() throws {
        var pane = Pane()
        pane.claudeProfileID = "p"
        var ws = Workspace(tabs: [Tab(pane: pane)])
        ws.claudeProfileID = "w"
        let state = snapshotState([ws], selectedWorkspaceID: ws.id)
        let data = try JSONEncoder().encode(state)
        let back = buildWorkspaces(from: try JSONDecoder().decode(PersistedState.self, from: data))
        XCTAssertEqual(back.first?.claudeProfileID, "w")
        XCTAssertEqual(back.first?.tabs.first?.root.panes.first?.claudeProfileID, "p")
    }

    /// Blobs written before this feature carry neither field and must still decode.
    func testPreFeatureBlobDecodes() throws {
        let json = """
        {"workspaces":[{"userTitle":"Old","selectedTabIndex":0,
          "tabs":[{"root":{"kind":"leaf","pane":{"cwd":"/tmp"}}}]}],"selectedWorkspaceIndex":0}
        """
        let state = try JSONDecoder().decode(PersistedState.self, from: Data(json.utf8))
        let ws = buildWorkspaces(from: state)
        XCTAssertEqual(ws.count, 1)
        XCTAssertNil(ws[0].claudeProfileID)
        XCTAssertNil(ws[0].tabs[0].root.panes[0].claudeProfileID)
    }
}
