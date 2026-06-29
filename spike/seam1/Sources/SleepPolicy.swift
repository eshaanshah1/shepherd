import Foundation

/// The user's keep-awake policy. Persisted by SleepGuard as the raw string.
enum CaffeinateMode: String, CaseIterable {
    case off          // never hold the Mac awake
    case whileAgents  // hold awake while any agent is busy
    case always       // hold awake the whole time Shepherd runs
}

/// Pure decision: should the Mac be held awake right now?
/// `thermalSuppressed` is the clamshell thermal override — it beats every mode.
func shouldStayAwake(mode: CaffeinateMode, hasBusyAgent: Bool, thermalSuppressed: Bool) -> Bool {
    if thermalSuppressed { return false }
    switch mode {
    case .off:         return false
    case .whileAgents: return hasBusyAgent
    case .always:      return true
    }
}
