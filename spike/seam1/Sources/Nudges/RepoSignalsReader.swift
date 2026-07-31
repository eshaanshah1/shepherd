import Foundation

/// Fills a `RepoSignals` from git.
///
/// Synchronous `Process` work — callers dispatch it off the main thread, like
/// `ConflictReader` and `DiffReader`. Every command here is local: this runs on each git
/// write in the repo, so a single fetch would turn a rebase into a network storm.
enum RepoSignalsReader {

    static func read(cwd: String) -> RepoSignals? {
        guard !cwd.isEmpty, case .ok = GitStaging.run(["rev-parse", "--is-inside-work-tree"],
                                                     cwd: cwd) else { return nil }
        var s = RepoSignals()
        s.state = ConflictReader.readState(cwd: cwd)
        s.branch = GitStaging.currentBranch(cwd: cwd)

        if case .ok(let z) = GitStaging.run(["ls-files", "-u", "-z"], cwd: cwd) {
            s.conflicts = RepoSignals.unmergedCount(lsFilesZ: z)
        }
        if case .ok(let porcelain) = GitStaging.run(["status", "--porcelain"], cwd: cwd) {
            s.dirty = RepoSignals.dirtyCount(porcelain: porcelain)
        }

        s.hasUpstream = GitStaging.upstream(cwd: cwd) != nil
        if let base = s.hasUpstream ? "@{upstream}" : RepoSignals.localDefaultBase(cwd: cwd),
           case .ok(let out) = GitStaging.run(["rev-list", "--count", "\(base)..HEAD"], cwd: cwd) {
            s.ahead = RepoSignals.revCount(out)
        }
        return s
    }
}

extension RepoSignals {

    /// origin's default branch, read **without touching the network**.
    ///
    /// Deliberately not `Git.defaultBaseRef`, which falls back to
    /// `git remote set-head origin --auto` — a remote round-trip, on a path that fires on
    /// every git write. No `origin/HEAD` locally ⇒ nil, and `ahead` stays 0: there is no
    /// honest count, and counting all of `HEAD` would report every commit ever made as
    /// unpushed.
    static func localDefaultBase(cwd: String) -> String? {
        guard case .ok(let out) = GitStaging.run(
            ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd: cwd) else { return nil }
        let ref = out.trimmingCharacters(in: .whitespacesAndNewlines)
        return ref.isEmpty ? nil : ref
    }
}
