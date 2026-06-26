import SwiftUI

struct SidebarView: View {
    @EnvironmentObject var store: AgentStore

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 2) {
                    ForEach(store.tabs) { tab in
                        TabRow(tab: tab, isSelected: tab.tabID == store.selected)
                            .onTapGesture { store.select(tab.tabID) }
                    }
                }
                .padding(6)
            }

            Divider()
            HStack {
                Button(action: { store.newTab() }) {
                    Label("New Tab", systemImage: "plus")
                        .font(.system(size: 12))
                }
                .buttonStyle(.plain)
                Spacer()
            }
            .padding(8)
        }
    }
}

private struct TabRow: View {
    let tab: Agent
    let isSelected: Bool
    @EnvironmentObject var store: AgentStore
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(tab.state.color)
                .frame(width: 8, height: 8)
            Text(tab.title)
                .lineLimit(1)
                .foregroundStyle(tab.state == .shell ? .secondary : .primary)
            Spacer(minLength: 4)
            if tab.state.isAgent {
                Text(tab.state.rawValue)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            if hovering && store.tabs.count > 1 {
                Button(action: { store.closeTab(tab.tabID) }) {
                    Image(systemName: "xmark").font(.system(size: 9))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(isSelected ? Color.accentColor.opacity(0.25) : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
    }
}
