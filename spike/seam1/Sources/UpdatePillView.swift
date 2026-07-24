import SwiftUI

/// The quiet "update available" pill pinned at the bottom of the sidebar, plus
/// its popover (release notes + Download & Install, then Restart choices). Close
/// (×) = skip this version. Hidden when the controller is idle/checking/up-to-date.
struct UpdatePillView: View {
    @EnvironmentObject var updater: UpdateController
    @State private var showPopover = false

    var body: some View {
        if let label = pillLabel {
            HStack(spacing: 8) {
                Image(systemName: pillIcon)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.needsCheck)
                Text(label)
                    .font(.ui(11, .medium))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                Spacer(minLength: 4)
                if canSkip {
                    Button(action: { updater.skipCurrent() }) {
                        Image(systemName: "xmark")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(Theme.textDim)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .focusable(false)
                    .help("Skip this version")
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(Theme.surface2)
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.hairline, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
            .onTapGesture { showPopover = true }
            .popover(isPresented: $showPopover, arrowEdge: .top) { UpdatePopover().environmentObject(updater) }
            .focusable(false)
        }
    }

    private var pillLabel: String? {
        switch updater.phase {
        case .available(let u): return "Update available (\(u.tag))"
        case .downloading(let p): return "Updating… \(Int(p * 100))%"
        case .readyToRestart: return updater.restartWhenIdle ? "Will restart when idle" : "Update ready"
        case .restarting: return "Restarting…"
        default: return nil
        }
    }
    private var pillIcon: String {
        if case .downloading = updater.phase { return "arrow.down.circle" }
        return "arrow.up.circle"
    }
    private var canSkip: Bool {
        if case .available = updater.phase { return true }
        if case .readyToRestart = updater.phase { return true }
        return false
    }
}

/// The pill's popover: notes + primary action for the current phase.
struct UpdatePopover: View {
    @EnvironmentObject var updater: UpdateController

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            switch updater.phase {
            case .available(let u):
                header("Shepherd \(u.tag)")
                notes(u.notes)
                Button("Download & Install") { updater.beginDownload() }
            case .downloading(let p):
                header("Downloading…")
                ProgressView(value: p).frame(width: 240)
            case .readyToRestart(let u):
                header("Shepherd \(u.tag) is ready")
                if let c = updater.countdown {
                    Text("Restarting in \(c)s…").font(.ui(12)).foregroundStyle(Theme.textSecondary)
                    Button("Cancel") { updater.cancelRestart() }
                } else {
                    HStack(spacing: 8) {
                        Button("Restart now") { updater.restartNow() }
                        Button("Restart when idle") { updater.armRestartWhenIdle() }
                    }
                }
            default:
                EmptyView()
            }
        }
        .padding(16)
        .frame(maxWidth: 300, alignment: .leading)
        .background(Theme.raised)
    }

    private func header(_ t: String) -> some View {
        Text(t).font(.ui(13, .semibold)).foregroundStyle(Theme.textPrimary)
    }
    private func notes(_ body: String) -> some View {
        ScrollView {
            Text(body.isEmpty ? "No release notes." : body)
                .font(.ui(11)).foregroundStyle(Theme.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }.frame(maxHeight: 160)
    }
}
