import SwiftUI
import AppKit

/// The unified Settings window (⌘,). A themed TabView surfacing appearance, workspaces,
/// remote sharing, keybindings, and general behavior.
struct SettingsView: View {
    @EnvironmentObject var store: AgentStore

    var body: some View {
        TabView {
            AppearanceSettings()
                .tabItem { Label("Appearance", systemImage: "paintbrush") }
            WorkspaceSettings()
                .tabItem { Label("Workspaces", systemImage: "square.stack") }
            RemoteSettings()
                .tabItem { Label("Remote", systemImage: "antenna.radiowaves.left.and.right") }
            KeybindingSettings()
                .tabItem { Label("Keybindings", systemImage: "keyboard") }
            GeneralSettings()
                .tabItem { Label("General", systemImage: "gearshape") }
        }
        .frame(width: 640, height: 460)
    }
}

/// Shared chrome for a settings tab: a titled, padded, scrollable column.
struct SettingsPane<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text(title).font(.ui(15, .semibold)).foregroundStyle(Theme.textPrimary)
                content
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(24)
        }
    }
}

// MARK: - Appearance

struct AppearanceSettings: View {
    @State private var theme: ThemeMode = .dark
    @State private var fontFamily: String = ""
    @State private var fontSize: Double = 13
    @State private var errorText: String?

    private var configPath: String {
        (NSHomeDirectory() as NSString).appendingPathComponent(".config/shepherd/config")
    }

    var body: some View {
        SettingsPane(title: "Appearance") {
            Picker("Theme", selection: $theme) {
                Text("Dark").tag(ThemeMode.dark)
                Text("Light").tag(ThemeMode.light)
                Text("Warm").tag(ThemeMode.warm)
            }
            .pickerStyle(.segmented)
            .onChange(of: theme) { new in
                writeEdits([ConfigEdit(key: "theme", kind: .shepherd, value: value(for: new))])
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Terminal font").font(.ui(12, .medium)).foregroundStyle(Theme.textDim)
                HStack {
                    TextField("Font family (e.g. JetBrains Mono)", text: $fontFamily)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit {
                            writeEdits([ConfigEdit(key: "font-family", kind: .native,
                                                   value: fontFamily.trimmingCharacters(in: .whitespaces))])
                        }
                    Stepper(value: $fontSize, in: 8...32, step: 1) {
                        Text("Size \(Int(fontSize))").font(.ui(12)).foregroundStyle(Theme.textPrimary)
                    }
                    .onChange(of: fontSize) { new in
                        writeEdits([ConfigEdit(key: "font-size", kind: .native, value: String(Int(new)))])
                    }
                }
                Text("Applies live. Chrome font updates on next relaunch.")
                    .font(.ui(11)).foregroundStyle(Theme.textDim)
            }

            if let e = errorText {
                Text(e).font(.ui(11)).foregroundStyle(Theme.error)
            }
        }
        .onAppear(perform: load)
    }

    private func value(for m: ThemeMode) -> String {
        switch m { case .dark: return "dark"; case .light: return "light"; case .warm: return "warm" }
    }

    private func load() {
        let contents = (try? String(contentsOfFile: configPath, encoding: .utf8)) ?? ""
        theme = parseShepherdConfig(contents).theme
        fontFamily = Theme.monoFontName ?? ""
        fontSize = Double(nativeInt(contents, key: "font-size") ?? 13)
    }

    private func nativeInt(_ contents: String, key: String) -> Int? {
        for raw in contents.split(whereSeparator: \.isNewline) {
            let t = raw.trimmingCharacters(in: .whitespaces)
            guard !t.hasPrefix("#"), let eq = t.firstIndex(of: "=") else { continue }
            if t[..<eq].trimmingCharacters(in: .whitespaces) == key {
                return Int(t[t.index(after: eq)...].trimmingCharacters(in: .whitespaces))
            }
        }
        return nil
    }

    private func writeEdits(_ edits: [ConfigEdit]) {
        do {
            try ShepherdConfigWriter.set(edits)
            GhosttyApp.shared.reloadConfig()
            errorText = nil
        } catch {
            errorText = "Couldn't write config: \(error.localizedDescription)"
        }
    }
}

// MARK: - Workspaces

struct WorkspaceSettings: View {
    @EnvironmentObject var store: AgentStore
    @State private var selectedID: String = ""
    @State private var dirText: String = ""
    @State private var hookText: String = ""

    private var current: Workspace? { store.workspaces.first { $0.id == selectedID } }

