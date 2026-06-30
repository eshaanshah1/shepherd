import Foundation

/// Result of folding one hook event into a pane's agent state.
struct StateTransition: Equatable {
    var state: AgentState
    var reason: String?
    var clearTitle: Bool
    var applied: Bool
    /// A `Stop` was kept at `working` because background work the turn is paused
    /// on is still in flight — drives the debug log only.
    var heldForBackground: Bool
}

/// Pure transition for one hook event (no AppKit / I/O — covered by tests).
///
/// Claude Code fires `Stop` when its synchronous loop ends, even with a
/// backgrounded agent still running (the "Waiting for N background agent(s)"
/// case). Since v2.1.145 the `Stop` payload carries `background_tasks`, whose
/// documented purpose is to tell "session is done" from "session is paused
/// waiting for background work". `report.sh` reduces that array to a count of
/// the tasks worth waiting on — backgrounded subagents / workflows / shells, but
/// NOT passive monitors — and passes it through `detail`. A `Stop` with a
/// positive count is a pause, not a finish, so the pane stays `working`.
/// An unparseable/empty count is treated as 0, reverting to plain
/// finish-on-`Stop` (fail-safe, never sticks).
func applyEvent(_ event: String, detail: String, current: AgentState,
                reason: String?) -> StateTransition {
    let midTurn = (current == .working || current == .blocked)
    var t = StateTransition(state: current, reason: reason, clearTitle: false,
                            applied: true, heldForBackground: false)
    func set(_ s: AgentState, _ r: String? = nil) { t.state = s; t.reason = r }

    switch event {
    case "SessionStart":     t.clearTitle = true; set(.idle)   // drop shell title; agent sets its own
    case "SessionEnd":       set(.shell)                       // agent gone
    case "UserPromptSubmit": set(.working)                     // new turn, from any state
    case "Stop":
        if !midTurn { t.applied = false }
        else if (Int(detail) ?? 0) > 0 { set(.working); t.heldForBackground = true }  // paused on background work
        else { set(.needsCheck) }
    case "StopFailure":
        if midTurn { set(.error, detail.isEmpty ? "API error" : detail) } else { t.applied = false }
    case "PermissionRequest":
        if midTurn { set(.blocked, detail == "ExitPlanMode" ? "plan approval"
                                 : (detail.isEmpty ? "approval needed" : "approve \(detail)")) } else { t.applied = false }
    case "Elicitation":      if midTurn { set(.blocked, "input requested") } else { t.applied = false }
    case "SubagentStart":    if midTurn { set(.working, detail.isEmpty ? "subagent" : "subagent: \(detail)") } else { t.applied = false }
    case "PreToolUse":
        if !midTurn { t.applied = false }
        else if detail == "AskUserQuestion" { set(.blocked, "answer needed") }
        else if detail == "ExitPlanMode"    { set(.blocked, "plan approval") }
        else { set(.working) }
    case "SubagentStop", "PostToolUse", "PostToolUseFailure", "ElicitationResult":
        if midTurn { set(.working) } else { t.applied = false }
    default:                 t.applied = false
    }
    return t
}
