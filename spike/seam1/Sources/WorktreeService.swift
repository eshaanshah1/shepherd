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
    /// `env` overrides the child environment (e.g. `GIT_INDEX_FILE` for a temp index).
    static func run(_ args: [String], in dir: String, env: [String: String]? = nil) -> (code: Int32, out: String, err: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = ["git", "-C", dir] + args
        if let env { p.environment = env }
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

    // MARK: Worktree archive / restore

    /// Identity of a linked worktree needed to archive it.
    struct WorktreeInfo {
        let root: String      // the worktree's top-level dir
        let branch: String    // its branch, or "" if detached
        let head: String      // HEAD commit sha
        let mainRepo: String  // the main worktree dir (where refs live)
    }

    /// True if `dir` sits inside a LINKED worktree (git-dir differs from the common
    /// git-dir), i.e. one created by `git worktree add` — not the main checkout.
    static func isLinkedWorktree(_ dir: String) -> Bool {
        let common = run(["rev-parse", "--path-format=absolute", "--git-common-dir"], in: dir)
        let gitDir = run(["rev-parse", "--path-format=absolute", "--git-dir"], in: dir)
        guard common.code == 0, gitDir.code == 0 else { return false }
        let c = trim(common.out), g = trim(gitDir.out)
        return !c.isEmpty && c != g
    }

    /// Resolve a linked worktree's identity from any dir inside it, or nil if it
    /// isn't a linked worktree.
    static func worktreeInfo(_ dir: String) -> WorktreeInfo? {
        guard isLinkedWorktree(dir) else { return nil }
        let root = trim(run(["rev-parse", "--show-toplevel"], in: dir).out)
        let head = trim(run(["rev-parse", "HEAD"], in: dir).out)
        let branch = trim(run(["branch", "--show-current"], in: dir).out)
        let commonDir = trim(run(["rev-parse", "--path-format=absolute", "--git-common-dir"], in: dir).out)
        // common-dir is <mainRepo>/.git → its parent is the main worktree.
        let mainRepo = (commonDir as NSString).deletingLastPathComponent
        guard !root.isEmpty, !head.isEmpty, !mainRepo.isEmpty else { return nil }
        return WorktreeInfo(root: root, branch: branch, head: head, mainRepo: mainRepo)
    }

    /// Snapshot the worktree's uncommitted work as two detached commits
    /// (staged tree, then full working tree), pin them under `protectionRef`, and
    /// remove the directory. The branch is left untouched. See the design doc.
    static func archiveWorktree(info: WorktreeInfo, id: String) -> (ok: Bool, err: String) {
        let wt = info.root
        let stagedTree = run(["write-tree"], in: wt)
        guard stagedTree.code == 0 else { return (false, "write-tree (staged): " + stagedTree.err) }
        let stagedCommit = run(["commit-tree", trim(stagedTree.out), "-p", info.head,
                                "-m", "shepherd-archive: staged"], in: wt)
        guard stagedCommit.code == 0 else { return (false, "commit-tree (staged): " + stagedCommit.err) }

        // Full working tree via a throwaway index so the real one is never disturbed.
        let tmpIndex = (NSTemporaryDirectory() as NSString).appendingPathComponent("shepherd-archive-\(id).index")
        var env = ProcessInfo.processInfo.environment
        env["GIT_INDEX_FILE"] = tmpIndex
        defer { try? FileManager.default.removeItem(atPath: tmpIndex) }
        _ = run(["read-tree", info.head], in: wt, env: env)
        _ = run(["add", "-A"], in: wt, env: env)
        let wtTree = run(["write-tree"], in: wt, env: env)
        guard wtTree.code == 0 else { return (false, "write-tree (worktree): " + wtTree.err) }
        let wtCommit = run(["commit-tree", trim(wtTree.out), "-p", trim(stagedCommit.out),
                            "-m", "shepherd-archive: worktree"], in: wt, env: env)
        guard wtCommit.code == 0 else { return (false, "commit-tree (worktree): " + wtCommit.err) }

        let ref = WorktreeArchive.protectionRefName(id: id)
        let upd = run(["update-ref", ref, trim(wtCommit.out)], in: info.mainRepo)
        guard upd.code == 0 else { return (false, "update-ref: " + upd.err) }
        let rm = run(["worktree", "remove", "--force", wt], in: info.mainRepo)
        guard rm.code == 0 else { return (false, "worktree remove: " + rm.err) }
        return (true, "")
    }

    /// Recreate an archived worktree at `dest`, reproducing its staged/unstaged
    /// split (deletions included) and reattaching its branch.
    static func restoreWorktree(_ a: ArchivedWorktree) -> (ok: Bool, err: String) {
        let repo = a.repoDir, ref = a.protectionRef
        let wtCommit = run(["rev-parse", "--verify", "--quiet", ref], in: repo)
        guard wtCommit.code == 0, !trim(wtCommit.out).isEmpty else {
            return (false, "archive ref missing: \(ref)")
        }
        let staged = trim(run(["rev-parse", "\(ref)^"], in: repo).out)  // worktree commit's parent = staged snapshot

        // Full snapshot checked out detached → the working tree exactly matches, deletions and all.
        let add = run(["worktree", "add", "--detach", a.dest, trim(wtCommit.out)], in: repo)
        guard add.code == 0 else { return (false, "worktree add: " + add.err) }
        // Reattach the branch (at HEAD) without touching the working tree, if it still exists.
        if !a.branch.isEmpty, branchExists(a.branch, in: repo) {
            _ = run(["symbolic-ref", "HEAD", "refs/heads/\(a.branch)"], in: a.dest)
        }
        // Set the index back to the staged snapshot → status shows the original split.
        if !staged.isEmpty { _ = run(["read-tree", staged], in: a.dest) }
        // Drop the protection ref now that the work is live again.
        _ = run(["update-ref", "-d", ref], in: repo)
        return (true, "")
    }

    /// Fully remove an archived worktree's git state: the protection ref (gc reclaims
    /// the WIP snapshots) and, unless detached, the branch. Used by expiry + manual delete.
    static func deleteArchive(_ a: ArchivedWorktree) {
        _ = run(["update-ref", "-d", a.protectionRef], in: a.repoDir)
        if !a.branch.isEmpty { _ = run(["branch", "-D", a.branch], in: a.repoDir) }
    }

    /// Discard a worktree without archiving: remove the directory (reclaims disk).
    static func removeWorktree(root: String, mainRepo: String) {
        _ = run(["worktree", "remove", "--force", root], in: mainRepo)
    }

    private static func trim(_ s: String) -> String {
        s.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
