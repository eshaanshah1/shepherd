import SwiftUI
import AppKit

struct ContentView: View {
    @EnvironmentObject var store: AgentStore
    @AppStorage("shepherd.sidebarWidth") private var sidebarWidth: Double = 240
    @State private var resizeStart: Double?

    private let minSidebar: Double = 180
    private let maxSidebar: Double = 440

    var body: some View {
        HStack(spacing: 0) {
            SidebarView()
                .frame(width: sidebarWidth)

            divider

            // All tab surfaces stay mounted (and their shells alive); only the
            // selected one is visible + interactive.
            ZStack {
                Theme.ground
                ForEach(store.tabs) { tab in
                    GhosttyTerminal(tabID: tab.tabID,
                                    isSelected: tab.tabID == store.selected,
                                    focusTick: store.focusTick)
                        .opacity(tab.tabID == store.selected ? 1 : 0)
                        .allowsHitTesting(tab.tabID == store.selected)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Theme.ground)
        .ignoresSafeArea()
    }

    // 1px hairline inside a 6px draggable strip — restores sidebar resizing
    // without the chunky HSplitView divider.
    private var divider: some View {
        ZStack {
            Rectangle().fill(Theme.hairline).frame(width: 1)
        }
        .frame(width: 6)
        .contentShape(Rectangle())
        .onHover { inside in
            if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
        }
        .gesture(
            DragGesture(minimumDistance: 1)
                .onChanged { v in
                    if resizeStart == nil { resizeStart = sidebarWidth }
                    sidebarWidth = min(maxSidebar, max(minSidebar, resizeStart! + Double(v.translation.width)))
                }
                .onEnded { _ in resizeStart = nil }
        )
    }
}
