import SwiftUI

/// Per-tab state. `shell` = a plain terminal with no agent; the other four are
/// the agent states from SPEC §2 (driven by Claude Code hook events).
enum AgentState: String, CaseIterable {
    case shell                       // plain terminal, no agent running
    case working
    case blocked
    case needsCheck = "need-to-check"
    case idle

    /// Agent-driven transitions, fed from the Claude Code plugin's hook events.
    /// `nil` => no state change here (e.g. SessionEnd is handled as "back to shell").
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
        case .shell:      return .gray
        case .working:    return .blue
        case .blocked:    return .red
        case .needsCheck: return .yellow
        case .idle:       return .secondary
        }
    }

    /// Pulls you in: attention queue + dock badge + alert. Plain shells never do.
    var wantsAttention: Bool { self == .blocked || self == .needsCheck }

    var isAgent: Bool { self != .shell }
}
