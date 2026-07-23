import SwiftUI

/// Shown in the content area when the selected workspace has no tabs. A workspace
/// can now be empty (closing its last tab no longer reseeds one), so this is the
/// resting state, not an error. New Tab / New Worktree Tab open work when wanted.
struct WorkspaceEmptyView: View {
    @EnvironmentObject var store: AgentStore
    @State private var isGitRepo = false

    private var ws: Workspace? { store.currentWorkspace }

    // Mirror the sidebar's rule: local ⇒ default dir is a work tree; mirror ⇒ wired defaultPath.
    private var worktreeEnabled: Bool {
        guard let ws else { return false }
        return ws.isRemote ? (ws.defaultPath?.isEmpty == false) : isGitRepo
    }

    var body: some View {
        VStack(spacing: 14) {
            Text("No tabs")
                .font(.ui(15, .medium))
                .foregroundStyle(Theme.textPrimary)
            Text("⌘T to open one")
                .font(.ui(12, .regular))
                .foregroundStyle(Theme.textDim)
            HStack(spacing: 10) {
                Button("New Tab") { store.newTab() }
                    .buttonStyle(.borderedProminent)
                if worktreeEnabled {
                    Button("New Worktree Tab…") { promptNewWorktree() }
                        .buttonStyle(.bordered)
                }
            }
            .focusable(false)
            .padding(.top, 4)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear(perform: refreshGitStatus)
        .onChange(of: store.selectedWorkspaceID) { _ in refreshGitStatus() }
    }

    private func refreshGitStatus() {
        guard let ws, !ws.isRemote, let p = ws.defaultPath, !p.isEmpty else { isGitRepo = false; return }
        let dir = (p as NSString).expandingTildeInPath
        DispatchQueue.global(qos: .userInitiated).async {
            let ok = Git.isWorkTree(dir)
            DispatchQueue.main.async { isGitRepo = ok }
        }
    }

    private func promptNewWorktree() {
        guard let ws else { return }
        let alert = NSAlert()
        alert.messageText = "New worktree tab"
        alert.informativeText = "Branch name for the new worktree:"
        alert.addButton(withTitle: "Create")
        alert.addButton(withTitle: "Cancel")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 240, height: 24))
        alert.accessoryView = field
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let name = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        store.newWorktreeTab(inWorkspace: ws.id, name: name)
    }
}
