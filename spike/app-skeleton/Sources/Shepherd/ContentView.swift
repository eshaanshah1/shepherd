import SwiftUI

struct ContentView: View {
    @EnvironmentObject var agents: AgentStore

    var body: some View {
        HSplitView {
            SidebarView()
                .frame(minWidth: 220, idealWidth: 260, maxWidth: 320)
            TerminalArea()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

/// Placeholder for the tabbed terminal area. In v1 each tab hosts one
/// GhosttySurfaceView (a libghostty Metal surface).
private struct TerminalArea: View {
    var body: some View {
        ZStack {
            Color.black
            GhosttySurfaceView()   // stub until GhosttyKit lands — see SEAM1.md
        }
    }
}
