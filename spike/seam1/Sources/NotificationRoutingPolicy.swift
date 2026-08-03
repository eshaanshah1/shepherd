import Foundation

/// Pure routing of an attention transition across three destinations: this Mac, any paired
/// Mac streaming the pane, and the phone. Mirrors SleepPolicy: pure, unit-tested, no AppKit.
///
/// `banner` and `sound` are separate because a remote Mac wants the chime and not the banner.
/// They still move together for the *host*, which is what the old single `local` flag encoded.
struct Routing: Equatable {
    let banner: Bool            // host desktop banner
    let sound: Bool             // host attention chime
    let chimeDevices: [String]  // deviceIDs of paired Macs streaming this pane
    let fcm: Bool               // data-only push to paired phones
}

enum NotificationRoutingPolicy {
    /// - Parameters:
    ///   - isAway: lid shut with no external display — nobody is at this Mac.
    ///   - viewing: the user has eyes on this pane *here* (ADR 0020's one predicate).
    ///   - macViewers: deviceIDs of paired Macs with a live data channel on this pane.
    ///
    /// A streaming Mac chimes **unconditionally** — even when `viewing` is true here, and even
    /// when the host is also alerting. That is a deliberate departure from ADR 0020 for the
    /// remote destination only: on a mirror the chime is the reason the pane is open, and a
    /// missed one costs more than a redundant one. The host's own `viewing` landing is intact.
    ///
    /// The phone is the fallback and loses to a present Mac: push fires only when this Mac is
    /// away *and* no paired Mac is streaming the pane.
    static func decide(isAway: Bool, viewing: Bool, macViewers: [String]) -> Routing {
        // A shut lid is not a pair of eyes. `viewing` must not suppress anything while away:
        // `NSApp.isActive` and `isFrontPane` both stay true in clamshell, so a turn finishing
        // there suppressed the banner (right — nobody can see it) AND the phone push (wrong —
        // that is the only surface left). `isViewing` filters this at source too; keeping it
        // here as well means a regression there costs a redundant push, not a silent one.
        let seen = viewing && !isAway
        let present = !seen && !isAway
        return Routing(banner: present,
                       sound: present,
                       chimeDevices: macViewers,
                       fcm: !seen && isAway && macViewers.isEmpty)
    }

    /// On the away→present edge, the pane ids still needing attention (to desktop-banner —
    /// no sound burst). Panes resolved while away already left their attention state, so
    /// they're naturally excluded — no cross-device bookkeeping needed.
    static func catchUpTargets(_ panes: [(id: String, state: AgentState)]) -> [String] {
        panes.filter { $0.state.wantsAttention }.map { $0.id }
    }
}
