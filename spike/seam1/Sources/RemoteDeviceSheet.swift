import SwiftUI

/// Self-drawn Theme card listing the user's own tailnet devices (via TailscaleDiscovery).
/// Pairable rows (online + Shepherd serving) are clickable → addRemoteHost; others greyed
/// with a reason. Backdrop click / Esc dismisses. Matches PairingApprovalView styling.
struct RemoteDeviceSheet: View {
    @EnvironmentObject var store: AgentStore
    @State private var rows: [RemoteDeviceRow] = []
    @State private var loading = true
    @State private var pairing: Set<String> = []   // row ids we've clicked to pair
    @State private var codeTarget: String?         // LAN host id whose code field is open
    @State private var code = ""

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

                if !store.lanHosts.isEmpty || store.lanPairingSAS != nil
                    || store.lanPairingError != nil {
                    Divider().overlay(Theme.hairline)
                    Text("ON THIS NETWORK")
                        .font(.ui(10, .semibold)).foregroundStyle(Theme.textDim)
                    if let err = store.lanPairingError {
                        Text(err)
                            .font(.ui(11)).foregroundStyle(Theme.error)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.horizontal, 10).padding(.vertical, 8)
                            .background(RoundedRectangle(cornerRadius: 7).fill(Theme.raised))
                        ForEach(store.lanHosts) { host in lanRow(host) }
                    } else if let sas = store.lanPairingSAS {
                        pairingInProgress(sas)
                    } else {
                        Text("Nothing here is verified — pair with the code shown on that Mac.")
                            .font(.ui(11)).foregroundStyle(Theme.textDim)
                            .fixedSize(horizontal: false, vertical: true)
                        ForEach(store.lanHosts) { host in lanRow(host) }
                    }
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
        .onAppear { refresh(); store.startLANBrowsing() }
        .onDisappear { store.stopLANBrowsing() }
    }

    /// A discovered host. Tapping it asks for the code showing on that Mac — there is nothing
    /// about the row itself that could stand in for identity.
    @ViewBuilder private func lanRow(_ host: LANHost) -> some View {
        let entering = codeTarget == host.id
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Image(systemName: "wifi").font(.system(size: 13))
                    .foregroundStyle(Theme.textPrimary).frame(width: 18)
                VStack(alignment: .leading, spacing: 1) {
                    Text(host.name).font(.ui(13, .medium)).foregroundStyle(Theme.textPrimary)
                    Text("unverified — needs the code").font(.ui(11)).foregroundStyle(Theme.textSecondary)
                }
                Spacer()
            }
            if entering {
                HStack(spacing: 8) {
                    TextField("6-digit code", text: $code)
                        .font(.system(size: 13, design: .monospaced))
                        .textFieldStyle(.plain)
                        .padding(.horizontal, 8).padding(.vertical, 5)
                        .background(RoundedRectangle(cornerRadius: 6).fill(Theme.ground))
                    Button("Pair") { pairLAN(host) }
                        .buttonStyle(.plain)
                        .font(.ui(12, .semibold))
                        .foregroundStyle(code.count == 6 ? Theme.textPrimary : Theme.textDim)
                        .disabled(code.count != 6)
                }
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 7).fill(Theme.raised))
        .contentShape(Rectangle())
        .onTapGesture { codeTarget = host.id; code = "" }
    }

    /// While a pairing is in flight: the digits this Mac derived from the certificate it was
    /// actually handed. The user picks these on the host — a mismatch is the detection.
    @ViewBuilder private func pairingInProgress(_ sas: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Pick this code on that Mac:")
                .font(.ui(12, .medium)).foregroundStyle(Theme.textPrimary)
            Text(sas)
                .font(.system(size: 22, weight: .semibold, design: .monospaced))
                .foregroundStyle(Theme.textPrimary)
            Text("If it isn't offered there, cancel — something is intercepting the connection.")
                .font(.ui(11)).foregroundStyle(Theme.textDim)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 7).fill(Theme.raised))
    }

    private func pairLAN(_ host: LANHost) {
        guard case let .service(_, _, _, _) = host.endpoint else { return }
        // Resolve through Bonjour by connecting to the service endpoint's own host form: the
        // browser gives a service name, and NWConnection resolves it, so pass the name through.
        store.addLANHost(host: host.name + ".local", code: code)
        codeTarget = nil; code = ""
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
