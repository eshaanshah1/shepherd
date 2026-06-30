import SwiftUI
import AppKit

/// The custom (non-native) workspace dropdown — a self-drawn `Theme` panel (no
/// `NSPopover` chrome): one row per workspace (aggregate dot + name),
/// click-to-switch, inline rename, delete-with-confirm, and drag-to-reorder.
/// Sized + positioned by the host (`ContentView` overlay).
struct WorkspaceSwitcher: View {
    @EnvironmentObject var store: AgentStore
    @Binding var isPresented: Bool

    @State private var renamingID: String?
    @State private var draft = ""
    @FocusState private var renameFocused: Bool

    @State private var draggingID: String?
    @State private var dragOffset: CGFloat = 0

    private static let rowStride: CGFloat = 30   // 28 row height + 2 spacing

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(store.workspaces.enumerated()), id: \.element.id) { idx, ws in
                row(ws, index: idx)
            }
            if store.isServing { pairingFooter }
        }
        .padding(6)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Theme.ground)
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(Theme.hairline, lineWidth: 1)
                )
        )
        .shadow(color: .black.opacity(0.5), radius: 18, x: 0, y: 10)
    }

    /// Shown only while remote serving is on: the code a new device must enter to pair.
    private var pairingFooter: some View {
        VStack(alignment: .leading, spacing: 3) {
            Divider().overlay(Theme.hairline).padding(.vertical, 4)
            Text("PAIRING CODE")
                .font(.ui(9, .semibold))
                .foregroundStyle(Theme.textDim)
            Text(store.pairingCode)
                .font(.system(size: 17, weight: .semibold, design: .monospaced))
                .foregroundStyle(Theme.textPrimary)
                .textSelection(.enabled)
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 4)
    }

    @ViewBuilder
    private func row(_ ws: Workspace, index: Int) -> some View {
        let isSelected = ws.id == store.selectedWorkspaceID
        HStack(spacing: 9) {
            LeadingIcon(state: ws.aggregateState)

            if renamingID == ws.id {
                TextField("name", text: $draft)
                    .textFieldStyle(.plain)
                    .font(.ui(13))
                    .foregroundStyle(Theme.textPrimary)
                    .focused($renameFocused)
                    .onSubmit { commitRename(ws.id) }
                    .onExitCommand { renamingID = nil }
                    .onAppear { renameFocused = true }
            } else {
                Text(ws.displayName(index: index))
                    .font(.ui(13, isSelected ? .medium : .regular))
                    .foregroundStyle(isSelected ? Theme.textPrimary : Theme.textSecondary)
                    .lineLimit(1)
                Spacer(minLength: 6)
                if store.workspaces.count > 1 {
                    Button(action: { confirmDelete(ws) }) {
                        Image(systemName: "xmark")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(Theme.textDim)
                    }
                    .buttonStyle(.plain)
                    .focusable(false)
                    .help("Delete workspace")
                }
            }
        }
        .padding(.horizontal, 10)
        .frame(height: 28)
        .background(RoundedRectangle(cornerRadius: 6)
            .fill(isSelected ? Theme.raised : Color.clear))
        .contentShape(Rectangle())
        .offset(y: draggingID == ws.id ? dragOffset : 0)
        .zIndex(draggingID == ws.id ? 1 : 0)
        .onTapGesture {
            guard renamingID != ws.id else { return }
            store.selectWorkspace(ws.id)
            isPresented = false
        }
        .gesture(reorderGesture(ws.id))
        .contextMenu {
            Button("Rename") { beginRename(ws, index: index) }
            if store.workspaces.count > 1 {
                Button("Delete", role: .destructive) { confirmDelete(ws) }
            }
        }
    }

    private func beginRename(_ ws: Workspace, index: Int) {
        draft = ws.userTitle ?? ws.displayName(index: index)
        renamingID = ws.id
    }
    private func commitRename(_ id: String) {
        store.renameWorkspace(id, to: draft)
        renamingID = nil
    }

    /// Confirm only when the workspace holds a live agent (delete kills its PTYs).
    private func confirmDelete(_ ws: Workspace) {
        guard store.workspaceHasLiveAgent(ws.id) else { store.deleteWorkspace(ws.id); return }
        let alert = NSAlert()
        alert.messageText = "Delete this workspace?"
        alert.informativeText = "It has running agents. Closing it ends their sessions."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Delete")
        alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn { store.deleteWorkspace(ws.id) }
    }

    private func reorderGesture(_ id: String) -> some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in
                if draggingID == nil { draggingID = id }
                guard draggingID == id,
                      let from = store.workspaces.firstIndex(where: { $0.id == id }) else { return }
                dragOffset = value.translation.height
                let target = max(0, min(store.workspaces.count - 1,
                                        from + Int((dragOffset / Self.rowStride).rounded())))
                if target != from {
                    store.reorderWorkspace(id, toIndex: target)
                    dragOffset -= CGFloat(target - from) * Self.rowStride
                }
            }
            .onEnded { _ in draggingID = nil; dragOffset = 0 }
    }
}
