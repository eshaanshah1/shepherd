import XCTest

/// Argv → request-dict parsing for the `shepherd` control CLI. Pure: `buildRequest`
/// never touches the socket, so the whole surface is testable without a running app.
final class ControlClientTests: XCTestCase {

    private func req(_ argv: [String]) -> [String: Any]? {
        buildRequest(verb: argv[0], rest: Array(argv.dropFirst()))
    }

    // MARK: workspace hook

    func testHookGetAndClearNameTheWorkspace() {
        let get = req(["workspace", "hook", "get", "ws2"])
        XCTAssertEqual(get?["cmd"] as? String, "workspace-hook-get")
        XCTAssertEqual(get?["workspace"] as? String, "ws2")

        let clear = req(["workspace", "hook", "clear", "ws2"])
        XCTAssertEqual(clear?["cmd"] as? String, "workspace-hook-clear")
        XCTAssertEqual(clear?["workspace"] as? String, "ws2")
    }

    func testHookSetTakesALiteralScript() {
        let r = req(["workspace", "hook", "set", "ws1", "echo hi"])
        XCTAssertEqual(r?["cmd"] as? String, "workspace-hook-set")
        XCTAssertEqual(r?["workspace"] as? String, "ws1")
        XCTAssertEqual(r?["script"] as? String, "echo hi")
    }

    /// A hook is a multi-line bash script; every byte of the file has to survive,
    /// trailing newline included, or a round-trip through `get` isn't byte-identical.
    func testHookSetFromFileIsVerbatim() throws {
        let script = "set -u\n\nfor d in a b; do\n  ln -sfn \"$WORKTREE_SRC/$d\" .\ndone\n"
        let path = (NSTemporaryDirectory() as NSString).appendingPathComponent("hook-\(UUID().uuidString).sh")
        try script.write(toFile: path, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(atPath: path) }

        let r = req(["workspace", "hook", "set", "ws1", "--file", path])
        XCTAssertEqual(r?["cmd"] as? String, "workspace-hook-set")
        XCTAssertEqual(r?["script"] as? String, script)
    }

    func testHookRejectsMissingPieces() {
        XCTAssertNil(req(["workspace", "hook"]))              // no action
        XCTAssertNil(req(["workspace", "hook", "get"]))        // no workspace
        XCTAssertNil(req(["workspace", "hook", "bogus", "ws1"]))
        XCTAssertNil(req(["workspace", "hook", "set", "ws1"]))            // no script
        XCTAssertNil(req(["workspace", "hook", "set", "ws1", "--file"]))  // flag with no path
    }

    // MARK: tab new

    func testTabNewWorktreePassesTheBranchUnresolved() {
        let r = req(["tab", "new", "ws1", "--worktree", "feat/thing"])
        XCTAssertEqual(r?["cmd"] as? String, "tab-new")
        XCTAssertEqual(r?["workspace"] as? String, "ws1")
        XCTAssertEqual(r?["worktree"] as? String, "feat/thing")
        XCTAssertNil(r?["cwd"])   // a branch is a git ref, never anchored to the shell's cwd
    }

    func testTabNewCwdStillResolves() {
        let r = req(["tab", "new", "--cwd", "/tmp"])
        XCTAssertEqual(r?["cwd"] as? String, "/tmp")
        XCTAssertNil(r?["worktree"])
        XCTAssertNil(r?["workspace"])
    }

    /// A dangling flag used to fall through to the positional list and be read as a
    /// workspace handle, so the error named the wrong thing.
    func testTabNewRejectsFlagsWithNoValue() {
        XCTAssertNil(req(["tab", "new", "--worktree"]))
        XCTAssertNil(req(["tab", "new", "--cwd"]))
    }
}
