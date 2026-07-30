import Foundation

/// Reading other branches, and starting a pick. The `Process` half; the parses are pure.
enum CherryPickRunner {

    static func refs(cwd: String) -> [Ref] {
        guard case .ok(let out) = GitStaging.run(RefList.arguments(), cwd: cwd) else { return [] }
        return RefList.parse(out, currentBranch: GitStaging.currentBranch(cwd: cwd))
    }

    /// What `ref` has that HEAD does not.
    ///
    /// `HEAD..<ref>` rather than the ref's whole history: a branch's shared past holds no
    /// cherry-pick candidates, and listing it would be the unbounded history browsing W5a
    /// ruled out.
    static func commits(cwd: String, ref: String) -> [Commit] {
        guard case .ok(let out) = GitStaging.run(
            CommitHistory.logArguments(range: "HEAD..\(ref)"), cwd: cwd) else { return [] }
        return CommitHistory.parse(out)
    }

    /// Pick, **oldest first**.
    ///
    /// `git cherry-pick` applies its arguments in the order given, and the list on screen is
    /// newest-first — so the caller's order has to be reversed before it gets here, or each
    /// pick lands on a tree its author never saw. The same inversion `RebasePlan` handles, one
    /// command earlier.
    ///
    /// A conflict is an ordinary outcome: git exits non-zero, writes `CHERRY_PICK_HEAD`, and
    /// the existing lock plus Continue drive the rest.
    static func pick(cwd: String, shas: [String]) -> GitResult {
        guard !shas.isEmpty else { return .ok("") }
        return GitStaging.run(["cherry-pick"] + shas, cwd: cwd)
    }
}
