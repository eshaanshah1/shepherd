import Foundation

// MARK: - Pure core (unit-tested)

/// Runs a workspace's worktree-creation hook: user bash that fires right after
/// `git worktree add` succeeds, with the new worktree as cwd and the WORKTREE_* /
/// REPO_NAME vars in the environment.
enum WorktreeHookRunner {
    static func hookEnvironment(worktreeDir: String, src: String, branch: String,
                                name: String, repoName: String) -> [String: String] {
        ["WORKTREE_DIR": worktreeDir,
         "WORKTREE_SRC": src,
         "WORKTREE_BRANCH": branch,
         "WORKTREE_NAME": name,
         "REPO_NAME": repoName]
    }

    struct HookResult { let exitCode: Int32; let output: String }

    // MARK: - Process shell (Foundation only; runs off-main)

    /// Run `script` as one `bash -lc` invocation in `cwd` with `env` overlaid on the
    /// inherited environment. Captures merged stdout+stderr. Never throws — a launch
    /// failure returns exitCode -1 with the error text.
    static func run(script: String, cwd: String, env: [String: String]) -> HookResult {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = ["-lc", script]
        p.currentDirectoryURL = URL(fileURLWithPath: cwd)
        var environment = ProcessInfo.processInfo.environment
        for (k, v) in env { environment[k] = v }
        p.environment = environment
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        do {
            try p.run()
        } catch {
            return HookResult(exitCode: -1, output: "Failed to launch hook: \(error.localizedDescription)")
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return HookResult(exitCode: p.terminationStatus, output: String(data: data, encoding: .utf8) ?? "")
    }
}
