import XCTest
@testable import Shepherd

final class AgentLaunchTests: XCTestCase {

    private func tmpDir() -> String {
        let d = NSTemporaryDirectory() + "agentlaunch-" + UUID().uuidString
        try? FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
        return d
    }

    /// Run the generated command in a real shell with `printf` standing in for `claude`,
    /// so the assertion is what the agent's argv would actually receive.
    private func runThroughShell(_ command: String) -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = ["-c", command]
        let pipe = Pipe()
        p.standardOutput = pipe
        try? p.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(data: data, encoding: .utf8) ?? ""
    }

    func testPromptSurvivesTheShellVerbatim() {
        let dir = tmpDir()
        let prompt = "Fix the bug in `main`\n\nIt's \"urgent\" — cost is $500 and 100% mine."
        let file = AgentLaunch.prepare(prompt: prompt, dir: dir)
        XCTAssertNotNil(file)
        let cmd = AgentLaunch.command(promptFile: file!, program: "printf %s")
        XCTAssertEqual(runThroughShell(cmd), prompt)
    }

    func testCommandDeletesThePromptFileBeforeTheAgentStarts() {
        let dir = tmpDir()
        let file = AgentLaunch.prepare(prompt: "hello", dir: dir)!
        XCTAssertTrue(FileManager.default.fileExists(atPath: file))
        _ = runThroughShell(AgentLaunch.command(promptFile: file, program: "printf %s"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: file))
    }

    func testCommandIsASingleTypedLine() {
        let cmd = AgentLaunch.command(promptFile: "/tmp/p.txt")
        XCTAssertEqual(cmd.filter { $0 == "\n" }.count, 1)   // only the trailing Enter
        XCTAssertTrue(cmd.hasSuffix("\n"))
        XCTAssertTrue(cmd.contains("claude \"$p\""))
    }

    func testBlankPromptYieldsNoCommand() {
        let dir = tmpDir()
        XCTAssertNil(AgentLaunch.launchCommand(prompt: "   \n ", dir: dir))
        XCTAssertNil(AgentLaunch.prepare(prompt: "", dir: dir))
    }

    func testLaunchCommandWritesAFileTheCommandNames() {
        let dir = tmpDir()
        let cmd = AgentLaunch.launchCommand(prompt: "ship it", dir: dir)
        XCTAssertNotNil(cmd)
        XCTAssertTrue(cmd!.contains(dir))
    }
}
