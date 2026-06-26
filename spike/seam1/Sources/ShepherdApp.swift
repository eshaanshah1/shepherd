import SwiftUI

@main
struct ShepherdApp: App {
    init() {
        _ = GhosttyApp.shared      // init libghostty
        _ = AgentStore.shared      // start the socket + open the first tab
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(AgentStore.shared)
                .frame(minWidth: 900, minHeight: 560)
        }
        .commands {
            CommandGroup(after: .newItem) {
                Button("New Tab") { AgentStore.shared.newTab() }
                    .keyboardShortcut("t", modifiers: .command)
            }
        }
    }
}
