import SwiftUI

@main
struct ShepherdApp: App {
    @StateObject private var agents = AgentStore()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(agents)
                .frame(minWidth: 900, minHeight: 600)
                .task { await agents.listen() }   // unix socket listener (see AgentStore)
        }
    }
}
