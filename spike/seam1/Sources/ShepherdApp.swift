import SwiftUI
import AppKit

@main
struct ShepherdApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    init() {
        _ = GhosttyApp.shared      // init libghostty
        _ = AgentStore.shared      // start the socket + restore/open tabs
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
                Button("Close Tab") {
                    let s = AgentStore.shared
                    if s.tabs.count <= 1 { NSApp.keyWindow?.performClose(nil) }
                    else { s.closeSelected() }
                }
                .keyboardShortcut("w", modifiers: .command)
                Divider()
                Button("Select Next Tab") { AgentStore.shared.selectNext() }
                    .keyboardShortcut("]", modifiers: [.command, .shift])
                Button("Select Previous Tab") { AgentStore.shared.selectPrevious() }
                    .keyboardShortcut("[", modifiers: [.command, .shift])
                Divider()
                Button("Jump to Next Alert") { AgentStore.shared.selectNextAttention() }
                    .keyboardShortcut("a", modifiers: [.command, .shift])
            }
            // ⌘1–9 jump to tab N.
            CommandGroup(after: .windowList) {
                ForEach(1...9, id: \.self) { n in
                    Button("Tab \(n)") { AgentStore.shared.selectIndex(n) }
                        .keyboardShortcut(KeyEquivalent(Character("\(n)")), modifiers: .command)
                }
            }
        }
    }
}
