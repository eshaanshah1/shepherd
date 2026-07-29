import Foundation

// MARK: - Pure core (unit-tested)

/// The single status bucket an idle agent's PR reduces to — drives one icon+color.
enum PRKind: String, Equatable {
    case merged, closed, draft
    case checksFailing, changesRequested, commentsToAddress, checksPending, reviewRequired
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
    /// Fold the unresolved-review-thread count into an already-classified kind.
    ///
    /// A separate step rather than a parameter on `classify`, because the two facts arrive from
    /// two different `gh` calls: `classify` runs on `gh pr view`, while the thread count comes
    /// from a later GraphQL fetch. Passing it to `classify` would mean a parameter that is
    /// always zero in production.
    ///
    /// Unresolved comments rank **below** the two hard blocks — a red build and a formal
    /// changes-requested, both of which already say "your move" — and **above** everything
    /// softer, because waiting for CI is not something you can act on and an unaddressed comment
    /// is. On a merged, closed or draft PR the threads are stale trivia, not a call to action.
    static func withUnresolvedComments(_ kind: PRKind, count: Int) -> PRKind {
        guard count > 0 else { return kind }
        switch kind {
        case .merged, .closed, .draft, .checksFailing, .changesRequested:
            return kind
        case .commentsToAddress, .checksPending, .reviewRequired, .mergeReady, .open:
            return .commentsToAddress
        }
    }

    /// Reduce a PR's fields to one `PRKind`, most-urgent-wins:
    /// merged → closed → draft → checks failing → changes requested → checks pending →
    /// review required → merge-ready (clean) → open.
    ///
    /// Unresolved review threads are folded in afterwards by `withUnresolvedComments`.
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

    /// The sidebar's one-icon reduction of an already-parsed detail, so a single `gh`
    /// call can serve both and the two can never describe the same PR differently.
    static func reduce(_ detail: PRDetail) -> PRStatus {
        PRStatus(number: detail.number, url: detail.url,
                 kind: classify(state: detail.state,
                                isDraft: detail.isDraft,
                                reviewDecision: detail.reviewDecision,
                                checks: detail.rollup,
                                mergeState: detail.mergeability.isReady ? "CLEAN" : ""))
    }
}

// MARK: - Detail (the workbench's PR band)

/// What a review submits as.
enum PRReviewVerdict: Equatable {
    case approve, requestChanges, comment

    var flag: String {
        switch self {
        case .approve:        return "--approve"
        case .requestChanges: return "--request-changes"
        case .comment:        return "--comment"
        }
    }

    /// `gh` rejects request-changes and comment reviews with no body.
    var requiresBody: Bool { self != .approve }
}

/// How to merge.
enum PRMergeMethod: String, Equatable, CaseIterable {
    case merge, squash, rebase

    var flag: String { "--\(rawValue)" }
    var title: String { rawValue.capitalized }
}

/// One status check, kept individually rather than rolled up.
struct PRCheck: Equatable, Identifiable {
    let name: String
    let verdict: ChecksVerdict
    /// Where to open the run, when the payload carries one.
    let url: String?

    var id: String { name + (url ?? "") }
}

/// Whether a PR can be merged right now, and if not, why.
///
/// `gh`'s `mergeStateStatus` is the useful field and its vocabulary is not obvious, so it
/// is mapped to something a button can be disabled with *and* explain.
enum PRMergeability: Equatable {
    case ready
    case blocked(String)
    case unknown

    var isReady: Bool { self == .ready }
    var reason: String? { if case .blocked(let why) = self { return why }; return nil }
}

/// Everything the workbench's PR band shows. `PRStatus` reduces a PR to one icon for the
/// sidebar; this keeps the detail that reduction throws away.
struct PRDetail: Equatable {
    let number: Int
    let url: String
    let title: String
    let state: String
    let isDraft: Bool
    let reviewDecision: String
    let mergeability: PRMergeability
    let checks: [PRCheck]

    /// Merged or closed — the PR is history. Its review decision and checks are stale
    /// trivia at that point, and showing them without the state reads as "ready to go".
    var isHistory: Bool { ["MERGED", "CLOSED"].contains(state.uppercased()) }

    var rollup: ChecksVerdict { PR.checksVerdict(ofParsed: checks) }
    var failingChecks: [PRCheck] { checks.filter { $0.verdict == .failing } }

