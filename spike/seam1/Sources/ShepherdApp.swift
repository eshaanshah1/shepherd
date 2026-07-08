import SwiftUI
import AppKit

@main
struct ShepherdApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var sleep = SleepGuard.shared

    init() {
        Self.scrubInheritedAgentEnv()   // before any pane spawns a shell
        Fonts.registerBundled()    // load bundled DM Sans before any view renders
        _ = GhosttyApp.shared      // init libghostty
        _ = AgentStore.shared      // start the socket + restore/open tabs
        _ = SleepGuard.shared      // load persisted caffeinate mode
    }

    // Launched from a Claude session, Shepherd inherits CLAUDECODE/CLAUDE_CODE_*; left set,
    // `claude` in a pane runs as a nested child and writes no resumable session transcript.
    private static func scrubInheritedAgentEnv() {
        for key in ProcessInfo.processInfo.environment.keys
        where key == "CLAUDECODE" || key == "CLAUDE_EFFORT"
            || key == "AI_AGENT" || key == "TRACEPARENT"
            || key.hasPrefix("CLAUDE_CODE_") {
            unsetenv(key)
        }
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(AgentStore.shared)
                .frame(minWidth: 900, minHeight: 560)
                .preferredColorScheme(.dark)
        }
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(after: .newItem) {
                Button("New Tab") { AgentStore.shared.newTab() }
                    .keyboardShortcut("t", modifiers: .command)
                Button("New Workspace") { AgentStore.shared.promptingNewWorkspace = true }
                    .keyboardShortcut("n", modifiers: [.command, .shift])
                Button("Next Workspace") { AgentStore.shared.nextWorkspace() }
                    .keyboardShortcut(.tab, modifiers: .control)
                Button("Previous Workspace") { AgentStore.shared.prevWorkspace() }
                    .keyboardShortcut(.tab, modifiers: [.control, .shift])
                Button("Close Pane") {
                    let s = AgentStore.shared
                    if s.selectedTabIsSplit { s.closeFocusedPane() }
                    else { s.closeSelected() }   // last tab reseeds; window close is the traffic light / ⌘Q
                }
                .keyboardShortcut("w", modifiers: .command)
                Divider()
                Button("Split Right") { AgentStore.shared.splitFocused(.row) }
                    .keyboardShortcut("d", modifiers: .command)
                Button("Split Down") { AgentStore.shared.splitFocused(.column) }
                    .keyboardShortcut("d", modifiers: [.command, .shift])
                Button("Zoom Pane") { AgentStore.shared.toggleZoom() }
                    .keyboardShortcut(.return, modifiers: [.command, .shift])
                Button("Focus Left")  { AgentStore.shared.focusNeighbor(.left) }
                    .keyboardShortcut(.leftArrow, modifiers: [.command, .option])
                Button("Focus Right") { AgentStore.shared.focusNeighbor(.right) }
                    .keyboardShortcut(.rightArrow, modifiers: [.command, .option])
                Button("Focus Up")    { AgentStore.shared.focusNeighbor(.up) }
                    .keyboardShortcut(.upArrow, modifiers: [.command, .option])
                Button("Focus Down")  { AgentStore.shared.focusNeighbor(.down) }
                    .keyboardShortcut(.downArrow, modifiers: [.command, .option])
                Divider()
                Button("Select Next Tab") { AgentStore.shared.selectNext() }
                    .keyboardShortcut("]", modifiers: [.command, .shift])
                Button("Select Previous Tab") { AgentStore.shared.selectPrevious() }
                    .keyboardShortcut("[", modifiers: [.command, .shift])
                Divider()
                Button("Find") { AgentStore.shared.openSearch() }
                    .keyboardShortcut("f", modifiers: .command)
                Button("Review Diff") { AgentStore.shared.toggleDiffPanel() }
                    .keyboardShortcut("g", modifiers: .command)
                Divider()
                Button("Jump to Next Alert") { AgentStore.shared.selectNextAttention() }
                    .keyboardShortcut("a", modifiers: [.command, .shift])
                #if DEBUG
                Divider()
                Button("DEBUG: Simulate Thermal Serious") { SleepGuard.shared.simulateThermal(.serious) }
                Button("DEBUG: Simulate Thermal Nominal") { SleepGuard.shared.simulateThermal(.nominal) }
                #endif
            }
            // ⌘1–9 jump to tab N.
            CommandGroup(after: .windowList) {
                ForEach(1...9, id: \.self) { n in
                    Button("Tab \(n)") { AgentStore.shared.selectIndex(n) }
                        .keyboardShortcut(KeyEquivalent(Character("\(n)")), modifiers: .command)
                }
            }
            CommandMenu("Stay Awake") {
                Picker("Mode", selection: Binding(
                    get: { sleep.mode },
                    set: { sleep.mode = $0 })) {
                    Text("Off").tag(CaffeinateMode.off)
                    Text("While Agents Working").tag(CaffeinateMode.whileAgents)
                    Text("Always (App Open)").tag(CaffeinateMode.always)
                }
                .pickerStyle(.inline)
                Divider()
                Toggle("Sleep If Running Hot Under Closed Lid", isOn: Binding(
                    get: { sleep.thermalAutoSleep },
                    set: { sleep.thermalAutoSleep = $0 }))
                Divider()
                Text(sleep.tier2Available
                     ? "Clamshell survival: on"
                     : "Clamshell survival: unavailable (idle-sleep guard)")
            }
        }
    }
}
