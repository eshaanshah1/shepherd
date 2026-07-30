import Foundation

/// Result of a git write, carrying stderr so a failure can be shown rather than
/// swallowed. `DiffReader.git` returns nil on failure and loses the reason — the
/// workbench must not repeat that.
enum GitResult: Equatable {
    case ok(String)
    case failed(String)

    var isOK: Bool { if case .ok = self { return true }; return false }
    var errorText: String? { if case .failed(let e) = self { return e }; return nil }
}

/// Index and history writes for the workbench. Every call is synchronous and must run
/// off the main thread — `Process` pumps a run loop, and doing that during a SwiftUI
/// layout pass wedges the update cycle.
enum GitStaging {

    /// Apply a synthesized patch to the index. `reverse` unstages the same selection.
    static func applyToIndex(patch: String, cwd: String, reverse: Bool) -> GitResult {
        var args = ["apply", "--cached", "--unidiff-zero", "--whitespace=nowarn"]
        if reverse { args.append("--reverse") }
        args.append("-")
        return run(args, cwd: cwd, stdin: patch)
    }

    /// Stage or unstage whole files — cheaper and more robust than a patch when the
    /// whole file is selected, and it handles adds/deletes/renames without special cases.
    ///
    /// Batched: "stage all" over a directory is one `git add`, not one per file.
    static func stageFiles(_ paths: [String], cwd: String) -> GitResult {
        guard !paths.isEmpty else { return .ok("") }
        return run(["add", "--"] + paths, cwd: cwd)
    }

    static func unstageFiles(_ paths: [String], cwd: String) -> GitResult {
        guard !paths.isEmpty else { return .ok("") }
        return run(["restore", "--staged", "--"] + paths, cwd: cwd)
    }

    /// Restore paths to HEAD, clearing their unmerged stages.
    ///
    /// **Per path, never `reset --hard`.** This is the escape from a conflicted state with no
    /// operation to abort, and the tree around it can hold modifications that were never at
    /// risk — discarding those would be a second trap rather than an exit from the first.
    /// Measured against git 2.55: this clears all three stages for the named paths and leaves
    /// an unrelated modified file untouched.
    static func restoreFiles(_ paths: [String], cwd: String) -> GitResult {
        guard !paths.isEmpty else { return .ok("") }
        return run(["checkout", "HEAD", "--"] + paths, cwd: cwd)
    }

    /// Local branch names, current one first.
    static func listBranches(cwd: String) -> [String] {
        guard case .ok(let out) = run(["for-each-ref", "--sort=-committerdate",
                                       "--format=%(refname:short)", "refs/heads"],
                                      cwd: cwd) else { return [] }
        return out.components(separatedBy: "\n").filter { !$0.isEmpty }
    }

    /// Switch branches. Git refuses on its own when the tree would be clobbered, and the
    /// reason comes back on stderr rather than being swallowed.
    static func checkout(branch: String, cwd: String) -> GitResult {
        run(["checkout", branch], cwd: cwd)
    }

    /// Every file in the repo, for `⌘P` — tracked plus untracked-but-not-ignored.
    ///
    /// `git ls-files` rather than a directory walk: it is one process, it already honours
    /// `.gitignore`, and it will not wander into `node_modules` or a vendored xcframework.
    static func listFiles(cwd: String) -> [String] {
        guard case .ok(let out) = run(["ls-files", "--cached", "--others",
                                       "--exclude-standard"], cwd: cwd) else { return [] }
        var seen = Set<String>()
        return out.components(separatedBy: "\n")
            .filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    /// Commit the index. The message goes in on stdin so quoting and newlines can't be
    /// mangled by argument construction.
    static func commit(message: String, cwd: String, amend: Bool = false) -> GitResult {
        var args = ["commit", "-F", "-"]
        if amend { args.append("--amend") }
        return run(args, cwd: cwd, stdin: message)
    }

    /// Push the current branch, setting upstream when it has none.
    static func push(cwd: String) -> GitResult {
        if upstream(cwd: cwd) == nil {
            guard let branch = currentBranch(cwd: cwd) else {
                return .failed("Detached HEAD — nothing to push.")
            }
            return run(["push", "--set-upstream", "origin", branch], cwd: cwd)
        }
        return run(["push"], cwd: cwd)
    }

    static func currentBranch(cwd: String) -> String? {
        guard case .ok(let out) = run(["rev-parse", "--abbrev-ref", "HEAD"], cwd: cwd) else { return nil }
        let name = out.trimmingCharacters(in: .whitespacesAndNewlines)
        return (name.isEmpty || name == "HEAD") ? nil : name
    }

    static func upstream(cwd: String) -> String? {
        guard case .ok(let out) = run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
                                     cwd: cwd) else { return nil }
        let name = out.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? nil : name
    }

    /// Paths with staged changes, so the rail can split Staged from Unstaged.
    static func stagedPaths(cwd: String) -> Set<String> {
        guard case .ok(let out) = run(["diff", "--cached", "--name-only"], cwd: cwd) else { return [] }
        return Set(out.split(separator: "\n").map(String.init).filter { !$0.isEmpty })
    }

    /// Paths with unstaged working-tree changes, plus untracked files.
    ///
    /// The set a whole-file `git add` would actually move. In vs-base mode most of the
    /// listed files are already **committed** — `git add` on those succeeds and stages
    /// nothing, so offering the action there is a button that cannot work.
    static func unstagedPaths(cwd: String) -> Set<String> {
        var paths: Set<String> = []
        for args in [["diff", "--name-only"], ["ls-files", "--others", "--exclude-standard"]] {
            guard case .ok(let out) = run(args, cwd: cwd) else { continue }
            paths.formUnion(out.split(separator: "\n").map(String.init).filter { !$0.isEmpty })
        }
        return paths
    }

    /// Whether anything is staged — gates the commit button.
    static func hasStagedChanges(cwd: String) -> Bool { !stagedPaths(cwd: cwd).isEmpty }

    // MARK: - Process

    /// Internal rather than private: the merge resolver settles whole-file conflicts by
    /// handing git the argument lists `WholeFileResolve` picks, and those have no business
    /// each becoming a named wrapper here.
    @discardableResult
    static func run(_ args: [String], cwd: String, stdin: String? = nil,
                    env: [String: String]? = nil) -> GitResult {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["-C", cwd] + args
        if let env {
            // **Merged** into the inherited environment, never replacing it: git needs `HOME`
            // to find its config and `PATH` to find its helpers, so a bare dictionary would
            // quietly change what git *is* when all we wanted was to set an editor.
            p.environment = ProcessInfo.processInfo.environment.merging(env) { _, new in new }
        }
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        let input = Pipe()
        if stdin != nil { p.standardInput = input }

        do { try p.run() } catch { return .failed("Could not run git: \(error.localizedDescription)") }

        if let stdin {
            input.fileHandleForWriting.write(Data(stdin.utf8))
            input.fileHandleForWriting.closeFile()
        }
        // Drain both pipes before waiting — a full pipe deadlocks the child.
        let stdoutData = out.fileHandleForReading.readDataToEndOfFile()
        let stderrData = err.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()

        let stdoutText = String(data: stdoutData, encoding: .utf8) ?? ""
        let stderrText = String(data: stderrData, encoding: .utf8) ?? ""
        guard p.terminationStatus == 0 else {
            let reason = stderrText.trimmingCharacters(in: .whitespacesAndNewlines)
            return .failed(reason.isEmpty ? "git \(args.first ?? "") failed (\(p.terminationStatus))" : reason)
        }
        return .ok(stdoutText)
    }
}