    /// "3 of 12 passing" style summary, or nil when the PR has no checks at all.
    var checksSummary: String? {
        guard !checks.isEmpty else { return nil }
        let passing = checks.filter { $0.verdict == .passing }.count
        return "\(passing)/\(checks.count) checks passing"
    }
}

extension PR {
    /// Roll already-parsed checks up, same precedence as `checksVerdict(from:)`.
    static func checksVerdict(ofParsed checks: [PRCheck]) -> ChecksVerdict {
        guard !checks.isEmpty else { return .none }
        if checks.contains(where: { $0.verdict == .failing }) { return .failing }
        if checks.contains(where: { $0.verdict == .pending }) { return .pending }
        return .passing
    }

    /// One rollup entry's verdict. Shared with `checksVerdict(from:)` so a single check
    /// and the rollup can never disagree about what a status string means.
    static func verdict(ofRollupItem item: [String: Any]) -> ChecksVerdict {
        let failing: Set<String> = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED",
                                    "ACTION_REQUIRED", "STARTUP_FAILURE"]
        let pending: Set<String> = ["PENDING", "EXPECTED", "IN_PROGRESS", "QUEUED",
                                    "WAITING", "REQUESTED"]
        let status = (item["status"] as? String)?.uppercased() ?? ""
        let conclusion = (item["conclusion"] as? String)?.uppercased() ?? ""
        let contextState = (item["state"] as? String)?.uppercased() ?? ""
        let verdict: String
        if !conclusion.isEmpty { verdict = conclusion }
        else if !contextState.isEmpty { verdict = contextState }
        else if !status.isEmpty, status != "COMPLETED" { verdict = "PENDING" }
        else { verdict = "" }

        if failing.contains(verdict) { return .failing }
        if pending.contains(verdict) { return .pending }
        return verdict.isEmpty ? .none : .passing
    }

    /// `gh`'s `mergeStateStatus`, translated into something a disabled button can say.
    static func mergeability(state: String, isDraft: Bool, mergeStateStatus: String) -> PRMergeability {
        guard state.uppercased() == "OPEN" else {
            return .blocked("This PR is \(state.lowercased()).")
        }
        if isDraft { return .blocked("This PR is a draft.") }
        switch mergeStateStatus.uppercased() {
        case "CLEAN", "HAS_HOOKS": return .ready
        case "BLOCKED":  return .blocked("Merging is blocked — required reviews or checks are outstanding.")
        case "BEHIND":   return .blocked("The branch is behind its base; update it first.")
        case "DIRTY":    return .blocked("There are merge conflicts to resolve.")
        case "UNSTABLE": return .blocked("Some checks are failing.")
        case "DRAFT":    return .blocked("This PR is a draft.")
        case "":         return .unknown
        default:         return .unknown
        }
    }

    /// Parse the same `gh pr view --json …` payload `parse(_:)` reads, keeping the
    /// individual checks and the merge state instead of collapsing them.
    static func parseDetail(_ data: Data) -> PRDetail? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let number = obj["number"] as? Int,
              let url = obj["url"] as? String, !url.isEmpty else { return nil }

        let rollup = obj["statusCheckRollup"] as? [[String: Any]] ?? []
        let checks: [PRCheck] = rollup.map { item in
            // CheckRun calls it `name`, StatusContext calls it `context`.
            let name = (item["name"] as? String)
                ?? (item["context"] as? String)
                ?? "check"
            let link = (item["detailsUrl"] as? String) ?? (item["targetUrl"] as? String)
            return PRCheck(name: name, verdict: verdict(ofRollupItem: item),
                           url: (link?.isEmpty == false) ? link : nil)
        }

        let state = obj["state"] as? String ?? "OPEN"
        let isDraft = obj["isDraft"] as? Bool ?? false
        return PRDetail(
            number: number,
            url: url,
            title: obj["title"] as? String ?? "",
            state: state,
            isDraft: isDraft,
            reviewDecision: obj["reviewDecision"] as? String ?? "",
            mergeability: mergeability(state: state, isDraft: isDraft,
                                       mergeStateStatus: obj["mergeStateStatus"] as? String ?? ""),
            checks: checks
        )
    }
}
