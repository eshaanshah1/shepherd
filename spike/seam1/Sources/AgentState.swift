import SwiftUI

/// The four agent states Shepherd tracks. See SPEC.md §2.
enum AgentState: String, CaseIterable {
    case working
    case blocked
    case needsCheck = "need-to-check"
    case idle

    /// Agent-driven transitions, fed from the Claude Code plugin's hook events.
    /// `nil` => no state change here (e.g. SessionEnd is handled as removal).
    static func from(event: String) -> AgentState? {
        switch event {
        case "SessionStart":                                  return .idle
        case "UserPromptSubmit", "PreToolUse", "PostToolUse": return .working
        case "Notification":                                  return .blocked
        case "Stop":                                          return .needsCheck
        default:                                              return nil
        }
    }

    var color: Color {
        switch self {
        case .working:    return .blue
        case .blocked:    return .red
        case .needsCheck: return .yellow
        case .idle:       return .secondary
        }
    }

    /// Pulls you in: attention queue + dock badge + backgrounded alert.
    var wantsAttention: Bool { self == .blocked || self == .needsCheck }
}
