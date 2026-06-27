import SwiftUI

struct SidebarView: View {
    @EnvironmentObject var store: AgentStore

    var body: some View {
        VStack(spacing: 0) {
            List(selection: Binding(
                get: { store.selected },
                set: { if let v = $0 { store.select(v) } }
            )) {
                ForEach(store.tabs) { tab in
                    TabRow(tab: tab).tag(tab.tabID)
                }
                .onMove { store.move(fromOffsets: $0, toOffset: $1) }
            }
            .listStyle(.sidebar)

            Divider()
            HStack {
                Button(action: { store.newTab() }) {
                    Label("New Tab", systemImage: "plus").font(.system(size: 12))
                }
                .buttonStyle(.plain)
                Spacer()
            }
            .padding(8)
        }
    }
}

private struct TabRow: View {
    @EnvironmentObject var store: AgentStore
    let tab: Agent

    @State private var editing = false
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(tab.state.color).frame(width: 8, height: 8)

            if editing {
                TextField("name", text: $draft)
                    .textFieldStyle(.plain)
                    .focused($focused)
                    .onSubmit(commit)
                    .onExitCommand { editing = false }
                    .onAppear { focused = true }
            } else {
                Text(tab.displayTitle)
                    .lineLimit(1)
                    .foregroundStyle(tab.state == .shell ? .secondary : .primary)
            }

            Spacer(minLength: 4)
            if tab.state.isAgent {
                Text(tab.reason ?? tab.state.rawValue)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        // No row-level tap/drag gesture: let the List own click-to-select and
        // drag-to-reorder natively (a custom double-click gesture here swallows
        // single clicks + drags on the text). Rename lives on the context menu.
        .contextMenu {
            Button("Rename") { beginRename() }
            Button("Close Tab") { store.closeTab(tab.tabID) }
        }
    }

    private func beginRename() {
        draft = tab.userTitle ?? tab.displayTitle
        editing = true
    }
    private func commit() {
        store.rename(tabID: tab.tabID, to: draft)
        editing = false
    }
}
