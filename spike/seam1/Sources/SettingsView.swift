import SwiftUI
import AppKit

/// The unified Settings window (⌘,). A fully themed, left-nav-rail preferences
/// window — no native TabView chrome. Sections live in the rail; the detail pane
/// renders the selected one over Shepherd's ground.
struct SettingsView: View {
    @EnvironmentObject var store: AgentStore
    @State private var section: SettingsSection = .appearance

    var body: some View {
        // Subscribe to live theme reloads (⌘⇧R) so the chrome recolors in place.
        let _ = store.themeVersion

        HStack(spacing: 0) {
            SettingsRail(selection: $section)
            Rectangle().fill(Theme.hairline).frame(width: 1)
            detail
        }
        .frame(width: 740, height: 540)
        .background(Theme.ground)
        .background(SettingsWindowChrome())
    }

    @ViewBuilder private var detail: some View {
        SettingsScrollPane(title: section.title) {
            switch section {
            case .appearance:  AppearanceSettings()
            case .workspaces:  WorkspaceSettings()
            case .remote:      RemoteSettings()
            case .keybindings: KeybindingSettings()
            case .general:     GeneralSettings()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Theme.ground)
    }
}

// MARK: - Sections

enum SettingsSection: String, CaseIterable, Identifiable {
    case appearance, workspaces, remote, keybindings, general
    var id: String { rawValue }
    var title: String {
        switch self {
        case .appearance:  return "Appearance"
        case .workspaces:  return "Workspaces"
        case .remote:      return "Remote"
        case .keybindings: return "Keybindings"
        case .general:     return "General"
        }
    }
    var icon: String {
        switch self {
        case .appearance:  return "paintbrush"
        case .workspaces:  return "square.stack"
        case .remote:      return "antenna.radiowaves.left.and.right"
        case .keybindings: return "keyboard"
        case .general:     return "gearshape"
        }
    }
}

// MARK: - Rail

private struct SettingsRail: View {
    @Binding var selection: SettingsSection

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            // Clear the traffic lights.
            Color.clear.frame(height: 30)
            Text("SHEPHERD")
                .font(.ui(10, .semibold)).tracking(1.2)
                .foregroundStyle(Theme.textDim)
                .padding(.horizontal, 14).padding(.bottom, 10)
            ForEach(SettingsSection.allCases) { s in
                RailRow(section: s, active: s == selection) { selection = s }
            }
            Spacer()
        }
        .frame(width: 184)
        .frame(maxHeight: .infinity, alignment: .top)
        .padding(.horizontal, 8)
        .background(Theme.surface1)
    }
}

private struct RailRow: View {
    let section: SettingsSection
    let active: Bool
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: section.icon)
                    .font(.system(size: 13, weight: .medium))
                    .frame(width: 18)
                    .foregroundStyle(active ? Theme.accent : Theme.textSecondary)
                Text(section.title)
                    .font(.ui(13, active ? .semibold : .medium))
                    .foregroundStyle(active ? Theme.textPrimary : Theme.textSecondary)
                Spacer(minLength: 0)
            }
            .padding(.vertical, 7).padding(.horizontal, 10)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(active ? Theme.accentWash(0.14) : (hover ? Theme.surface3 : .clear))
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}

/// Titled, scrollable detail column shared by every section.
struct SettingsScrollPane<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                Text(title).font(.ui(20, .semibold)).foregroundStyle(Theme.textPrimary)
                content
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 30)
            .padding(.top, 38)
            .padding(.bottom, 26)
        }
    }
}

// MARK: - Themed dropdown (arbitrary option count)

struct SettingsDropdown<T: Hashable>: View {
    let options: [(label: String, value: T)]
    @Binding var selection: T

