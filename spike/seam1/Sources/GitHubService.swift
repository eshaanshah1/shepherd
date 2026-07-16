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

    /// The PR's inline review threads via GraphQL (thread ids + resolved/outdated + comments
    /// in one call). Returns nil on a `gh` failure; [] when the PR has no threads. Off-main.
    static func reviewThreads(owner: String, repo: String, number: Int, inDir dir: String) -> [GHReviewThread]? {
        guard let gh = executablePath else { return nil }
        let query = "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved isOutdated path line diffSide comments(first:100){nodes{id databaseId body createdAt author{login}}}}}}}}"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: gh)
        p.arguments = ["api", "graphql", "-f", "query=\(query)",
                       "-f", "owner=\(owner)", "-f", "repo=\(repo)", "-F", "number=\(number)"]
        p.currentDirectoryURL = URL(fileURLWithPath: dir)
        p.environment = augmentedEnv
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        do { try p.run() } catch { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        _ = err.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else { return nil }
        return PRThreads.parse(data)
    }

    /// Post a reply into an existing review thread. True on success. Off-main.
    static func replyToThread(id: String, body: String, inDir dir: String) -> Bool {
        let mutation = "mutation($threadId:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){comment{id}}}"
        return runGraphQL(query: mutation, stringVars: ["threadId": id, "body": body], inDir: dir)
    }

    /// Resolve / unresolve a review thread. True on success. Off-main.
    static func setThreadResolved(id: String, _ resolved: Bool, inDir dir: String) -> Bool {
        let field = resolved ? "resolveReviewThread" : "unresolveReviewThread"
        let mutation = "mutation($threadId:ID!){\(field)(input:{threadId:$threadId}){thread{id isResolved}}}"
        return runGraphQL(query: mutation, stringVars: ["threadId": id], inDir: dir)
    }

    /// Run a GraphQL mutation with string variables; true iff `gh` exits 0.
    private static func runGraphQL(query: String, stringVars: [String: String], inDir dir: String) -> Bool {
        guard let gh = executablePath else { return false }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: gh)
        var args = ["api", "graphql", "-f", "query=\(query)"]
        for (k, v) in stringVars { args += ["-f", "\(k)=\(v)"] }
        p.arguments = args
        p.currentDirectoryURL = URL(fileURLWithPath: dir)
        p.environment = augmentedEnv
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        do { try p.run() } catch { return false }
        _ = out.fileHandleForReading.readDataToEndOfFile()
        _ = err.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return p.terminationStatus == 0
    }
}
