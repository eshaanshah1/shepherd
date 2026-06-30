import SwiftUI

/// Sheet shown when a remote device passes the pairing code and is awaiting the
/// user's approval. Self-drawn `Theme` card over a dimmed backdrop (matches
/// NewWorkspaceModal; no native sheet/alert). Allow / Deny resolve the request;
/// a backdrop click or Escape denies (a pending pairing must not linger).
struct PairingApprovalView: View {
    @EnvironmentObject var store: AgentStore

    var body: some View {
        ZStack {
            Color.black.opacity(0.35)
                .ignoresSafeArea()
                .onTapGesture { store.respondToApproval(false) }

            VStack(alignment: .leading, spacing: 14) {
                Text("Pair this device?")
                    .font(.ui(15, .semibold))
                    .foregroundStyle(Theme.textPrimary)

                Text("“\(store.pendingApproval?.name ?? "A device")” wants to monitor and control your agents.")
                    .font(.ui(13))
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 8) {
                    Spacer()
                    button("Deny", weight: .medium, fg: Theme.textSecondary,
                           bg: Theme.raised) { store.respondToApproval(false) }
                    button("Allow", weight: .semibold, fg: Theme.textPrimary,
                           bg: Theme.working) { store.respondToApproval(true) }
                }
            }
            .padding(18)
            .frame(width: 320)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Theme.ground)
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Theme.hairline, lineWidth: 1))
            )
            .shadow(color: .black.opacity(0.55), radius: 30, x: 0, y: 16)
        }
        .onExitCommand { store.respondToApproval(false) }
    }

    private func button(_ title: String, weight: Font.Weight, fg: Color, bg: Color,
                        action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.ui(12, weight))
                .foregroundStyle(fg)
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(bg))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .focusable(false)
    }
}
