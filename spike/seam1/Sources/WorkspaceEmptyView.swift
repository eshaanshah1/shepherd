import SwiftUI

/// Shown in the content area when the selected workspace has no tabs. A workspace
/// can now be empty (closing its last tab no longer reseeds one), so this is the
/// resting state, not an error. New Tab opens the composer.
struct WorkspaceEmptyView: View {
    @EnvironmentObject var store: AgentStore

    var body: some View {
        VStack(spacing: 14) {
            Text("No tabs")
                .font(.ui(15, .medium))
                .foregroundStyle(Theme.textPrimary)
            Text("⌘T to open one")
                .font(.ui(12, .regular))
                .foregroundStyle(Theme.textDim)
            Button("New Tab") { store.promptingNewTab = true }
                .buttonStyle(.borderedProminent)
                .focusable(false)
                .padding(.top, 4)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
