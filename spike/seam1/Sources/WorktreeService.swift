import Foundation

// MARK: - Pure core (unit-tested)

/// Shepherd-specific settings parsed from its own config file.
struct ShepherdConfig: Equatable {
    var worktreeBase: String? = nil
}

/// Parse Shepherd directives out of the ghostty-syntax `~/.config/shepherd/config`.
/// They ride ghostty COMMENT lines (`# shepherd: key = value`) so libghostty ignores
/// them — keeping the single file valid ghostty syntax with no config-error noise.
/// Tolerant of extra whitespace after `#` and around the `=`.
func parseShepherdConfig(_ contents: String) -> ShepherdConfig {
    var cfg = ShepherdConfig()
    for raw in contents.split(whereSeparator: \.isNewline) {
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("#") else { continue }
        let afterHash = String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces)
        guard afterHash.hasPrefix("shepherd:") else { continue }
        let body = afterHash.dropFirst("shepherd:".count).trimmingCharacters(in: .whitespaces)
        guard let eq = body.firstIndex(of: "=") else { continue }
        let key = body[..<eq].trimmingCharacters(in: .whitespaces)
        let value = body[body.index(after: eq)...].trimmingCharacters(in: .whitespaces)
        guard !value.isEmpty else { continue }
        if key == "worktree-base" { cfg.worktreeBase = value }
    }
    return cfg
}

/// `<base>/<repo-folder-basename>/<name>`.
func worktreePath(base: String, repoDir: String, name: String) -> String {
    let repoName = (repoDir as NSString).lastPathComponent
    let underRepo = (base as NSString).appendingPathComponent(repoName)
    return (underRepo as NSString).appendingPathComponent(name)
}

/// `git worktree add` args — reuse an existing branch, else create it off `baseRef`
/// (origin's freshly-fetched default branch; fetch + detection happen in `Git.addWorktree`).
func worktreeAddArgs(dest: String, name: String, branchExists: Bool, baseRef: String) -> [String] {
    branchExists ? ["worktree", "add", dest, name]
                 : ["worktree", "add", dest, "-b", name, baseRef]
}

// MARK: - git shell (app target only; not unit-tested)

enum Git {
    /// Run `git -C <dir> <args>`; returns exit code + captured stdout/stderr.
    static func run(_ args: [String], in dir: String) -> (code: Int32, out: String, err: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = ["git", "-C", dir] + args
        let outPipe = Pipe(), errPipe = Pipe()
        p.standardOutput = outPipe
        p.standardError = errPipe
        do { try p.run() } catch { return (-1, "", "\(error)") }
        // git worktree output is tiny, so read-to-EOF before wait can't deadlock the pipe buffer.
        let out = String(data: outPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let err = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        p.waitUntilExit()
        return (p.terminationStatus, out, err)
    }

    static func isWorkTree(_ dir: String) -> Bool {
        run(["rev-parse", "--is-inside-work-tree"], in: dir)
            .out.trimmingCharacters(in: .whitespacesAndNewlines) == "true"
    }

    static func branchExists(_ name: String, in dir: String) -> Bool {
        run(["show-ref", "--verify", "--quiet", "refs/heads/\(name)"], in: dir).code == 0
    }

    /// origin's default branch as a start-point ref (e.g. "origin/main" / "origin/master"),
    /// read from the `origin/HEAD` symref. If it isn't set locally, ask the remote to point
    /// it (`set-head --auto`) and re-read; falls back to "origin/main" as a last resort.
    static func defaultBaseRef(in dir: String) -> String {
        func readHead() -> String? {
            let r = run(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], in: dir)
            let ref = r.out.trimmingCharacters(in: .whitespacesAndNewlines)
            return (r.code == 0 && !ref.isEmpty) ? ref : nil
        }
        if let ref = readHead() { return ref }
        _ = run(["remote", "set-head", "origin", "--auto"], in: dir)
        return readHead() ?? "origin/main"
    }

    static func addWorktree(dest: String, name: String, in dir: String) -> (ok: Bool, err: String) {
        // A new branch is based on origin's default branch, so refresh it first. Fetch is
        // required — if it fails (no remote / offline) we don't silently branch off a stale ref.
        let fetch = run(["fetch", "origin"], in: dir)
        guard fetch.code == 0 else {
            return (false, "git fetch origin failed:\n" + (fetch.err.isEmpty ? fetch.out : fetch.err))
        }
        let r = run(worktreeAddArgs(dest: dest, name: name,
                                    branchExists: branchExists(name, in: dir),
                                    baseRef: defaultBaseRef(in: dir)), in: dir)
        return (r.code == 0, r.err)
    }
}
