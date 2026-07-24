import Foundation

/// Decides whether the app may auto-restart to install an update. "Idle" means:
/// no agent is actively working or waiting on the user, and no plain shell pane
/// has a live foreground command. A *finished* agent (idle/need-to-check/error)
/// never blocks — its Claude session and the layout are restored on relaunch, so
/// a restart is safe. Mirrors the pure-decision pattern of SleepPolicy/StopPolicy.
enum IdlePolicy {
    static func paneBlocksRestart(state: AgentState, shellHasForegroundProcess: Bool) -> Bool {
        switch state {
        case .working, .blocked: return true
        case .shell:             return shellHasForegroundProcess
        case .idle, .needsCheck, .error: return false
        }
    }

    static func allIdle(_ panes: [(state: AgentState, shellHasForegroundProcess: Bool)]) -> Bool {
        !panes.contains { paneBlocksRestart(state: $0.state, shellHasForegroundProcess: $0.shellHasForegroundProcess) }
    }
}
