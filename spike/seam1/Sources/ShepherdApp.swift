import SwiftUI
import AppKit

@main
struct ShepherdApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var sleep = SleepGuard.shared
    @StateObject private var updater = UpdateController.shared

    init() {
        Self.scrubInheritedAgentEnv()   // before any pane spawns a shell
        Fonts.registerBundled()    // load bundled DM Sans before any view renders
        _ = GhosttyApp.shared      // init libghostty
        _ = AgentStore.shared      // start the socket + restore/open tabs
        _ = SleepGuard.shared      // load persisted caffeinate mode
        Task { @MainActor in UpdateController.shared.startIfEligible() }
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
                .environmentObject(updater)
                .frame(minWidth: 900, minHeight: 560)
                .preferredColorScheme(.dark)
        }
        .windowStyle(.hiddenTitleBar)
        .commands {
            // Menu items are generated from ShortcutCatalog (single source of truth
            // shared with the ⌘/ cheatsheet) — one Button per catalog command, grouped
            // by category with dividers. ⌘/ itself lives under Help (below).
            CommandGroup(after: .newItem) {
                ForEach(ShortcutCategory.allCases, id: \.self) { category in
                    let cmds = ShortcutCatalog.menuCommands.filter {
                        $0.category == category && $0.id != .showShortcuts
                    }
                    if !cmds.isEmpty {
                        Divider()
                        ForEach(cmds) { cmd in
                            Button(cmd.title) { ShortcutActions.run(cmd.id) }
                                .keyboardShortcut(cmd.key!, modifiers: cmd.modifiers)
                        }
                    }
                }
                #if DEBUG
                Divider()
                Button("DEBUG: Simulate Thermal Serious") { SleepGuard.shared.simulateThermal(.serious) }
                Button("DEBUG: Simulate Thermal Nominal") { SleepGuard.shared.simulateThermal(.nominal) }
                #endif
            }
            CommandGroup(replacing: .help) {
                Button("Keyboard Shortcuts") { ShortcutActions.run(.showShortcuts) }
                    .keyboardShortcut("/", modifiers: .command)
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

        Settings {
            SettingsView()
                .environmentObject(AgentStore.shared)
                .environmentObject(updater)
                .preferredColorScheme(Theme.mode == .dark ? .dark : .light)
        }
    }
}

/// Resolves a `ShortcutID` to its live action. Exhaustive over the enum, so adding
/// a catalog command without wiring it up is a compile error — the anti-drift half
/// of keeping the menu and the ⌘/ cheatsheet in a single source.
enum ShortcutActions {
    @MainActor
    static func run(_ id: ShortcutID) {
        let s = AgentStore.shared
        switch id {
        case .newTab:        s.newTab()
        case .newEphemeral:  s.spawnEphemeral()
        case .closePane:
            if let id = s.expandedEphemeralID { s.closeEphemeral(id) }
            else if s.selectedTabIsSplit { s.closeFocusedPane() }
            else { s.closeSelected() }
        case .splitRight:    s.splitFocused(.row)
        case .splitDown:     s.splitFocused(.column)
        case .zoomPane:      s.toggleZoom()
        case .focusLeft:     s.focusNeighbor(.left)
        case .focusRight:    s.focusNeighbor(.right)
        case .focusUp:       s.focusNeighbor(.up)
        case .focusDown:     s.focusNeighbor(.down)
        case .prevTab:       s.selectPrevious()
        case .nextTab:       s.selectNext()
        case .jumpTab:       break   // ⌘1–9 is the windowList ForEach; display-only here
        case .newWorkspace:  s.promptingNewWorkspace = true
        case .nextWorkspace: s.nextWorkspace()
        case .prevWorkspace: s.prevWorkspace()
        case .find:          s.openSearch()
        case .reviewDiff:    s.toggleDiffPanel()
        case .openEditor:    s.openEditor()
        case .saveFile:      NotificationCenter.default.post(name: .shepherdSaveCodeSurface, object: nil)
        case .nextAlert:     s.selectNextAttention()
        case .reloadConfig:  GhosttyApp.shared.reloadConfig()
        case .showShortcuts: s.showShortcuts.toggle()
        }
    }
}
