import SwiftUI
import AppKit

/// Settings → Claude. One account per config dir: pick it, see whether it is signed in,
/// and install the plugin *into that dir* (without which its panes report no state at all).
struct ClaudeSettings: View {
    @EnvironmentObject var store: AgentStore
    @State private var selectedID: String = ClaudeProfiles.defaultID
    @State private var nameText: String = ""
    @State private var dirText: String = ""
    @State private var email: String?
    @State private var pluginState: PluginInstallState = .unavailable
    @State private var pluginJustInstalled = false
    @State private var error: String?

    private var current: ClaudeProfile { store.claudeProfile(id: selectedID) }
    private var options: [(label: String, value: String)] {
        store.allClaudeProfiles.map { (label: $0.name, value: $0.id) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            SettingsField(label: "Profile",
                          footnote: "Each profile is a separate CLAUDE_CONFIG_DIR — its own login, sessions, MCP servers and skills. Set one per workspace (Settings → Workspaces) or per tab in ⌘T.") {
                HStack(spacing: 10) {
                    SettingsDropdown(options: options, selection: $selectedID)
                        .onChange(of: selectedID) { _ in load() }
                    SettingsButton(title: "Add…", systemImage: "plus") { addProfile() }
                    if !current.isDefault {
                        SettingsButton(title: "Remove") { removeProfile() }
                    }
                }
            }

            if current.isDefault {
                SettingsField(label: "Config directory",
                              footnote: "Claude Code's own default. Shepherd injects no CLAUDE_CONFIG_DIR for this profile — setting it explicitly, even to the same path, would point Claude Code at a different Keychain item and read as signed out.") {
                    Text("~/.claude").font(.mono(12.5)).foregroundStyle(Theme.textSecondary)
                }
            } else {
                SettingsField(label: "Name") {
                    SettingsTextField(placeholder: "Personal", text: $nameText) {
                        store.updateClaudeProfile(selectedID, name: nameText)
                    }
                }
                SettingsField(label: "Config directory",
                              footnote: "Injected as CLAUDE_CONFIG_DIR into every pane on this profile.") {
                    HStack(spacing: 10) {
                        SettingsTextField(placeholder: "~/.claude-personal", text: $dirText, mono: true) {
                            commitDir()
                        }
                        SettingsButton(title: "Choose…", systemImage: "folder") {
                            chooseConfigDir(start: dirText) { dirText = $0; commitDir() }
                        }
                    }
                    if let e = ClaudeProfiles.validate(configDir: dirText) {
                        Text(e).font(.ui(11)).foregroundStyle(Theme.error)
                    } else {
                        PathHint(path: dirText)
                    }
                }
            }

            SettingsField(label: "Account",
                          footnote: "Keychain item: \(ClaudeProfiles.keychainService(for: current))") {
                if let email {
                    HStack(spacing: 7) {
                        Circle().fill(Theme.needsCheck).frame(width: 6, height: 6)
                        Text("Signed in as \(email)").font(.ui(12)).foregroundStyle(Theme.textSecondary)
                    }
                } else {
                    HStack(spacing: 7) {
                        Circle().fill(Theme.blocked).frame(width: 6, height: 6)
                        Text("Not signed in — open a tab on this profile and run /login")
                            .font(.ui(12)).foregroundStyle(Theme.textSecondary)
                    }
                }
                SettingsButton(title: "Refresh", systemImage: "arrow.clockwise") { load() }
            }

            SettingsField(label: "Claude Code plugin",
                          footnote: "Installed per profile: hooks live in this profile's skills dir, and without them its panes stay plain shells.") {
                pluginPanel
            }
        }
        .onAppear(perform: load)
    }

    @ViewBuilder private var pluginPanel: some View {
        switch pluginState {
        case .notInstalled:
            HStack(spacing: 10) {
                SettingsButton(title: "Install plugin", systemImage: "arrow.down.circle", prominent: true) {
                    do {
                        try ClaudePluginInstaller.install(for: current)
                        error = nil
                        pluginJustInstalled = true
                    } catch {
                        self.error = error.localizedDescription
                    }
                    pluginState = ClaudePluginInstaller.currentState(for: current)
                }
                Text("Not installed").font(.ui(12)).foregroundStyle(Theme.blocked)
            }
        case .installed:
            VStack(alignment: .leading, spacing: 6) {
                Text(pluginJustInstalled
                     ? "Installed — run /reload-plugins in any Claude session on this profile."
                     : "Installed")
                    .font(.ui(12)).foregroundStyle(Theme.textSecondary)
                SettingsButton(title: "Uninstall") {
                    try? ClaudePluginInstaller.remove(for: current)
                    pluginJustInstalled = false
                    pluginState = ClaudePluginInstaller.currentState(for: current)
                }
            }
        case .linkedElsewhere(let dest):
            VStack(alignment: .leading, spacing: 4) {
                Text("Already installed from another location — left alone.")
                    .font(.ui(12)).foregroundStyle(Theme.textSecondary)
                PathHint(path: dest)
            }
        case .occupied:
            Text("Something that isn't a link already sits at this profile's skills/shepherd, so it wasn't touched.")
                .font(.ui(12)).foregroundStyle(Theme.textSecondary)
        case .unavailable:
            Text("This build doesn't ship the plugin — install it from a source checkout.")
                .font(.ui(12)).foregroundStyle(Theme.textSecondary)
        }
        if let error {
            Text(error).font(.ui(11)).foregroundStyle(Theme.error)
        }
    }

    // MARK: wiring

    private func load() {
        let p = current
        nameText = p.name
        dirText = p.configDir ?? ""
        email = ClaudeProfiles.signedInEmail(for: p)
        pluginState = ClaudePluginInstaller.currentState(for: p)
        pluginJustInstalled = false
        error = nil
    }

    private func commitDir() {
        guard ClaudeProfiles.validate(configDir: dirText) == nil else { return }
        store.updateClaudeProfile(selectedID, configDir: dirText)
        load()
    }

    /// Adding starts from the directory, because a profile with no dir is not a profile —
    /// it is the default one wearing a different name.
    private func addProfile() {
        chooseConfigDir(start: NSHomeDirectory()) { dir in
            guard ClaudeProfiles.validate(configDir: dir) == nil else {
                error = ClaudeProfiles.validate(configDir: dir); return
            }
            let name = (dir as NSString).lastPathComponent
                .replacingOccurrences(of: ".claude-", with: "")
            let p = store.addClaudeProfile(name: name.isEmpty ? "Profile" : name, configDir: dir)
            selectedID = p.id
            load()
        }
    }

    private func removeProfile() {
        let id = selectedID
        selectedID = ClaudeProfiles.defaultID
        store.removeClaudeProfile(id)
        load()
    }

    /// Unlike the workspace pickers this one must allow a directory that doesn't exist
    /// yet — a brand-new account has no config dir until Claude Code first runs.
    private func chooseConfigDir(start: String, _ completion: @escaping (String) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose"
        panel.directoryURL = URL(fileURLWithPath: (start as NSString).expandingTildeInPath)
        if panel.runModal() == .OK, let url = panel.url { completion(url.path) }
    }
}