    var body: some View {
        SettingsPane(title: "Workspaces") {
            Picker("Workspace", selection: $selectedID) {
                ForEach(Array(store.workspaces.enumerated()), id: \.element.id) { idx, ws in
                    Text(ws.displayName(index: idx)).tag(ws.id)
                }
            }
            .onChange(of: selectedID) { _ in loadFields() }

            VStack(alignment: .leading, spacing: 6) {
                Text("Default directory").font(.ui(12, .medium)).foregroundStyle(Theme.textDim)
                TextField("~/path/to/repo", text: $dirText)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { store.setWorkspaceDirectory(selectedID, to: dirText) }
                Text("New tabs and worktrees in this workspace open here.")
                    .font(.ui(11)).foregroundStyle(Theme.textDim)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Worktree hook").font(.ui(12, .medium)).foregroundStyle(Theme.textDim)
                Text("Bash run right after a worktree is created (cwd = the new worktree). Available: $WORKTREE_DIR, $WORKTREE_SRC, $WORKTREE_BRANCH, $WORKTREE_NAME, $REPO_NAME.")
                    .font(.ui(11)).foregroundStyle(Theme.textDim)
                TextEditor(text: $hookText)
                    .font(.mono(12))
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 140)
                    .padding(6)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Theme.raised))
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.hairline, lineWidth: 1))
                    .onChange(of: hookText) { new in store.setWorktreeHook(selectedID, to: new) }
                Text("A non-zero exit warns but keeps the worktree.")
                    .font(.ui(11)).foregroundStyle(Theme.textDim)
            }
        }
        .onAppear {
            selectedID = store.selectedWorkspaceID ?? store.workspaces.first?.id ?? ""
            loadFields()
        }
    }

    private func loadFields() {
        dirText = current?.defaultPath ?? ""
        hookText = current?.worktreeHook ?? ""
    }
}

// MARK: - Remote

struct RemoteSettings: View {
    @EnvironmentObject var store: AgentStore
    @State private var serving: Bool = false

    var body: some View {
        SettingsPane(title: "Remote") {
            Toggle("Serve to remote devices", isOn: $serving)
                .onChange(of: serving) { on in store.setServing(on) }
            Text("When on, paired devices can view and drive this Mac's sessions.")
                .font(.ui(11)).foregroundStyle(Theme.textDim)

            Button("Add remote device…") { store.showingRemoteDevices = true }

            Text("Pairing codes and the device list appear in the pairing sheet.")
                .font(.ui(11)).foregroundStyle(Theme.textDim)
        }
        .onAppear { serving = store.isServing }
    }
}

// MARK: - Keybindings

struct KeybindingSettings: View {
    var body: some View {
        SettingsPane(title: "Keybindings") {
            Text("Rebinding coming soon. These are the current defaults.")
                .font(.ui(11)).foregroundStyle(Theme.textDim)

            ForEach(ShortcutCategory.allCases, id: \.self) { category in
                let cmds = ShortcutCatalog.all.filter { $0.category == category }
                if !cmds.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(category.rawValue).font(.ui(12, .semibold)).foregroundStyle(Theme.textPrimary)
                        ForEach(cmds) { cmd in
                            HStack {
                                Text(cmd.title).font(.ui(12)).foregroundStyle(Theme.textPrimary)
                                Spacer()
                                Text(cmd.display).font(.mono(12)).foregroundStyle(Theme.textDim)
                            }
                        }
                    }
                }
            }
        }
    }
}

// MARK: - General

struct GeneralSettings: View {
    @ObservedObject private var sleep = SleepGuard.shared
    @State private var worktreeBase: String = ""
    @State private var panesCollapsed: Bool = UserDefaults.standard.bool(forKey: "shepherd.panes.defaultCollapsed")

    private var configPath: String {
        (NSHomeDirectory() as NSString).appendingPathComponent(".config/shepherd/config")
    }

    var body: some View {
        SettingsPane(title: "General") {
            VStack(alignment: .leading, spacing: 6) {
                Text("Stay awake").font(.ui(12, .medium)).foregroundStyle(Theme.textDim)
                Picker("Mode", selection: Binding(get: { sleep.mode }, set: { sleep.mode = $0 })) {
                    Text("Off").tag(CaffeinateMode.off)
                    Text("While agents working").tag(CaffeinateMode.whileAgents)
                    Text("Always (app open)").tag(CaffeinateMode.always)
                }
                .pickerStyle(.inline)
                Toggle("Sleep if running hot under a closed lid",
                       isOn: Binding(get: { sleep.thermalAutoSleep }, set: { sleep.thermalAutoSleep = $0 }))
            }

            Toggle("New split panes start collapsed in the sidebar", isOn: $panesCollapsed)
                .onChange(of: panesCollapsed) { on in
                    UserDefaults.standard.set(on, forKey: "shepherd.panes.defaultCollapsed")
                }

            VStack(alignment: .leading, spacing: 6) {
                Text("Worktree base directory").font(.ui(12, .medium)).foregroundStyle(Theme.textDim)
                TextField("~/.shepherd/worktrees", text: $worktreeBase)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit {
                        let v = worktreeBase.trimmingCharacters(in: .whitespaces)
                        if !v.isEmpty {
                            try? ShepherdConfigWriter.set([ConfigEdit(key: "worktree-base", kind: .shepherd, value: v)])
                        }
                    }
                Text("Where new git worktrees are created.")
                    .font(.ui(11)).foregroundStyle(Theme.textDim)
            }

            Button("Open config file") {
                NSWorkspace.shared.open(URL(fileURLWithPath: configPath))
            }
        }
        .onAppear {
            let contents = (try? String(contentsOfFile: configPath, encoding: .utf8)) ?? ""
            worktreeBase = parseShepherdConfig(contents).worktreeBase ?? ""
        }
    }
}
