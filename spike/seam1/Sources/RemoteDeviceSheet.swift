import SwiftUI

/// Self-drawn Theme card listing the user's own tailnet devices (via TailscaleDiscovery).
/// Pairable rows (online + Shepherd serving) are clickable → addRemoteHost; others greyed
/// with a reason. Backdrop click / Esc dismisses. Matches PairingApprovalView styling.
struct RemoteDeviceSheet: View {
    @EnvironmentObject var store: AgentStore
    @State private var rows: [RemoteDeviceRow] = []
    @State private var loading = true
    @State private var pairing: Set<String> = []   // row ids we've clicked to pair

    var body: some View {
        ZStack {
            Color.black.opacity(0.35).ignoresSafeArea().onTapGesture { dismiss() }

            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Add remote device").font(.ui(15, .semibold)).foregroundStyle(Theme.textPrimary)
                    Spacer()
                    Button(action: refresh) {
                        Image(systemName: "arrow.clockwise").font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(Theme.textDim)
                    }.buttonStyle(.plain).focusable(false)
                }

                if loading {
                    Text("Scanning your tailnet…").font(.ui(13)).foregroundStyle(Theme.textSecondary)
                } else if rows.isEmpty {
                    Text("No other devices found on your tailnet. Make sure Tailscale is running.")
                        .font(.ui(13)).foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    ForEach(rows) { row in deviceRow(row) }
                }
            }
            .padding(18)
            .frame(width: 360)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.ground)
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Theme.hairline, lineWidth: 1))
            )
            .shadow(color: .black.opacity(0.55), radius: 30, x: 0, y: 16)
        }
        .onExitCommand { dismiss() }
        .onAppear { refresh() }
    }

    @ViewBuilder private func deviceRow(_ row: RemoteDeviceRow) -> some View {
        let enabled = row.pairability == .pairable && !pairing.contains(row.id)
        HStack(spacing: 10) {
            Image(systemName: glyph(row.os)).font(.system(size: 13))
                .foregroundStyle(enabled ? Theme.textPrimary : Theme.textDim).frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                Text(row.name).font(.ui(13, .medium))
                    .foregroundStyle(enabled ? Theme.textPrimary : Theme.textDim)
                Text(subtitle(row)).font(.ui(11)).foregroundStyle(Theme.textSecondary)
            }
            Spacer()
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 7).fill(enabled ? Theme.raised : .clear))
        .contentShape(Rectangle())
        .onTapGesture { if enabled { pair(row) } }
    }

    private func subtitle(_ row: RemoteDeviceRow) -> String {
        if pairing.contains(row.id) { return "pairing… (approve on that device)" }
        switch row.pairability {
        case .pairable:   return "ready to pair"
        case .notServing: return "Shepherd not running"
        case .offline:    return "offline"
        }
    }

    private func glyph(_ os: String) -> String {
        switch os.lowercased() {
        case "ios", "android": return "iphone"
        case "macos": return "laptopcomputer"
        default: return "desktopcomputer"
        }
    }

    private func refresh() {
        loading = true
        store.discoverDevices { r in self.rows = r; self.loading = false }
    }

    private func pair(_ row: RemoteDeviceRow) {
        guard let ip = row.ipv4 else { return }
        pairing.insert(row.id)
        store.addRemoteHost(host: ip, port: AgentStore.defaultRemotePort)
    }

    private func dismiss() { store.showingRemoteDevices = false }
}
