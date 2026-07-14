import Foundation

// MARK: - Pure core (unit-tested)

/// The single status bucket an idle agent's PR reduces to — drives one icon+color.
enum PRKind: String, Equatable {
    case merged, closed, draft
    case checksFailing, changesRequested, checksPending, reviewRequired
    case mergeReady, open
}

/// Rolled-up verdict of a PR's status checks.
enum ChecksVerdict { case passing, failing, pending, none }

struct PRStatus: Equatable {
    let number: Int
    let url: String
    let kind: PRKind
}

/// Pure PR reduction/parsing. Namespaced (like `WorktreeArchive`/`StopPolicy`) so the
/// symbols don't clash with the app module's copy under `@testable import`.
enum PR {
    /// Reduce a PR's fields to one `PRKind`, most-urgent-wins:
    /// merged → closed → draft → checks failing → changes requested → checks pending →
    /// review required → merge-ready (clean) → open.
    static func classify(state: String, isDraft: Bool, reviewDecision: String,
                         checks: ChecksVerdict, mergeState: String) -> PRKind {
        switch state.uppercased() {
        case "MERGED": return .merged
        case "CLOSED": return .closed
        default: break
        }
        if isDraft { return .draft }
        if checks == .failing { return .checksFailing }
        if reviewDecision.uppercased() == "CHANGES_REQUESTED" { return .changesRequested }
        if checks == .pending { return .checksPending }
        if reviewDecision.uppercased() == "REVIEW_REQUIRED" { return .reviewRequired }
        if mergeState.uppercased() == "CLEAN" { return .mergeReady }
        return .open
    }

    /// Collapse `gh`'s `statusCheckRollup` array (mixed CheckRun / StatusContext shapes)
    /// to a single verdict: any failure → failing, else any in-flight → pending, else
    /// (some checks, all good) → passing, else none.
    static func checksVerdict(from rollup: [[String: Any]]) -> ChecksVerdict {
        guard !rollup.isEmpty else { return .none }
        let failing: Set<String> = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]
        let pending: Set<String> = ["PENDING", "EXPECTED", "IN_PROGRESS", "QUEUED", "WAITING", "REQUESTED"]
        var sawPending = false
        for item in rollup {
            let status = (item["status"] as? String)?.uppercased() ?? ""       // CheckRun
            let conclusion = (item["conclusion"] as? String)?.uppercased() ?? ""// CheckRun (once completed)
            let ctxState = (item["state"] as? String)?.uppercased() ?? ""       // StatusContext
            let verdict: String
            if !conclusion.isEmpty { verdict = conclusion }
            else if !ctxState.isEmpty { verdict = ctxState }
            else if !status.isEmpty, status != "COMPLETED" { verdict = "PENDING" }
            else { verdict = "" }
            if failing.contains(verdict) { return .failing }
            if pending.contains(verdict) { sawPending = true }
        }
        return sawPending ? .pending : .passing
    }

    /// Parse `gh pr view --json state,isDraft,reviewDecision,statusCheckRollup,mergeStateStatus,number,url`
    /// output into a `PRStatus`. Returns nil when there's no PR (no number/url) or the
    /// payload is undecodable.
    static func parse(_ data: Data) -> PRStatus? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let number = obj["number"] as? Int,
              let url = obj["url"] as? String, !url.isEmpty else { return nil }
        let checks = checksVerdict(from: obj["statusCheckRollup"] as? [[String: Any]] ?? [])
        let kind = classify(state: obj["state"] as? String ?? "OPEN",
                            isDraft: obj["isDraft"] as? Bool ?? false,
                            reviewDecision: obj["reviewDecision"] as? String ?? "",
                            checks: checks,
                            mergeState: obj["mergeStateStatus"] as? String ?? "")
        return PRStatus(number: number, url: url, kind: kind)
    }
}
