import Foundation

/// Pure routing of an attention transition. `local` gates BOTH local surfaces together —
/// the desktop banner AND the attention sound — so a closed/away machine fires neither and
/// everything routes to the phone. Mirrors SleepPolicy: pure, unit-tested, no AppKit.
struct Routing: Equatable {
    let local: Bool   // desktop banner + attention sound (both, together)
    let fcm: Bool     // data-only push to paired devices
}

enum NotificationRoutingPolicy {
    /// Present (at the machine) → local only; away (mobile) → push only. Mutually exclusive.
    static func decide(isAway: Bool) -> Routing {
        isAway ? Routing(local: false, fcm: true) : Routing(local: true, fcm: false)
    }

    /// On the away→present edge, the pane ids still needing attention (to desktop-banner —
    /// no sound burst). Panes resolved while away already left their attention state, so
    /// they're naturally excluded — no cross-device bookkeeping needed.
    static func catchUpTargets(_ panes: [(id: String, state: AgentState)]) -> [String] {
        panes.filter { $0.state.wantsAttention }.map { $0.id }
    }
}
