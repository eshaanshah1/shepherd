import Foundation

/// Fills a `RepoSignals` from git.
///
/// Synchronous `Process` work — callers dispatch it off the main thread, like
/// `ConflictReader` and `DiffReader`. Every command here is local: this runs on each git
/// write in the repo, so a single fetch would turn a rebase into a network storm.
enum RepoSignalsReader {

    /// `git status` **refreshes and rewrites `.git/index`**, and this read runs on a vnode
    /// watch of that very directory — so left alone it wakes the watcher that ran it, and the
    /// pair sustains each other with nothing happening in the repo at all. `GIT_OPTIONAL_LOCKS=0`
    /// is git's own switch for a reader that must not write.
    static let readOnly = ["GIT_OPTIONAL_LOCKS": "0"]

    /// Pass `gitDir` when the caller already resolved it (`RepoWatcher` always has), so the
    /// merge-state read costs no subprocess at all.
    static func read(cwd: String, gitDir: String? = nil) -> RepoSignals? {
        // One status carries branch, upstream, ahead, dirty and conflicts, and fails outside a
        // work tree — which is what the `--is-inside-work-tree` probe used to be for.
        guard !cwd.isEmpty,
              case .ok(let out) = GitStaging.run(["status", "--porcelain=v2", "--branch"],
                                                 cwd: cwd, env: readOnly) else { return nil }
        let status = RepoSignals.parseStatusV2(out)
        var s = RepoSignals()
        s.branch = status.branch
        s.conflicts = status.conflicts
        s.dirty = status.dirty
        s.hasUpstream = status.hasUpstream
        s.state = ConflictReader.readState(cwd: cwd, gitDir: gitDir)

        if status.hasUpstream {
            s.ahead = status.ahead   // `branch.ab`, already in hand
        } else if let base = RepoSignals.localDefaultBase(cwd: cwd),
                  case .ok(let count) = GitStaging.run(["rev-list", "--count", "\(base)..HEAD"],
                                                       cwd: cwd, env: readOnly) {
            s.ahead = RepoSignals.revCount(count)
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
