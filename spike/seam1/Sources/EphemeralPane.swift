import Foundation

/// A scratch pane that belongs to no workspace: summoned by ⌘⌥N, shown as a
/// floating overlay, tucked into a bottom-right PiP when it loses focus. Reuses
/// `Pane` for cwd / state / sessionID / displayTitle; it is always a single pane
/// (no split tree). Pure model — the store/UI live elsewhere.
struct EphemeralPane: Identifiable, Equatable {
    var pane: Pane
    var collapsed: Bool   // true = PiP thumbnail, false = the overlay
    var id: String { pane.id }
}

/// Max ephemeral panes alive at once. A summon beyond this is a no-op (spec §2).
let ephemeralPaneCap = 5

func canSpawnEphemeral(count: Int) -> Bool { count < ephemeralPaneCap }

/// Enforce the single-overlay invariant: exactly `id` un-collapsed (or none, when
/// `id` is nil). Every expand/collapse/spawn routes through this so at most one
/// overlay is ever open.
func collapsingAllExcept(_ id: String?, in panes: [EphemeralPane]) -> [EphemeralPane] {
    panes.map { var e = $0; e.collapsed = (e.id != id); return e }
}

/// Ephemeral panes wanting attention — folded into the dock badge / attention nav.
func ephemeralAttentionCount(_ panes: [EphemeralPane]) -> Int {
    panes.filter { $0.pane.state.wantsAttention }.count
}

/// Any ephemeral pane busy — folded into the sleep-guard "keep awake" trigger.
func anyEphemeralBusy(_ panes: [EphemeralPane]) -> Bool {
    panes.contains { $0.pane.state.isBusy }
}
