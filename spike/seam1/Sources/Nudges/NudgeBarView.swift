import SwiftUI

/// The one-line strip above a pane: what is true, and the one thing to do about it.
///
/// Renders nothing at all when there is no nudge, so the pane's content keeps a single
/// structural position (see `PaneChrome`).
struct NudgeBarView: View {
    @EnvironmentObject var store: AgentStore
    let paneID: String

    var body: some View {
        Group {
            if let nudge = store.barNudge(forPane: paneID) {
                bar(nudge)
            }
        }
    }

    private func bar(_ nudge: Nudge) -> some View {
        HStack(spacing: 8) {
            TablerIcon(paths: Tabler.paths(for: nudge.glyph), size: 12)
                .foregroundStyle(tint(nudge))
            Text(nudge.text)
                .font(.ui(11, .regular))
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
            Spacer(minLength: 8)
            Button(label(nudge)) { store.run(nudge.action, forPane: paneID) }
                .buttonStyle(.plain)
                .font(.ui(11, .medium))
                .foregroundStyle(tint(nudge))
                .focusable(false)
            Button {
                store.dismissBar(nudge.id, forPane: paneID)
            } label: {
                TablerIcon(paths: Tabler.x, size: 10)
                    .foregroundStyle(Theme.textDim)
            }
            .buttonStyle(.plain)
            .focusable(false)
        }
        .padding(.horizontal, 10)
        .frame(height: 26)
        .background(Theme.surface2)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Theme.hairline).frame(height: 1)
        }
        // A first-fire bar is spent the moment it is drawn.
        .onAppear { store.markNudgeSeen(nudge.id) }
    }

    private func tint(_ n: Nudge) -> Color {
        switch n.urgency {
        case .attention:     return Theme.blocked
        case .informational: return Theme.textDim
        }
    }

    private func label(_ n: Nudge) -> String {
        switch n.id {
        case .resolveConflicts: return "Resolve"
        case .continueSequence: return "Continue"
        case .reviewChanges:    return "Review ⌘G"
        case .createPR:         return "Create PR"
        }
    }
}