    var body: some View {
        Menu {
            ForEach(options.indices, id: \.self) { i in
                Button(options[i].label) { selection = options[i].value }
            }
        } label: {
            HStack(spacing: 8) {
                Text(currentLabel).font(.ui(13)).foregroundStyle(Theme.textPrimary)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.textDim)
            }
            .padding(.vertical, 6).padding(.horizontal, 10)
            .background(RoundedRectangle(cornerRadius: 7).fill(Theme.surface2))
            .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Theme.hairline, lineWidth: 1))
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
    }

    private var currentLabel: String { options.first { $0.value == selection }?.label ?? "—" }
}

// MARK: - Folder picker

private func chooseFolder(start: String?, _ completion: @escaping (String) -> Void) {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.prompt = "Choose"
    if let s = start, !s.isEmpty {
        panel.directoryURL = URL(fileURLWithPath: (s as NSString).expandingTildeInPath)
    }
    if panel.runModal() == .OK, let url = panel.url { completion(url.path) }
}

// MARK: - Appearance

struct AppearanceSettings: View {
    @State private var theme: ThemeMode = .dark
    @State private var fontFamily: String = ""
    @State private var fontSize: Int = 13
    @State private var errorText: String?

    private var configPath: String {
        (NSHomeDirectory() as NSString).appendingPathComponent(".config/shepherd/config")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            SettingsField(label: "Theme") {
                SettingsSegmented(options: [("Dark", ThemeMode.dark),
                                            ("Light", ThemeMode.light),
                                            ("Warm", ThemeMode.warm)],
                                  selection: $theme)
                .onChange(of: theme) { new in
                    writeEdits([ConfigEdit(key: "theme", kind: .shepherd, value: value(for: new))])
                }
            }

            SettingsField(label: "Terminal font",
                          footnote: "Applies live. Chrome font updates on next relaunch.") {
                HStack(spacing: 10) {
                    SettingsTextField(placeholder: "JetBrains Mono", text: $fontFamily, mono: true) {
                        writeEdits([ConfigEdit(key: "font-family", kind: .native,
                                               value: fontFamily.trimmingCharacters(in: .whitespaces))])
                    }
                    SettingsStepper(value: $fontSize, range: 8...32) { new in
                        writeEdits([ConfigEdit(key: "font-size", kind: .native, value: String(new))])
                    }
                }
                FontPreview(family: fontFamily, size: fontSize)
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
        fontSize = nativeInt(contents, key: "font-size") ?? 13
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

/// A live sample line in the chosen terminal font + size.
private struct FontPreview: View {
    let family: String
    let size: Int

    private var resolved: Font {
        let name = family.trimmingCharacters(in: .whitespaces)
        if !name.isEmpty, NSFont(name: name, size: CGFloat(size)) != nil {
            return .custom(name, size: CGFloat(size))
        }
        return .system(size: CGFloat(size), design: .monospaced)
    }

    var body: some View {
        Text("The quick brown fox jumps — 0123456789 {}[]()=>;")
            .font(resolved).foregroundStyle(Theme.textPrimary)
            .lineLimit(1).truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 10).padding(.horizontal, 12)
            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.surface2))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.hairline, lineWidth: 1))
    }
}

// MARK: - Workspaces

struct WorkspaceSettings: View {
    @EnvironmentObject var store: AgentStore
    @State private var selectedID: String = ""
    @State private var dirText: String = ""
    @State private var hookText: String = ""
    @State private var hookTesting = false
    @State private var hookResult: WorktreeHookRunner.HookResult?

