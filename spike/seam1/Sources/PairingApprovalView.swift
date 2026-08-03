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

                if store.pendingApproval?.confirm == .compareSAS {
                    sasBody
                } else {
                    Text("“\(store.pendingApproval?.name ?? "A device")” wants to monitor and control your agents.")
                        .font(.ui(13))
                        .foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)

                    // Say what was actually checked. Otherwise Allow is a button pressed
                    // without looking, which is the thing the SAS flow exists to avoid.
                    if store.pendingApproval?.confirm == .qrVerified {
                        Text("Its connection matched the certificate in the QR code you showed it, "
                             + "so there is nothing to compare.")
                            .font(.ui(11))
                            .foregroundStyle(Theme.textDim)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    HStack(spacing: 8) {
                        Spacer()
                        button("Deny", weight: .medium, fg: Theme.textSecondary,
                               bg: Theme.raised) { store.respondToApproval(false) }
                        button("Allow", weight: .semibold, fg: Theme.textPrimary,
                               bg: Theme.working) { store.respondToApproval(true) }
                    }
                }
            }
            .padding(18)
            .frame(width: store.pendingApproval?.confirm == .compareSAS ? 360 : 320)
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

    /// The LAN variant: pick the code the other device is showing. Deliberately NOT an Allow
    /// button — a button gets pressed without looking, and then a man in the middle on the
    /// network is admitted. Picking out of three forces the comparison to actually happen.
    @ViewBuilder private var sasBody: some View {
        let name = store.pendingApproval?.name ?? "A device"
        VStack(alignment: .leading, spacing: 12) {
            Text("A device on your local network wants to pair. It gave its name as “\(name)”, which nothing has verified.")
                .font(.ui(13))
                .foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

            Text("Tap the code that device is showing.")
                .font(.ui(12, .medium))
                .foregroundStyle(Theme.textPrimary)

            HStack(spacing: 8) {
                ForEach(store.pendingApproval?.sasChoices ?? [], id: \.self) { choice in
                    Button { store.respondToSASPick(choice) } label: {
                        Text(choice)
                            .font(.system(size: 17, weight: .semibold, design: .monospaced))
                            .foregroundStyle(Theme.textPrimary)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                            .background(RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(Theme.raised))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .focusable(false)
                }
            }

            Text("If none of them match, something is intercepting the connection.")
                .font(.ui(11))
                .foregroundStyle(Theme.textDim)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 8) {
                Spacer()
                button("None of these match", weight: .medium, fg: Theme.textSecondary,
                       bg: Theme.raised) { store.respondToSASPick(nil) }
            }
        }
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
