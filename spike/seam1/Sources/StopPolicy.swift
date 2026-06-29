import Foundation

/// Result of folding one hook event into a pane's agent state. `outstanding` is
/// the updated count of background agents launched this turn not yet seen
/// finishing — it lets a real turn-end `Stop` be told apart from a `Stop` that
/// only pauses to wait on a background agent.
struct StateTransition: Equatable {
    var state: AgentState
    var reason: String?
    var clearTitle: Bool
    var applied: Bool
    var outstanding: Int
    /// A `Stop` was kept at `working` because background agents are still in
    /// flight — drives the debug log only.
    var heldForBackground: Bool
}

/// Pure transition for one hook event (no AppKit / I/O — covered by tests).
///
/// Claude Code fires `Stop` when its synchronous loop ends, even with a
/// backgrounded agent still running (the "Waiting for N background agent(s)"
/// case). We count `PreToolUse[Agent]` launches against `SubagentStop`s; a `Stop`
/// while that count is positive is a pause, not a finish, so it stays `working`.
/// The count floors at 0, so a `Workflow`-style fan-out (more `SubagentStop`s
/// than `[Agent]` launches) just reverts to plain finish-on-`Stop`.
func applyEvent(_ event: String, detail: String, current: AgentState,
                reason: String?, outstanding: Int) -> StateTransition {
    let midTurn = (current == .working || current == .blocked)
    var t = StateTransition(state: current, reason: reason, clearTitle: false,
                            applied: true, outstanding: outstanding, heldForBackground: false)
    func set(_ s: AgentState, _ r: String? = nil) { t.state = s; t.reason = r }

    switch event {
    case "SessionStart":     t.clearTitle = true; set(.idle); t.outstanding = 0  // drop shell title; agent sets its own
    case "SessionEnd":       set(.shell); t.outstanding = 0                       // agent gone
    case "UserPromptSubmit": set(.working); t.outstanding = 0                     // new turn, from any state
    case "Stop":
        if !midTurn { t.applied = false }
        else if outstanding > 0 { set(.working); t.heldForBackground = true }     // paused for a background agent
        else { set(.needsCheck) }
    case "StopFailure":
        if midTurn { set(.error, detail.isEmpty ? "API error" : detail); t.outstanding = 0 } else { t.applied = false }
    case "PermissionRequest":
        if midTurn { set(.blocked, detail == "ExitPlanMode" ? "plan approval"
                                 : (detail.isEmpty ? "approval needed" : "approve \(detail)")) } else { t.applied = false }
    case "Elicitation":      if midTurn { set(.blocked, "input requested") } else { t.applied = false }
    case "SubagentStart":    if midTurn { set(.working, detail.isEmpty ? "subagent" : "subagent: \(detail)") } else { t.applied = false }
    case "PreToolUse":
        if !midTurn { t.applied = false }
        else if detail == "AskUserQuestion" { set(.blocked, "answer needed") }
        else if detail == "ExitPlanMode"    { set(.blocked, "plan approval") }
        else {
            if detail == "Agent" || detail == "Task" { t.outstanding = outstanding + 1 }
            set(.working)
        }
    case "SubagentStop":
        t.outstanding = max(0, outstanding - 1)                                   // count it regardless of turn state
        if midTurn { set(.working) } else { t.applied = false }
    case "PostToolUse", "PostToolUseFailure", "ElicitationResult":
        if midTurn { set(.working) } else { t.applied = false }
    default:                 t.applied = false
    }
    return t
}
