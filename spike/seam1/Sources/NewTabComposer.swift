import SwiftUI
import AppKit

/// ⌘T. One card: a title, a destination, an optional worktree, and a prompt that
/// launches an agent. Prompt-first — the settings are chrome around it. Every
/// enable/disable question is `NewTabRequest`'s; this file only draws.
struct NewTabComposer: View {
    @EnvironmentObject var store: AgentStore
    @Binding var isPresented: Bool

    @State private var request: NewTabRequest?
    @State private var targets: [NewTabTarget] = []
    @State private var newlineMonitor: Any?
    @FocusState private var focus: Field?

    private enum Field: Hashable { case title, prompt, branch }

    var body: some View {
        ZStack {
            Color.black.opacity(0.35)
                .ignoresSafeArea()
                .onTapGesture { isPresented = false }

            if let r = request {
                card(r)
                    .frame(width: 560)
                    .background(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(Theme.ground)
                            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .strokeBorder(Theme.hairline, lineWidth: 1))
                    )
                    .shadow(color: .black.opacity(0.55), radius: 30, x: 0, y: 16)
            }
        }
        .onAppear(perform: seed)
        .onChange(of: focus) { f in
            if f == .prompt { installNewlineMonitor() } else { removeNewlineMonitor() }
        }
        .onDisappear(perform: removeNewlineMonitor)
    }

    // MARK: card

    private func card(_ r: NewTabRequest) -> some View {
        VStack(spacing: 0) {
            header(r)
            Rectangle().fill(Theme.hairline).frame(height: 1)
            promptArea(r)
            Rectangle().fill(Theme.hairline).frame(height: 1)
            footer(r)
        }
    }

    private func header(_ r: NewTabRequest) -> some View {
        HStack(spacing: 10) {
            TextField("Untitled tab", text: binding(\.title))
                .textFieldStyle(.plain)
                .font(.ui(15, .medium))
                .foregroundStyle(Theme.textPrimary)
                .focused($focus, equals: .title)
                .onSubmit(create)

            Spacer(minLength: 8)

            Menu {
                ForEach(targets, id: \.workspaceID) { t in
                    Button(t.name) { retarget(t) }
                }
            } label: {
                Text(r.target.name).font(.ui(12, .medium))
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .foregroundStyle(Theme.textSecondary)
        }
        .padding(.horizontal, 16)
        .frame(height: 46)
    }

    private func promptArea(_ r: NewTabRequest) -> some View {
        ZStack(alignment: .topLeading) {
            TextField("", text: binding(\.prompt), axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(6...6)
                .font(.ui(13))
                .foregroundStyle(Theme.textPrimary)
                .focused($focus, equals: .prompt)
                .disabled(!r.promptAvailable)
                .onSubmit(create)

            if r.prompt.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    Text(r.promptHint ?? "Ask Claude to do something…")
                        .foregroundStyle(Theme.textSecondary)
                    if r.promptAvailable {
                        Text("leave empty for a plain shell")
                            .foregroundStyle(Theme.textDim)
                    }
                }
                .font(.ui(13))
                .allowsHitTesting(false)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .contentShape(Rectangle())
        .onTapGesture { if r.promptAvailable { focus = .prompt } }
    }

    private func footer(_ r: NewTabRequest) -> some View {
        HStack(spacing: 10) {
            Toggle("", isOn: binding(\.worktree))
                .toggleStyle(.switch)
                .controlSize(.mini)
                .labelsHidden()
                .disabled(!r.worktreeAvailable)

            Text("Worktree")
                .font(.ui(12))
                .foregroundStyle(r.worktreeAvailable ? Theme.textSecondary : Theme.textDim)

            if let hint = r.worktreeHint {
                Text(hint).font(.ui(11)).foregroundStyle(Theme.textDim)
            } else if r.worktree {
                TextField("branch", text: Binding(get: { r.branch },
                                                  set: { request?.setBranch($0) }))
                    .textFieldStyle(.plain)
                    .font(.ui(12))
                    .foregroundStyle(Theme.textPrimary)
                    .focused($focus, equals: .branch)
                    .frame(width: 180)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(Theme.raised))
                    .onSubmit(create)
            }

            Spacer(minLength: 8)

            if let hint = r.createHint {
                Text(hint).font(.ui(11)).foregroundStyle(Theme.textDim)
            }

            Button(action: create) {
                HStack(spacing: 6) {
                    Text("Create").font(.ui(12, .semibold))
                    Text("⏎").font(.ui(11)).opacity(0.7)
                }
                .foregroundStyle(Theme.textPrimary)
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .background(RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(r.canCreate ? Theme.working : Theme.raised))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!r.canCreate)

            Button("") { isPresented = false }
                .keyboardShortcut(.cancelAction)
                .opacity(0)
                .frame(width: 0, height: 0)
        }
        .padding(.horizontal, 16)
        .frame(height: 52)
    }

    // MARK: wiring

    /// One writable binding into the optional request, so the fields stay declarative.
    private func binding<V>(_ key: WritableKeyPath<NewTabRequest, V>) -> Binding<V> {
        Binding(get: { (request ?? NewTabRequest(target: fallbackTarget))[keyPath: key] },
                set: { request?[keyPath: key] = $0 })
    }

    private var fallbackTarget: NewTabTarget {
        NewTabTarget(workspaceID: "", name: "Workspace", isRemote: false, isGitRepo: false)
    }

    private func seed() {
        targets = store.newTabTargets()
        let wanted = store.newTabSeedWorkspaceID ?? store.selectedWorkspaceID
        let target = targets.first { $0.workspaceID == wanted } ?? targets.first ?? fallbackTarget
        request = NewTabRequest(target: target, worktree: store.newTabWorktreeDefault())
        store.newTabSeedWorkspaceID = nil
        focus = .title
        resolveGitStatus(for: target)
    }

    private func retarget(_ t: NewTabTarget) {
        request?.retarget(t)
        resolveGitStatus(for: t)
    }

    /// `Git.isWorkTree` shells out, so only the selected target is resolved, off-main.
    private func resolveGitStatus(for t: NewTabTarget) {
        guard !t.isRemote,
              let ws = store.workspaces.first(where: { $0.id == t.workspaceID }),
              let p = ws.defaultPath, !p.isEmpty else { return }
        let dir = (p as NSString).expandingTildeInPath
        DispatchQueue.global(qos: .userInitiated).async {
            let ok = Git.isWorkTree(dir)
            DispatchQueue.main.async {
                guard request?.target.workspaceID == t.workspaceID else { return }
                request?.retarget(NewTabTarget(workspaceID: t.workspaceID, name: t.name,
                                               isRemote: t.isRemote, isGitRepo: ok))
            }
        }
    }

    /// AppKit binds `insertNewlineIgnoringFieldEditor:` to **Option**-Return; Shift-Return
    /// reaches the field editor as a plain `insertNewline:` and submits. Installed only
    /// while the prompt holds focus, so the single-line fields keep submitting on it.
    private func installNewlineMonitor() {
        guard newlineMonitor == nil else { return }
        newlineMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { e in
            let mods = e.modifierFlags.intersection([.shift, .command, .option, .control])
            guard e.keyCode == 36, mods == .shift,
                  let editor = NSApp.keyWindow?.firstResponder as? NSTextView else { return e }
            editor.insertNewlineIgnoringFieldEditor(nil)
            return nil
        }
    }

    private func removeNewlineMonitor() {
        if let m = newlineMonitor { NSEvent.removeMonitor(m) }
        newlineMonitor = nil
    }

    private func create() {
        guard let r = request, r.canCreate else { return }
        store.create(r)
        isPresented = false
    }
}
