import Foundation

/// Finishing a stopped multi-commit operation.
///
/// The workbench can already resolve a conflict and abort an operation, but nothing ran
/// `--continue` — so a rebase started in a terminal pane and resolved here was left stranded
/// half-applied, with the lock lifted and no way forward. This is the pure half of closing
/// that loop.
/// What a `--continue` actually did.
///
/// Needed because **git exits non-zero when it stops at the next commit's conflict** — the
/// loop working correctly looks like a failed command (`Rebasing (2/2) error: could not apply
/// …`). Reporting that as an error would put git's scary words in front of the user every time
/// a multi-commit rebase behaved exactly as designed.
enum ContinueOutcome: Equatable {
    /// The sequence ran to the end.
    case finished
    /// It advanced and then paused again — the next conflict, or an `edit`/`break` todo.
    case stopped
    /// It refused, and nothing moved.
    case failed(String)
}

enum SequencePolicy {

    /// Classify a `--continue`.
    ///
    /// **`headMoved` is the discriminator, not the exit status and not the unmerged count.**
    /// A continue that commits and then hits the next conflict exits non-zero *and* leaves
    /// unmerged files — which is indistinguishable from a refusal if you only look at those
    /// two. What separates them is whether a commit actually got made.
    static func outcome(succeeded: Bool, errorText: String?, headMoved: Bool,
                        stillActive: Bool, unmergedAfter: Int) -> ContinueOutcome {
        if !succeeded && !headMoved {
            return .failed(errorText ?? "git could not continue")
        }
        if stillActive || unmergedAfter > 0 { return .stopped }
        return .finished
    }

    static func verb(_ operation: MergeState.Operation) -> String? {
        switch operation {
        case .merge:      return "merge"
        case .rebase:     return "rebase"
        case .cherryPick: return "cherry-pick"
        case .none:       return nil
        }
    }

    static func continueArguments(_ operation: MergeState.Operation) -> [String]? {
        guard let verb = verb(operation) else { return nil }
        return [verb, "--continue"]
    }

    /// Where git parked the message it is about to commit, relative to the git dir.
    ///
    /// **Measured against git 2.55**, not assumed: a rebase writes `rebase-merge/message`
    /// while merge and cherry-pick both write `MERGE_MSG`. Resolve through
    /// `rev-parse --git-path` so linked worktrees and non-default layouts work.
    static func messageFileName(_ operation: MergeState.Operation) -> String? {
        switch operation {
        case .rebase:             return "rebase-merge/message"
        case .merge, .cherryPick: return "MERGE_MSG"
        case .none:               return nil
        }
    }

    /// The message without git's own comment block.
    ///
    /// All three files end with a `# Conflicts:` list that git strips at commit time. Only a
    /// `#` at the start of a line is a comment — `fix: issue #42` is content.
    static func displayMessage(_ raw: String) -> String {
        raw.components(separatedBy: "\n")
            .filter { !$0.hasPrefix("#") }
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func canContinue(isActive: Bool, unresolved: Int, writing: Bool) -> Bool {
        isActive && unresolved == 0 && !writing
    }

    /// Why Continue is disabled. Never nil when `canContinue` is false — a dead button with no
    /// explanation is the thing this project keeps refusing to ship.
    static func blockedReason(isActive: Bool, unresolved: Int, writing: Bool) -> String? {
        if !isActive { return "nothing in progress" }
        if writing { return "git is running" }
        if unresolved > 0 {
            return "\(unresolved) conflict\(unresolved == 1 ? "" : "s") left"
        }
        return nil
    }
}
