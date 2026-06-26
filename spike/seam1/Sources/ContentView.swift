import SwiftUI

struct ContentView: View {
    @EnvironmentObject var agents: AgentStore
    let status: String

    var body: some View {
        HSplitView {
            SidebarView()
                .frame(minWidth: 220, idealWidth: 260, maxWidth: 320)
            VStack(spacing: 12) {
                Spacer()
                Image(systemName: "terminal")
                    .font(.system(size: 44))
                    .foregroundStyle(.secondary)
                Text("Terminal surface goes here — seam 1, next step")
                    .foregroundStyle(.secondary)
                Text(status)
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(nsColor: .textBackgroundColor))
        }
    }
}
