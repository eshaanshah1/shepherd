import Foundation

struct MergeProgress: Equatable {
    let done: Int
    let total: Int
}

/// Which multi-commit operation git is part-way through, and what the two sides are called.
struct MergeState: Equatable {
    enum Operation: Equatable { case merge, rebase, cherryPick, none }

    let operation: Operation
    /// Real ref names for index stages 2 and 3.
    let oursLabel: String
    let theirsLabel: String
    /// Rebase position. nil outside a rebase.
    let progress: MergeProgress?

    static let idle = MergeState(operation: .none, oursLabel: "ours",
                                 theirsLabel: "theirs", progress: nil)

    var isActive: Bool { operation != .none }

    /// "Rebasing feature onto master — 3 of 7".
    var summary: String? {
        switch operation {
        case .none:
            return nil
        case .merge:
            return "Merging \(theirsLabel) into \(oursLabel)"
        case .cherryPick:
            return "Cherry-picking \(theirsLabel) onto \(oursLabel)"
        case .rebase:
            let base = "Rebasing \(theirsLabel) onto \(oursLabel)"
            guard let progress else { return base }
            return "\(base) — \(progress.done) of \(progress.total)"
        }
    }
}

struct ConflictReadResult: Equatable {
    let files: [MergeFile]
    let state: MergeState
    /// Paths where our conflict count disagrees with the marker count git wrote.
    let divergent: [String]

    static let none = ConflictReadResult(files: [], state: .idle, divergent: [])

    var isEmpty: Bool { files.isEmpty }
}

/// Reads the unmerged index into three-way merges.
///
/// Synchronous `Process` work — callers dispatch it off the main thread, like `DiffReader`
/// and `GitStaging`.
enum ConflictReader {

    static func read(cwd: String) -> ConflictReadResult {
        guard let listing = text(git(cwd, ["ls-files", "-u", "-z"])), !listing.isEmpty else {
            return .none
        }
        let state = readState(cwd: cwd)
        var files: [MergeFile] = []
        var divergent: [String] = []

        for (path, stages) in ConflictParse.byPath(ConflictParse.entries(listing)) {
            let kind = ConflictParse.kind(stages: Set(stages.keys))
            let blobs = stages.mapValues { blob($0.sha, cwd: cwd) }

            // A stage that exists but will not decode is binary, whoever else agrees.
            let undecodable = blobs.contains { $0.value != nil && text($0.value) == nil }
            guard !undecodable, !kind.isWholeFile else {
                files.append(.wholeFile(path: path,
                                        kind: undecodable ? .binary : kind,
                                        oursLabel: state.oursLabel,
                                        theirsLabel: state.theirsLabel))
                continue
            }

            let regions = Diff3.merge(base: lines(blobs[1], cwd: cwd),
                                      ours: lines(blobs[2], cwd: cwd),
                                      theirs: lines(blobs[3], cwd: cwd))
            let file = MergeFile(path: path, kind: kind, regions: regions,
                                 oursLabel: state.oursLabel, theirsLabel: state.theirsLabel)
            files.append(file)

            if let worktree = try? String(contentsOfFile: absolute(path, in: cwd),
                                          encoding: .utf8),
               ConflictParse.markerCount(worktree) != file.conflicts.count {
                divergent.append(path)
            }
        }
        return ConflictReadResult(files: files, state: state, divergent: divergent)
    }

    // MARK: - Operation state