    private var current: Workspace? { store.workspaces.first { $0.id == selectedID } }
    private var workspaceOptions: [(label: String, value: String)] {
        store.workspaces.enumerated().map { (label: $0.element.displayName(index: $0.offset), value: $0.element.id) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            SettingsField(label: "Workspace") {
                SettingsDropdown(options: workspaceOptions, selection: $selectedID)
                    .onChange(of: selectedID) { _ in loadFields() }
            }

            SettingsField(label: "Default directory",
                          footnote: "New tabs and worktrees in this workspace open here.") {
                HStack(spacing: 10) {
                    SettingsTextField(placeholder: "~/path/to/repo", text: $dirText, mono: true) {
                        store.setWorkspaceDirectory(selectedID, to: dirText)
                    }
                    SettingsButton(title: "Choose…", systemImage: "folder") {
                        chooseFolder(start: dirText) {
                            dirText = $0
                            store.setWorkspaceDirectory(selectedID, to: $0)
                        }
                    }
                }
                PathHint(path: dirText)
            }

            SettingsField(label: "Worktree hook",
                          footnote: "Bash run right after a worktree is created (cwd = the new worktree). Available: $WORKTREE_DIR, $WORKTREE_SRC, $WORKTREE_BRANCH, $WORKTREE_NAME, $REPO_NAME. A non-zero exit warns but keeps the worktree.") {
                CodeFieldView(text: $hookText)
                    .id(selectedID)
                    .frame(minHeight: 150)
                    .padding(8)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Theme.surface2))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.hairline, lineWidth: 1))
                    .onChange(of: hookText) { new in store.setWorktreeHook(selectedID, to: new) }

                HStack(spacing: 10) {
                    SettingsButton(title: hookTesting ? "Running…" : "Test run",
                                   systemImage: "play") { runHook() }
                    if hookTesting {
                        ProgressView().controlSize(.small).scaleEffect(0.7)
                    }
                }
                if let r = hookResult { HookResultView(result: r) }
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
        hookResult = nil
    }

    /// Run the hook against a throwaway temp dir so the user can sanity-check it
    /// without creating a worktree. Placeholder WORKTREE_* env points at the scratch dir.
    private func runHook() {
        let script = hookText
        guard !script.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        hookTesting = true
        hookResult = nil
        Task {
            let result = await Task.detached { () -> WorktreeHookRunner.HookResult in
                let dir = URL(fileURLWithPath: NSTemporaryDirectory())
                    .appendingPathComponent("shepherd-hook-test-\(UUID().uuidString)")
                try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                let env = WorktreeHookRunner.hookEnvironment(
                    worktreeDir: dir.path, src: dir.path, branch: "test-branch",
                    name: "test", repoName: "test-repo")
                let r = WorktreeHookRunner.run(script: script, cwd: dir.path, env: env)
                try? FileManager.default.removeItem(at: dir)
                return r
            }.value
            hookResult = result
            hookTesting = false
        }
    }
}

/// Exit-code chip + captured output from a test hook run.
private struct HookResultView: View {
    let result: WorktreeHookRunner.HookResult
    private var ok: Bool { result.exitCode == 0 }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Circle().fill(ok ? Theme.needsCheck : Theme.error).frame(width: 7, height: 7)
                Text(ok ? "Exited 0" : "Exited \(result.exitCode)")
                    .font(.ui(11, .semibold)).foregroundStyle(ok ? Theme.needsCheck : Theme.error)
            }
            if !result.output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                ScrollView {
                    Text(result.output)
                        .font(.mono(11)).foregroundStyle(Theme.textSecondary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 120)
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 7).fill(Theme.ground))
                .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Theme.hairline, lineWidth: 1))
            }
        }
    }
}

// MARK: - Remote

struct RemoteSettings: View {
    @EnvironmentObject var store: AgentStore
    @State private var serving: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            SettingsField(label: "Sharing",
                          footnote: "When on, paired devices can view and drive this Mac's sessions.") {
                SettingsToggle(label: "Serve to remote devices", isOn: $serving)
                    .onChange(of: serving) { on in store.setServing(on) }
            }

            SettingsField(label: "Devices",
                          footnote: "Pairing codes and the device list appear in the pairing sheet.") {
                SettingsButton(title: "Add remote device…", systemImage: "plus") {
                    store.showingRemoteDevices = true
                }
            }
        }
        .onAppear { serving = store.isServing }
    }
}

