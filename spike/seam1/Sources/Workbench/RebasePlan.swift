import Foundation

/// What to do with one commit in a rewrite.
///
/// **`edit` and `break` are deliberately absent.** Both stop the rebase for work that is not
/// this window's shape — amend by hand, go and run something — and a verb the UI offers but
/// cannot finish is worse than one it never had.
enum RebaseVerb: String, CaseIterable, Equatable {
    case pick, reword, squash, fixup, drop

    var title: String { rawValue }

    var help: String {
        switch self {
        case .pick:   return "Keep this commit as it is"
        case .reword: return "Keep the changes, change the message"
        case .squash: return "Fold into the commit below and combine the messages"
        case .fixup:  return "Fold into the commit below, keeping that commit's message"
        case .drop:   return "Throw this commit away"
        }
    }

    /// Whether git will open an editor for this entry.
    ///
    /// `fixup` discards its own message and keeps the base commit's, so it opens nothing —
    /// which is why any number of fixups is allowed and only one reword-or-squash is.
    var needsMessage: Bool {
        switch self {
        case .reword, .squash:     return true
        case .pick, .fixup, .drop: return false
        }
    }
}

/// One row of the rewrite plan.
struct PlanRow: Equatable, Identifiable {
    let commit: Commit
    var verb: RebaseVerb = .pick
    /// The message for a `reword` / `squash`, collected before Apply.
    var message: String = ""

    var id: String { commit.sha }
}

/// Rows on screen → a git todo, and whether the plan may run.
///
/// Pure, because the one thing here that cannot be caught by looking at it is the order.
enum RebasePlan {

    static func rows(from commits: [Commit]) -> [PlanRow] {
        commits.map { PlanRow(commit: $0) }
    }

    /// The todo git will execute.
    ///
    /// **Emitted oldest-first — the reverse of the rail.** git applies a todo top-down starting
    /// from the base, and the rail lists newest first like `git log`, so handing over the
    /// display order would reverse the branch. Nothing but the verb and the sha is written:
    /// verified against git 2.55, a todo of bare `<verb> <sha>` lines rebases correctly, and
    /// leaving the subject out means a subject containing `#` cannot comment out its own line.
    ///
    /// A `drop` emits no line at all. `drop <sha>` works equally well; omitting it is what
    /// makes "everything dropped" an empty todo, which git refuses cleanly with
    /// `error: nothing to do`.
    static func todo(for rows: [PlanRow]) -> String {
        let lines = rows.reversed()
            .filter { $0.verb != .drop }
            .map { "\($0.verb.rawValue) \($0.commit.sha)" }
        guard !lines.isEmpty else { return "" }
        // A todo git reads must end in a newline; an empty one must stay empty.
        return lines.joined(separator: "\n") + "\n"
    }

    /// Whether this plan would change nothing.
    ///
    /// Not a nicety: a rebase that rewrites every sha for no reason invalidates the branch's PR
    /// review state, so Apply must not be reachable when there is nothing to apply.
    static func isNoOp(rows: [PlanRow], original: [Commit]) -> Bool {
        guard rows.allSatisfy({ $0.verb == .pick }) else { return false }
        return rows.map(\.commit.sha) == original.map(\.sha)
    }

    /// The single entry git will open an editor for, if any.
    static func messageEntry(rows: [PlanRow]) -> PlanRow? {
        rows.first { $0.verb.needsMessage }
    }

    /// Why Apply is disabled, or nil when the plan may run.
    ///
    /// Never nil when the plan cannot run — a dead button with no explanation is the thing this
    /// project keeps refusing to ship.
    static func blockedReason(rows: [PlanRow], original: [Commit]) -> String? {
        if rows.isEmpty || isNoOp(rows: rows, original: original) { return "nothing to apply" }
        let kept = rows.filter { $0.verb != .drop }
        if kept.isEmpty { return "every commit is dropped" }

        // The **oldest** kept row is the todo's first line — the bottom of the rail — and git
        // rejects a todo that starts with squash or fixup: there is nothing before it.
        if let first = kept.last, first.verb == .squash || first.verb == .fixup {
            return "the first commit has nothing to squash into"
        }

        // One editor-opening entry per plan. `GIT_EDITOR="cp '<file>'"` substitutes exactly one
        // message, so two rewords would give both commits the same subject. `fixup` opens
        // nothing, so any number of those is fine — which covers tidying a fixup chain.
        let needMessages = kept.filter { $0.verb.needsMessage }
        if needMessages.count > 1 {
            return "one reword or squash per rewrite — apply this, then rewrite again"
        }
        if let entry = needMessages.first,
           entry.message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return entry.verb == .reword
                ? "the reword needs a message"
                : "the squash needs a message"
        }
        return nil
    }
}