    /// Which operation is in flight, and what to call each side.
    ///
    /// The rebase branch is the one that matters. `git rebase` checks out the **upstream**
    /// and replays your commits onto it, so index stage 2 — the one git calls "ours" — is
    /// the branch you are rebasing *onto*, and stage 3 ("theirs") is your own work. Showing
    /// git's words on the button that decides which side survives tells the user the exact
    /// opposite of the truth, which is why these are ref names.
    private static func readState(cwd: String) -> MergeState {
        for dir in ["rebase-merge", "rebase-apply"] {
            // `onto_name` is the readable one but git only writes it on the interactive and
            // `--onto` paths; a plain `git rebase main` leaves just `onto`, a bare sha
            // (checked against git 2.55). Resolving it keeps the label a branch name rather
            // than forty hex characters on the button that discards a side.
            guard let onto = gitFile(cwd, "\(dir)/onto_name")
                ?? gitFile(cwd, "\(dir)/onto").map({ refName(cwd, $0) }) else { continue }
            let replayed = gitFile(cwd, "\(dir)/head-name")
                .map { $0.replacingOccurrences(of: "refs/heads/", with: "") }
            let done = (gitFile(cwd, "\(dir)/msgnum") ?? gitFile(cwd, "\(dir)/next"))
                .flatMap(Int.init)
            let total = (gitFile(cwd, "\(dir)/end") ?? gitFile(cwd, "\(dir)/last"))
                .flatMap(Int.init)
            return MergeState(
                operation: .rebase,
                oursLabel: onto,
                theirsLabel: replayed ?? "your commits",
                progress: (done.map { d in total.map { MergeProgress(done: d, total: $0) } }) ?? nil)
        }

        let head = GitStaging.currentBranch(cwd: cwd) ?? "HEAD"
        if gitFile(cwd, "MERGE_HEAD") != nil {
            return MergeState(operation: .merge, oursLabel: head,
                              theirsLabel: refName(cwd, "MERGE_HEAD"), progress: nil)
        }
        if gitFile(cwd, "CHERRY_PICK_HEAD") != nil {
            return MergeState(operation: .cherryPick, oursLabel: head,
                              theirsLabel: refName(cwd, "CHERRY_PICK_HEAD"), progress: nil)
        }
        return MergeState(operation: .none, oursLabel: head, theirsLabel: "theirs",
                          progress: nil)
    }

    /// A readable name for a ref, falling back to a short sha.
    private static func refName(_ cwd: String, _ ref: String) -> String {
        if let named = text(git(cwd, ["name-rev", "--name-only", "--refs=refs/heads/*", ref]))?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !named.isEmpty, named != "undefined" {
            return named
        }
        return text(git(cwd, ["rev-parse", "--short", ref]))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ref
    }

    /// Contents of a file inside the git dir, resolved via `--git-path` so worktrees and
    /// non-default layouts work.
    private static func gitFile(_ cwd: String, _ name: String) -> String? {
        guard let path = text(git(cwd, ["rev-parse", "--git-path", name]))?
            .trimmingCharacters(in: .whitespacesAndNewlines), !path.isEmpty else { return nil }
        let resolved = path.hasPrefix("/") ? path : absolute(path, in: cwd)
        guard let contents = try? String(contentsOfFile: resolved, encoding: .utf8) else {
            return nil
        }
        let trimmed = contents.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    // MARK: - Blobs

    /// Read a stage blob by sha rather than `git show :N:path`, so a path containing a
    /// space, a colon or a quote needs no escaping at all.
    private static func blob(_ sha: String, cwd: String) -> Data? {
        git(cwd, ["cat-file", "blob", sha])
    }

    private static func lines(_ data: Data??, cwd: String) -> [String] {
        guard let data, let text = text(data) else { return [] }
        return MergeText.lines(text)
    }

    private static func text(_ data: Data?) -> String? {
        guard let data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func absolute(_ path: String, in cwd: String) -> String {
        (cwd as NSString).appendingPathComponent(path)
    }

    private static func git(_ cwd: String, _ args: [String]) -> Data? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["-C", cwd] + args
        let out = Pipe(), err = Pipe()
        process.standardOutput = out
        process.standardError = err
        do { try process.run() } catch { return nil }
        // Drain before waiting — a full pipe deadlocks the child, and a blob is easily
        // bigger than the buffer.
        let data = out.fileHandleForReading.readDataToEndOfFile()
        _ = err.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return process.terminationStatus == 0 ? data : nil
    }
}
