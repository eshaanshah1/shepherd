import Foundation

/// `gh` CLI shell (app target only; not unit-tested — the pure parsing/classification
/// lives in `PRStatus.swift`). Infers the repo + branch from the working directory.
/// The whole PR-status feature is gated on `isInstalled`; when `gh` is absent the
/// sidebar keeps its normal state dot.
enum GH {
    private static let fields = "state,isDraft,reviewDecision,statusCheckRollup,mergeStateStatus,number,url"

    /// PATH augmented with the common Homebrew locations a GUI-launched app doesn't
    /// inherit — so `gh` (and the `git` it shells out to) resolve.
    private static var augmentedEnv: [String: String] {
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin")
        return env
    }

    /// Absolute path to `gh`, resolved once, or nil if it isn't installed. Probes the
    /// usual install locations first (a `.app`'s minimal PATH omits Homebrew), then
    /// falls back to `which` under the augmented PATH.
    static let executablePath: String? = {
        let candidates = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"]
        if let hit = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) { return hit }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.environment = augmentedEnv
        p.arguments = ["which", "gh"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = Pipe()
        do { try p.run() } catch { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else { return nil }
        let path = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (path?.isEmpty == false) ? path : nil
    }()

    /// Is `gh` available on this machine? Gate the PR-status feature on this.
    static var isInstalled: Bool { executablePath != nil }

    /// The PR for the branch checked out in `dir`, or nil if there's none (or `gh`
    /// isn't installed / authed for the repo). Runs synchronously — call off-main.
    static func prStatus(inDir dir: String) -> PRStatus? {
        guard let gh = executablePath else { return nil }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: gh)
        p.arguments = ["pr", "view", "--json", fields]
        p.currentDirectoryURL = URL(fileURLWithPath: dir)
        p.environment = augmentedEnv
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        do { try p.run() } catch { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        _ = err.fileHandleForReading.readDataToEndOfFile()   // drain so the pipe can't fill
        p.waitUntilExit()
        guard p.terminationStatus == 0 else { return nil }   // non-zero ⇒ no PR for the branch
        return PR.parse(data)
    }
}
