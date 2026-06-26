import SwiftUI

struct ContentView: View {
    @EnvironmentObject var store: AgentStore

    var body: some View {
        HSplitView {
            SidebarView()
                .frame(minWidth: 200, idealWidth: 240, maxWidth: 300)

            // All tab surfaces stay mounted (and their shells alive); only the
            // selected one is visible + interactive. Stable .id keeps each
            // libghostty surface across selection changes.
            ZStack {
                Color(nsColor: .textBackgroundColor)
                ForEach(store.tabs) { tab in
                    GhosttyTerminal(tabID: tab.tabID, isSelected: tab.tabID == store.selected)
                        .opacity(tab.tabID == store.selected ? 1 : 0)
                        .allowsHitTesting(tab.tabID == store.selected)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}
