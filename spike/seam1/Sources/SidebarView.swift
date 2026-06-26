import SwiftUI

struct SidebarView: View {
    @EnvironmentObject var agents: AgentStore

    var body: some View {
        List(agents.agents) { agent in
            HStack(spacing: 10) {
                Circle()
                    .fill(agent.state.color)
                    .frame(width: 9, height: 9)
                VStack(alignment: .leading, spacing: 2) {
                    Text(agent.title).lineLimit(1)
                    Text(agent.state.rawValue)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            .opacity(agent.state == .idle ? 0.55 : 1)   // idle rows dim
        }
        .listStyle(.sidebar)
    }
}
