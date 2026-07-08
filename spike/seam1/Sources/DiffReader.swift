import Foundation

enum DiffMode: Equatable { case workingTree, branchVsBase }

struct DiffReadResult: Equatable {
    let files: [DiffFile]
    let baseLabel: String?   // e.g. "master"; nil in working-tree mode / not a repo
    let isRepo: Bool

    static let notRepo = DiffReadResult(files: [], baseLabel: nil, isRepo: false)
}

enum DiffReader {
    /// Read the diff for a cwd. `-M` so renames render as renames. Runs `git`
    /// synchronously; callers dispatch this off the main thread.
    static func read(cwd: String, mode: DiffMode) -> DiffReadResult {
        guard isGitRepo(cwd) else { return .notRepo }
        switch mode {
        case .workingTree:
            var text = git(cwd, ["diff", "-M", "HEAD"]) ?? ""
            text += untrackedDiff(cwd)
            return DiffReadResult(files: DiffParser.parse(text), baseLabel: nil, isRepo: true)
        case .branchVsBase:
            let base = detectBase(cwd)
            // Committed-since-base ∪ uncommitted, so the mode reads as "total vs base".
            let committed = git(cwd, ["diff", "-M", "\(base)...HEAD"]) ?? ""
            let working = (git(cwd, ["diff", "-M", "HEAD"]) ?? "") + untrackedDiff(cwd)
            let merged = mergeByPath(DiffParser.parse(committed) + DiffParser.parse(working))
            return DiffReadResult(files: merged, baseLabel: base, isRepo: true)
        }
    }

    /// Whole-file text for syntax highlighting. New side = the file on disk; old side
    /// = the blob at HEAD (working-tree) or the base (branch mode). Nil if unavailable.
    static func fileBlob(cwd: String, path: String, side: DiffSide, baseLabel: String?) -> String? {
        switch side {
        case .new:
            return try? String(contentsOfFile: (cwd as NSString).appendingPathComponent(path), encoding: .utf8)
        case .old:
            let ref = baseLabel ?? "HEAD"
            return git(cwd, ["show", "\(ref):\(path)"])
        }
    }

    // MARK: - internals

    private static func isGitRepo(_ cwd: String) -> Bool {
        git(cwd, ["rev-parse", "--is-inside-work-tree"])?.trimmingCharacters(in: .whitespacesAndNewlines) == "true"
    }

    /// origin/HEAD → main → master.
    private static func detectBase(_ cwd: String) -> String {
        if let sym = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"])?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           let name = sym.components(separatedBy: "/").last, !name.isEmpty {
            return name
        }
        if git(cwd, ["rev-parse", "--verify", "main"]) != nil { return "main" }
        return "master"
    }

    /// Synthesize an all-added diff for every untracked file so new files show.
    private static func untrackedDiff(_ cwd: String) -> String {
        guard let out = git(cwd, ["ls-files", "--others", "--exclude-standard"]) else { return "" }
        var acc = ""
        for path in out.split(separator: "\n").map(String.init) where !path.isEmpty {
            // `--no-index` exits non-zero when files differ; capture stdout regardless.
            if let d = git(cwd, ["diff", "--no-index", "--", "/dev/null", path], allowFailure: true) {
                acc += d
            }
        }
        return acc
    }

    /// When branch mode unions committed + working diffs, the same path can appear
    /// twice. Prefer the later (working-tree) entry — it's the current on-disk truth.
    private static func mergeByPath(_ files: [DiffFile]) -> [DiffFile] {
        var order: [String] = []
        var byPath: [String: DiffFile] = [:]
        for f in files {
            if byPath[f.path] == nil { order.append(f.path) }
            byPath[f.path] = f
        }
        return order.compactMap { byPath[$0] }
    }

    @discardableResult
    private static func git(_ cwd: String, _ args: [String], allowFailure: Bool = false) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["-C", cwd] + args
        let out = Pipe(); let err = Pipe()
        p.standardOutput = out; p.standardError = err
        do { try p.run() } catch { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        if p.terminationStatus != 0 && !allowFailure { return nil }
        return String(data: data, encoding: .utf8)
    }
}
