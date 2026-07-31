import Foundation

/// Which nudge. The raw values are persisted in `shepherd.nudge.seen`, so renaming one
/// re-shows a tip the user already dismissed.
enum NudgeID: String, CaseIterable {
    case resolveConflicts, continueSequence, reviewChanges, createPR
}

/// Whether this nudge is eligible for the pane bar, and how often. Orthogonal to
/// `NudgeUrgency`: this decides chrome, that decides the badge.
enum NudgeBarPolicy { case always, firstFire, never }

/// Whether this nudge joins the attention rollups (dock badge, folder dot, ⌘⇧A).
enum NudgeUrgency { case attention, informational }

/// The glyph, named rather than drawn — the registry is pure and must not import SwiftUI.
enum NudgeGlyph { case conflict, sequence, review, pullRequest }

enum NudgeAction: Equatable {
    case openWorkbench(scope: WorkbenchScope)
    case createPR
}

struct Nudge: Equatable {
    let id: NudgeID
    let glyph: NudgeGlyph
    let text: String
    let count: Int?
    let bar: NudgeBarPolicy
    let urgency: NudgeUrgency
    let action: NudgeAction
}

/// Everything a nudge may read about one pane. Assembled by `AgentStore`; nothing here is
/// an event, so the registry stays a function of the present.
struct PaneFacts {
    var agentState: AgentState
    var repo: RepoSignals?
    var hasPR: Bool
    var workbenchOpen: Bool
    var isRemote: Bool
    var provisioning: Bool
    var ghInstalled: Bool
    var onboarding: Bool
}

/// The single place that decides which nudges a pane has.
///
/// Adding one is a row here plus a case in `NudgeRegistryTests` — the shape
/// `ShortcutCatalog` and `StopPolicy` already have.
enum NudgeRegistry {

    static func nudges(for f: PaneFacts) -> [Nudge] {
        // The tour's sandbox stages a real merge conflict on purpose; a mirror workspace's
        // repo lives on the host; a provisioning pane has no directory yet.
        guard !f.onboarding, !f.isRemote, !f.provisioning, let repo = f.repo else { return [] }
        // A waiting or failed agent outranks anything git has to say, and its dot must not
        // be displaced by a nudge glyph.
        guard f.agentState != .blocked, f.agentState != .error else { return [] }

        var out: [Nudge] = []

        if repo.conflicts > 0 {
            out.append(Nudge(
                id: .resolveConflicts,
                glyph: .conflict,
                text: conflictText(repo),
                count: repo.conflicts,
                bar: .always,
                urgency: .attention,
                action: .openWorkbench(scope: .files)))
        } else if repo.state.isActive {
            // The sequence is half-applied with nothing left conflicting — one --continue
            // from done, and nothing else in Shepherd says so.
            out.append(Nudge(
                id: .continueSequence,
                glyph: .sequence,
                text: repo.state.summary ?? "Operation in progress",
                count: nil,
                bar: .always,
                urgency: .attention,
                action: .openWorkbench(scope: .files)))
        }

        // A finished turn is observable as the state it lands in, so this stays a predicate
        // over the present rather than a stored "a turn ended" flag.
        if repo.dirty > 0, f.agentState == .idle || f.agentState == .needsCheck,
           !f.workbenchOpen {
            out.append(Nudge(
                id: .reviewChanges,
                glyph: .review,
                text: "\(repo.dirty) file\(repo.dirty == 1 ? "" : "s") changed",
                count: repo.dirty,
                bar: .firstFire,
                urgency: .informational,
                action: .openWorkbench(scope: .workingTree)))
        }

        if repo.ahead > 0, !f.hasPR, f.ghInstalled {
            out.append(Nudge(
                id: .createPR,
                glyph: .pullRequest,
                text: "\(repo.ahead) commit\(repo.ahead == 1 ? "" : "s"), no PR",
                count: repo.ahead,
                bar: .firstFire,
                urgency: .informational,
                action: .createPR))
        }

        return out
    }

    /// Does this nudge draw the pane bar, given the ids already shown once?
    static func showsBar(_ nudge: Nudge, seen: Set<String>) -> Bool {
        switch nudge.bar {
        case .always:    return true
        case .never:     return false
        case .firstFire: return !seen.contains(nudge.id.rawValue)
        }
    }

    private static func conflictText(_ repo: RepoSignals) -> String {
        let n = repo.conflicts
        let count = "\(n) conflict\(n == 1 ? "" : "s")"
        switch repo.state.operation {
        case .merge:      return "Merge stopped · \(count)"
        case .rebase:     return "Rebase stopped · \(count)"
        case .cherryPick: return "Cherry-pick stopped · \(count)"
        // No operation recorded anywhere — a conflicted stash apply, `checkout -m` or
        // `apply -3`. git distinguishes none of the three, so neither does this.
        case .none:       return count
        }
    }
}