// MARK: - Keybindings

struct KeybindingSettings: View {
    @State private var query: String = ""

    private func matches(_ cmd: ShortcutCommand) -> Bool {
        guard !query.isEmpty else { return true }
        let q = query.lowercased()
        return cmd.title.lowercased().contains(q) || cmd.display.lowercased().contains(q)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            SettingsTextField(placeholder: "Search shortcuts…", text: $query)

            ForEach(ShortcutCategory.allCases, id: \.self) { category in
                let cmds = ShortcutCatalog.all.filter { $0.category == category && matches($0) }
                if !cmds.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(category.rawValue.uppercased())
                            .font(.ui(10.5, .semibold)).tracking(0.6)
                            .foregroundStyle(Theme.textDim)
                        ForEach(cmds) { cmd in
                            HStack {
                                Text(cmd.title).font(.ui(13)).foregroundStyle(Theme.textPrimary)
                                Spacer(minLength: 12)
                                KeyCap(cmd.display)
                            }
                            .padding(.vertical, 2)
                        }
                    }
                }
            }

            if ShortcutCatalog.all.allSatisfy({ !matches($0) }) {
                Text("No shortcuts match “\(query)”.")
                    .font(.ui(12)).foregroundStyle(Theme.textDim)
            }

            Text("Rebinding coming soon. These are the current defaults.")
                .font(.ui(11)).foregroundStyle(Theme.textDim).padding(.top, 4)
        }
    }
}

private struct KeyCap: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text)
            .font(.mono(12)).foregroundStyle(Theme.textSecondary)
            .padding(.vertical, 3).padding(.horizontal, 8)
            .background(RoundedRectangle(cornerRadius: 6).fill(Theme.surface2))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.hairline, lineWidth: 1))
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
        VStack(alignment: .leading, spacing: 22) {
            SettingsField(label: "Stay awake") {
                SettingsSegmented(options: [("Off", CaffeinateMode.off),
                                            ("While agents", CaffeinateMode.whileAgents),
                                            ("Always", CaffeinateMode.always)],
                                  selection: Binding(get: { sleep.mode }, set: { sleep.mode = $0 }))
                SettingsToggle(label: "Sleep if running hot under a closed lid",
                               isOn: Binding(get: { sleep.thermalAutoSleep }, set: { sleep.thermalAutoSleep = $0 }))
            }

            SettingsField(label: "Sidebar") {
                SettingsToggle(label: "New split panes start collapsed", isOn: $panesCollapsed)
                    .onChange(of: panesCollapsed) { on in
                        UserDefaults.standard.set(on, forKey: "shepherd.panes.defaultCollapsed")
                    }
            }

            SettingsField(label: "Worktree base directory",
                          footnote: "Where new git worktrees are created.") {
                HStack(spacing: 10) {
                    SettingsTextField(placeholder: "~/.shepherd/worktrees", text: $worktreeBase, mono: true) {
                        commitBase()
                    }
                    SettingsButton(title: "Choose…", systemImage: "folder") {
                        chooseFolder(start: worktreeBase) { worktreeBase = $0; commitBase() }
                    }
                }
                PathHint(path: worktreeBase)
            }

            SettingsField(label: "Configuration") {
                SettingsButton(title: "Open config file", systemImage: "doc.text") {
                    NSWorkspace.shared.open(URL(fileURLWithPath: configPath))
                }
            }
        }
        .onAppear {
            let contents = (try? String(contentsOfFile: configPath, encoding: .utf8)) ?? ""
            worktreeBase = parseShepherdConfig(contents).worktreeBase ?? ""
        }
    }

    private func commitBase() {
        let v = worktreeBase.trimmingCharacters(in: .whitespaces)
        if !v.isEmpty {
            try? ShepherdConfigWriter.set([ConfigEdit(key: "worktree-base", kind: .shepherd, value: v)])
        }
    }
}
