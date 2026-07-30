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

/// What kind of conflicted state the repo is in, and therefore what the way out is.
///
/// Derived from git's own files on every read, never cached — the rule
/// `ConflictReader.readState` sets, so our idea of where we are cannot drift from git's after
/// an abort in a terminal pane.
enum ConflictContext: Equatable {
    /// Nothing unmerged and nothing in flight.
    case clean
    /// git is part-way through something that can be continued or aborted.
    case sequence(MergeState.Operation)
    /// Unmerged files with **no operation**. A conflicted `git stash pop`, `git checkout -m`,
    /// or `git apply -3`. There is nothing to continue and nothing to abort, so the only ways
    /// out are to resolve every file or to discard.
    case loose
}

enum SequencePolicy {

    /// Classify the conflicted state. An active operation wins: a stash applied on top of a
    /// stopped rebase is still a rebase as far as the way out is concerned.
    ///
    /// **`.loose` is inferred, not read.** git records nothing that distinguishes a conflicted
    /// stash apply from a conflicted `git checkout -m`, so this describes the shape of the
    /// state rather than naming its cause. Naming it would be a guess.
    static func context(operation: MergeState.Operation, hasConflicts: Bool) -> ConflictContext {
        if operation != .none { return .sequence(operation) }
        return hasConflicts ? .loose : .clean
    }

    /// Headline for `.loose`. Counts unresolved regions, matching `blockedReason`.
    static func looseHeadline(unresolved: Int) -> String {
        "\(unresolved) conflict\(unresolved == 1 ? "" : "s") · no operation in progress"
    }

    /// Why there is no Continue. It has to say so out loud: the workbench is locked, which
    /// implies a sequence, and a disabled Continue reading "nothing in progress" beside a lock
    /// is a contradiction the user would have to resolve on our behalf.
    static let looseExplanation =
        "Resolve each file and the result stays in your working tree. "
        + "There is nothing to continue — no rebase, merge or cherry-pick is in flight."

    /// Exactly what Discard will do, named file by file.
    ///
    /// The action is per-path `git checkout HEAD --`, never `reset --hard`: the tree can hold
    /// unrelated modifications that were never at risk, and throwing those away would be a
    /// second trap rather than an escape from the first. Verified against git 2.55 — it clears
    /// all three unmerged stages and leaves an unrelated modified file alone.
    static func discardConfirmation(paths: [String], stashTop: String?) -> String {
        guard !paths.isEmpty else { return "" }
        let names = paths.map { ($0 as NSString).lastPathComponent }.joined(separator: ", ")
        var text = paths.count == 1
            ? "Restore \(names) to HEAD, throwing away this conflicted merge."
            : "Restore \(paths.count) files to HEAD, throwing away this conflicted merge: \(names)."
        text += " Other modified files are untouched."
        // Information, not reassurance: a conflicted pop keeps its entry, but nothing in git
        // proves the top entry is the one that was applied.
        if let stashTop, !stashTop.isEmpty {
            text += "\n\nThe stash list still holds \(stashTop)."
        }
        return text
    }

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
