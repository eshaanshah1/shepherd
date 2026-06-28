import SwiftUI
import AppKit

struct ContentView: View {
    @EnvironmentObject var store: AgentStore
    @AppStorage("shepherd.sidebarWidth") private var sidebarWidth: Double = 240
    @State private var resizeStart: Double?
    @State private var showSwitcher = false

    private let minSidebar: Double = 180
    private let maxSidebar: Double = 440

    var body: some View {
        HStack(spacing: 0) {
            SidebarView(showSwitcher: $showSwitcher)
                .frame(width: sidebarWidth)

            divider

            // Every workspace's surfaces stay mounted (background agents keep
            // running); only the current workspace's selected tab is visible.
            ZStack {
                Theme.ground
                ForEach(store.workspaces) { ws in
                    ForEach(ws.tabs) { tab in
                        let visible = ws.id == store.selectedWorkspaceID && tab.tabID == ws.selectedTabID
                        SplitContainer(node: tab.root,
                                       tabID: tab.tabID,
                                       isTabSelected: visible,
                                       focusTick: store.focusTick,
                                       zoomedPaneID: tab.zoomedPaneID)
                            .opacity(visible ? 1 : 0)
                            .allowsHitTesting(visible)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .animation(.easeInOut(duration: 0.22), value: store.selectedWorkspaceID)  // cross-fade on switch
            .background(GeometryReader { geo in
                Color.clear
                    .onAppear { store.lastContentSize = geo.size }
                    .onChange(of: geo.size) { store.lastContentSize = $0 }
            })
        }
        .background(Theme.ground)
        .ignoresSafeArea()
        // Custom (non-native) workspace dropdown: a window-spanning backdrop to
        // dismiss on an outside click, plus the Theme panel anchored under the
        // sidebar header.
        .overlay(alignment: .topLeading) {
            ZStack(alignment: .topLeading) {
                if showSwitcher {
                    Color.black.opacity(0.001)
                        .ignoresSafeArea()
                        .onTapGesture { showSwitcher = false }
                    WorkspaceSwitcher(isPresented: $showSwitcher)
                        .environmentObject(store)
                        .frame(width: CGFloat(max(160, sidebarWidth - 16)))
                        .padding(.leading, 12)
                        .padding(.top, 52)
                        .transition(.opacity)
                }
            }
            .animation(.easeOut(duration: 0.12), value: showSwitcher)
        }
        // Centered naming modal for a new workspace (+ button / ⌘⇧N).
        .overlay {
            if store.promptingNewWorkspace {
                NewWorkspaceModal(isPresented: $store.promptingNewWorkspace)
                    .environmentObject(store)
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.12), value: store.promptingNewWorkspace)
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
