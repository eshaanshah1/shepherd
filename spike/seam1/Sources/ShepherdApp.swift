import SwiftUI

@main
struct ShepherdApp: App {
    @StateObject private var agents = AgentStore()

    init() {
        // Initialize libghostty (init + config + app) at launch, before any surface.
        _ = GhosttyApp.shared
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(agents)
                .frame(minWidth: 900, minHeight: 560)
        }
    }
}
