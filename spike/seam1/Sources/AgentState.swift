import SwiftUI

/// Per-tab state. `shell` = a plain terminal with no agent; the rest are the
/// Claude session states driven by hook events (see the lifecycle map in
/// AgentStore.apply). `error` = the turn died on an API error (StopFailure).
enum AgentState: String, CaseIterable {
    case shell                       // plain terminal, no agent running
    case working
    case blocked                     // waiting on the user (permission / plan / elicitation)
    case needsCheck = "need-to-check"
    case idle
    case error                       // turn ended on an API error

    var color: Color {
        switch self {
        case .shell:      return Theme.textDim
        case .working:    return Theme.working
        case .blocked:    return Theme.blocked
        case .needsCheck: return Theme.needsCheck
        case .idle:       return Theme.idle
        case .error:      return Theme.error
        }
    }

    /// Pulls you in: attention queue + dock badge + alert. Plain shells never do.
    var wantsAttention: Bool { self == .blocked || self == .needsCheck || self == .error }

    var isAgent: Bool { self != .shell }
}
