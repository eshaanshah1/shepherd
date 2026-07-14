import SwiftUI

/// The content-area placeholder shown while a git worktree is being created — the
/// terminal surface can't mount until its directory exists. A centered spinner over
/// the branch name on the terminal ground.
struct WorktreeProvisioningView: View {
    let name: String

    var body: some View {
        ZStack {
            Theme.ground
            VStack(spacing: 14) {
                ProgressView()
                    .controlSize(.large)
                    .tint(Theme.working)
                Text("Creating worktree")
                    .font(.ui(12))
                    .foregroundStyle(Theme.textSecondary)
                Text(name)
                    .font(.mono(13))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
            }
            .padding(24)
        }
    }
}
