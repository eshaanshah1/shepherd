import SwiftUI

struct ContentView: View {
    @EnvironmentObject var agents: AgentStore

    var body: some View {
        HSplitView {
            SidebarView()
                .frame(minWidth: 220, idealWidth: 260, maxWidth: 320)

            VStack(spacing: 0) {
                GhosttyTerminal()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                Text("libghostty \(GhosttyApp.shared.version)")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
            }
        }
    }
}
