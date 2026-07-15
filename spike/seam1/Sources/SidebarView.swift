import SwiftUI
import AppKit

struct SidebarView: View {
    @EnvironmentObject var store: AgentStore

    // Live-drag state for tab rows, kept local so per-frame updates only redraw the sidebar.
    @State private var draggingID: String?
    @State private var dragOffset: CGFloat = 0

    // Live-drag state for folder (workspace) headers.
    @State private var draggingWorkspaceID: String?
    @State private var wsDragOffset: CGFloat = 0
    @State private var headerMids: [String: CGFloat] = [:]

    // Cross-folder tab drag: each folder's region (wsList space) + the folder a
    // dragged tab is currently hovering over (nil while over its own folder).
    @State private var folderRegions: [String: CGRect] = [:]
    @State private var dropTargetWorkspaceID: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Color.clear.frame(height: 28)   // top strip the traffic-lights reveal into on hover

            topBar

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(store.workspaces.enumerated()), id: \.element.id) { idx, ws in
                        folderSection(ws, index: idx)
                        if idx < store.workspaces.count - 1 {
                            folderDivider
                        }
                    }
                }
                .padding(.horizontal, 8)
                .padding(.bottom, 6)
            }
            .coordinateSpace(name: "wsList")
            .onPreferenceChange(FolderCentersKey.self) { headerMids = $0 }
            .onPreferenceChange(FolderRegionsKey.self) { folderRegions = $0 }

            if !store.archivedWorktrees.isEmpty {
                Divider().overlay(Theme.hairline)
                footer
            }
        }
        .background(Theme.ground)
    }

    // MARK: Top bar — label · new-workspace · overflow (remote host + pairing code)

    private var topBar: some View {
        HStack(spacing: 8) {
            Text("Workspaces")
                .font(.ui(11, .medium))
                .foregroundStyle(Theme.textDim)
            Spacer()
            Button(action: { store.promptingNewWorkspace = true }) {
                Image(systemName: "plus")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.textDim)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .focusable(false)
            .help("New Workspace (⌘⇧N)")

            overflowMenu
        }
        .padding(.horizontal, 18)
        .padding(.bottom, 6)
    }

    private var overflowMenu: some View {
        Menu {
            Button("Add remote host…") { promptAddRemoteHost() }
            if store.isServing {
                Divider()
                Text("Pairing code: \(store.pairingCode)")
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.textDim)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .focusable(false)
    }

    // MARK: One folder — header + (unless collapsed) its tab rows, indented.

    @ViewBuilder
    private func folderSection(_ ws: Workspace, index: Int) -> some View {
        VStack(alignment: .leading, spacing: TabRow.gap) {
            WorkspaceFolderHeader(ws: ws, index: index,
                                  draggingWorkspaceID: $draggingWorkspaceID,
                                  wsDragOffset: $wsDragOffset,
                                  headerMids: $headerMids)

            if !ws.collapsed {
                ForEach(ws.tabs) { tab in
                    Group {
                        if tab.isSplit {
                            SplitTabGroup(tab: tab, workspaceID: ws.id)
                        } else {
                            TabRow(tab: tab, workspaceID: ws.id,
                                   draggingID: $draggingID, dragOffset: $dragOffset,
                                   folderRegions: folderRegions,
                                   dropTargetWorkspaceID: $dropTargetWorkspaceID)
                        }
                    }
                }
            }
        }
        .padding(.vertical, 2)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(dropTargetWorkspaceID == ws.id ? Theme.working.opacity(0.12) : .clear)
                .overlay(RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(dropTargetWorkspaceID == ws.id ? Theme.working.opacity(0.6) : .clear,
                                  lineWidth: 1))
        )
        .background(GeometryReader { g in
            Color.clear.preference(key: FolderRegionsKey.self,
                                   value: [ws.id: g.frame(in: .named("wsList"))])
        })
        .offset(y: draggingWorkspaceID == ws.id ? wsDragOffset : 0)
        .zIndex(draggingWorkspaceID == ws.id ? 1 : 0)
    }

    // A short, inset hairline between folders — separates workspaces without a
    // full-width rule.
    private var folderDivider: some View {
        Rectangle()
            .fill(Theme.divider)
            .frame(height: 1)
            .padding(.horizontal, 14)
            .padding(.vertical, 3)
    }

    private var footer: some View {
        GlobalArchivedSection()
    }

    /// Prompt for a host + pairing code, then attach it as remote (mirror) workspaces.
    /// Host accepts `name`, `100.x.y.z`, or `host:port`; default port is the shared one.
    private func promptAddRemoteHost() {
        let alert = NSAlert()
        alert.messageText = "Add remote host"
        alert.informativeText = "Enter the host's Tailscale name (or IP) and its 4-digit pairing code."
        let hostTF = NSTextField(frame: NSRect(x: 0, y: 30, width: 240, height: 24))
        hostTF.placeholderString = "mac-mini  or  100.x.y.z"
        let codeTF = NSTextField(frame: NSRect(x: 0, y: 0, width: 240, height: 24))
        codeTF.placeholderString = "pairing code"
        let accessory = NSView(frame: NSRect(x: 0, y: 0, width: 240, height: 54))
        accessory.addSubview(hostTF); accessory.addSubview(codeTF)
        alert.accessoryView = accessory
        alert.addButton(withTitle: "Add")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = hostTF
        guard alert.runModal() == .alertFirstButtonReturn else { return }

        let raw = hostTF.stringValue.trimmingCharacters(in: .whitespaces)
        let code = codeTF.stringValue.trimmingCharacters(in: .whitespaces)
        guard !raw.isEmpty, !code.isEmpty else { return }
        var host = raw
        var port = AgentStore.defaultRemotePort
        if let colon = raw.lastIndex(of: ":"), let p = UInt16(raw[raw.index(after: colon)...]) {
            host = String(raw[..<colon]); port = p
        }
        store.addRemoteHost(host: host, port: port, code: code)
    }
}

// MARK: - Folder header

/// A workspace folder header: disclosure chevron · aggregate dot · name, with a
/// hover `+` (new tab into this folder), tap-to-collapse, drag-to-reorder folders,
/// and a right-click menu (rename / collapse / delete). The active workspace's name
/// reads brighter.
private struct WorkspaceFolderHeader: View {
    @EnvironmentObject var store: AgentStore
    let ws: Workspace
    let index: Int
    @Binding var draggingWorkspaceID: String?
    @Binding var wsDragOffset: CGFloat
    @Binding var headerMids: [String: CGFloat]

    @State private var editing = false
    @State private var draft = ""
    @State private var hovering = false
    @State private var isGitRepo = false   // local: live git check on hover; unused for mirrors
    @FocusState private var focused: Bool

    static let height: CGFloat = 26

    /// Show "New Worktree Tab…" when the default dir is a git repo. For a mirror the repo
    /// lives on the host (can't run git locally), so gate on the wired defaultPath instead.
    private var worktreeEnabled: Bool {
        ws.isRemote ? (ws.defaultPath?.isEmpty == false) : isGitRepo
    }

    private var isActive: Bool { ws.id == store.selectedWorkspaceID }

    var body: some View {
        HStack(spacing: LeadingIcon.gutterGap) {
            FolderIcon(open: !ws.collapsed, state: ws.aggregateState)

            if editing {
                renameField
            } else {
                Text(ws.displayName(index: index))
                    .font(.ui(13, .medium))
                    .foregroundStyle(isActive ? Theme.textPrimary : Theme.textSecondary)
                    .lineLimit(1)
                Spacer(minLength: 6)
                if hovering {
                    Menu {
                        Button("New Tab") { store.newTab(inWorkspace: ws.id) }
                        if worktreeEnabled {
                            Button("New Worktree Tab…") { promptNewWorktree() }
                        }
                    } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Theme.textDim)
                    }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .focusable(false)
                    .help("New tab in this workspace")
                }
            }
        }
        .padding(.horizontal, 10)
        .frame(height: Self.height)
        .background(RoundedRectangle(cornerRadius: 6)
            .fill(hovering ? Theme.raised.opacity(0.4) : .clear))
        .contentShape(Rectangle())
        .background(GeometryReader { g in
            Color.clear.preference(key: FolderCentersKey.self,
                                   value: [ws.id: g.frame(in: .named("wsList")).midY])
        })
        .onHover { h in
            hovering = h
            if h { refreshGitStatus() }
        }
        .onTapGesture { if !editing { store.toggleWorkspaceCollapsed(ws.id) } }
        .gesture(reorderGesture)
        .contextMenu {
            Button("Rename") { beginRename() }
            Button("Set Directory…") { promptSetDirectory() }
            if ws.defaultPath?.isEmpty == false {
                Button("Clear Directory") { store.setWorkspaceDirectory(ws.id, to: nil) }
            }
            Button(ws.collapsed ? "Expand" : "Collapse") { store.toggleWorkspaceCollapsed(ws.id) }
            if store.workspaces.count > 1 {
                Button("Delete", role: .destructive) { confirmDelete() }
            }
        }
    }

    private var renameField: some View {
        TextField("name", text: $draft)
            .textFieldStyle(.plain)
            .font(.ui(13, .medium))
            .foregroundStyle(Theme.textPrimary)
            .focused($focused)
            .onSubmit(commit)
            .onExitCommand { endEditing() }
            .onAppear { focused = true }
    }

    // Drag the whole folder; on release, drop it where its header center now lands
    // (variable folder heights rule out the tab rows' uniform-stride math).
    private var reorderGesture: some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in
                if draggingWorkspaceID == nil { draggingWorkspaceID = ws.id }
                guard draggingWorkspaceID == ws.id else { return }
                wsDragOffset = value.translation.height
            }
            .onEnded { _ in
                if draggingWorkspaceID == ws.id, let from = store.workspaces.firstIndex(where: { $0.id == ws.id }) {
                    let draggedMid = (headerMids[ws.id] ?? 0) + wsDragOffset
                    let target = store.workspaces.filter {
                        $0.id != ws.id && (headerMids[$0.id] ?? 0) < draggedMid
                    }.count
                    if target != from { store.reorderWorkspace(ws.id, toIndex: target) }
                }
                draggingWorkspaceID = nil
                wsDragOffset = 0
            }
    }

    private func beginRename() {
        draft = ws.userTitle ?? ws.displayName(index: index)
        editing = true
    }

    /// Refresh whether the (local) default dir is a git work tree; drives the worktree menu
    /// item. Off-main so a hover never hitches; settles before the `+` menu is opened. Skipped
    /// for mirrors (the repo is on the host — worktreeEnabled reads the wired defaultPath there).
    private func refreshGitStatus() {
        guard !ws.isRemote, let p = ws.defaultPath, !p.isEmpty else { isGitRepo = false; return }
        let dir = (p as NSString).expandingTildeInPath
        DispatchQueue.global(qos: .userInitiated).async {
            let ok = Git.isWorkTree(dir)
            DispatchQueue.main.async { isGitRepo = ok }
        }
    }

    /// Set the workspace's default directory. Local: native folder chooser. Mirror: the path
    /// must exist on the HOST, so prompt for text (a local folder picker would browse the wrong machine).
    private func promptSetDirectory() {
        if ws.isRemote { promptSetDirectoryOnHost(); return }
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Set"
        panel.message = "Choose the default directory for new tabs in this workspace"
        if let cur = ws.defaultPath, !cur.isEmpty {
            panel.directoryURL = URL(fileURLWithPath: (cur as NSString).expandingTildeInPath)
        }
        guard panel.runModal() == .OK, let url = panel.url else { return }
        store.setWorkspaceDirectory(ws.id, to: url.path)
        store.refocusActiveTerminal()
    }

    private func promptSetDirectoryOnHost() {
        let alert = NSAlert()
        alert.messageText = "Set workspace directory (on host)"
        alert.informativeText = "Enter a path as it exists on the host machine. New tabs open there."
        let tf = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        tf.stringValue = ws.defaultPath ?? ""
        tf.placeholderString = "/Users/you/dev/repo"
        alert.accessoryView = tf
        alert.addButton(withTitle: "Set")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = tf
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        store.setWorkspaceDirectory(ws.id, to: tf.stringValue)
    }

    /// Prompt for a branch name, then create a worktree tab (mirrors promptAddRemoteHost).
    private func promptNewWorktree() {
        let alert = NSAlert()
        alert.messageText = "New worktree tab"
        alert.informativeText = "Name a branch. An existing branch is reused; a new name is created off origin's default branch (freshly fetched)."
        let tf = NSTextField(frame: NSRect(x: 0, y: 0, width: 240, height: 24))
        tf.placeholderString = "branch name"
        alert.accessoryView = tf
        alert.addButton(withTitle: "Create")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = tf
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let name = tf.stringValue.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        store.newWorktreeTab(inWorkspace: ws.id, name: name)
    }
    private func commit() {
        store.renameWorkspace(ws.id, to: draft)
        endEditing()
    }
    private func endEditing() {
        editing = false
        store.refocusActiveTerminal()
    }

    /// Confirm only when the workspace holds a live agent (delete kills its PTYs).
    private func confirmDelete() {
        guard store.workspaceHasLiveAgent(ws.id) else { store.deleteWorkspace(ws.id); return }
        let alert = NSAlert()
        alert.messageText = "Delete this workspace?"
        alert.informativeText = "It has running agents. Closing it ends their sessions."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Delete")
        alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn { store.deleteWorkspace(ws.id) }
    }
}

/// Header positions in the list's coordinate space — the source of truth for
/// dropping a dragged folder at the right index despite variable folder heights.
private struct FolderCentersKey: PreferenceKey {
    static var defaultValue: [String: CGFloat] = [:]
    static func reduce(value: inout [String: CGFloat], nextValue: () -> [String: CGFloat]) {
        value.merge(nextValue(), uniquingKeysWith: { _, b in b })
    }
}

/// Each folder's full region (header + tabs) in the list's coordinate space — used
/// to tell which folder a dragged tab is hovering over for a cross-folder move.
private struct FolderRegionsKey: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, b in b })
    }
}

// MARK: - Tab row

private struct TabRow: View {
    @EnvironmentObject var store: AgentStore
    let tab: Tab
    let workspaceID: String
    @Binding var draggingID: String?
    @Binding var dragOffset: CGFloat
    var folderRegions: [String: CGRect] = [:]
    @Binding var dropTargetWorkspaceID: String?

    static let height: CGFloat = 28
    static let gap: CGFloat = 1
    static var stride: CGFloat { height + gap }

    @State private var editing = false
    @State private var draft = ""
    @State private var hovering = false
    @State private var isWorktree = false   // live git check on hover; gates "Archive Worktree"
    @FocusState private var focused: Bool

    private var ws: Workspace? { store.workspaces.first { $0.id == workspaceID } }
    private var wsTabs: [Tab] { ws?.tabs ?? [] }
    private var isSelected: Bool {
        store.selectedWorkspaceID == workspaceID && ws?.selectedTabID == tab.tabID
    }
    private var isDragging: Bool { draggingID == tab.tabID }
    private var index: Int? { wsTabs.firstIndex { $0.tabID == tab.tabID } }

    // Single-pane tab: the row reflects its one (focused) pane, just like today.
    private var state: AgentState { tab.focusedPane()?.state ?? .shell }
    private var isProvisioning: Bool { tab.focusedPane()?.provisioning ?? false }

    var body: some View {
        HStack(spacing: LeadingIcon.gutterGap) {
            Color.clear.frame(width: LeadingIcon.gutter)   // aligns the dot under the folder dot

            if isProvisioning {
                ProgressView()
                    .controlSize(.small)
                    .scaleEffect(0.68)
                    .frame(width: 14, height: 14)
                    .tint(Theme.working)
                Text(tab.displayTitle)   // real name from the start → seamless once it's ready
                    .font(.ui(13, isSelected ? .medium : .regular))
                    .foregroundStyle(nameColor)
                    .lineLimit(1)
                Spacer(minLength: 6)
            } else {
                if state == .idle, let pr = store.prStatuses[tab.focusedPaneID] {
                    PRStatusIcon(status: pr) { store.openPR(forPane: tab.focusedPaneID) }
                } else {
                    LeadingIcon(state: state)
                }

                if editing {
                    TextField("name", text: $draft)
                        .textFieldStyle(.plain)
                        .font(.ui(13))
                        .foregroundStyle(Theme.textPrimary)
                        .focused($focused)
                        .onSubmit(commit)
                        .onExitCommand { endEditing() }
                        .onAppear { focused = true }
                } else {
                    Text(tab.displayTitle)
                        .font(.ui(13, isSelected ? .medium : .regular))
                        .foregroundStyle(nameColor)
                        .lineLimit(1)
                }

                Spacer(minLength: 6)
            }
        }
        .padding(.horizontal, 10)
        .frame(height: Self.height)
        .background(RoundedRectangle(cornerRadius: 6).fill(rowFill))
        .contentShape(Rectangle())
        .shadow(color: .black.opacity(isDragging ? 0.5 : 0),
                radius: isDragging ? 8 : 0, y: isDragging ? 4 : 0)
        .offset(y: isDragging ? dragOffset : 0)
        .zIndex(isDragging ? 1 : 0)
        .animation(isDragging ? nil : .spring(response: 0.28, dampingFraction: 0.82), value: index)
        .onHover { hovering = $0; if $0 { refreshWorktreeStatus() } }
        .onTapGesture { store.select(tabID: tab.tabID, inWorkspace: workspaceID) }
        .gesture(reorderGesture)
        .contextMenu {
            Button("Rename") { beginRename() }
            if isWorktree, ws?.isRemote == false {
                Button("Archive Worktree") { store.archiveWorktreeTab(tab.tabID, inWorkspace: workspaceID) }
            }
            Button("Close Tab") { store.requestCloseTab(tab.tabID, inWorkspace: workspaceID) }
        }
    }

    /// Is this tab's directory a linked git worktree? Checked off-main on hover so
    /// the "Archive Worktree" item is ready by the time the menu opens. Local only.
    private func refreshWorktreeStatus() {
        guard ws?.isRemote == false, let cwd = tab.focusedPane()?.cwd, !cwd.isEmpty else { isWorktree = false; return }
        DispatchQueue.global(qos: .userInitiated).async {
            let ok = Git.isLinkedWorktree(cwd)
            DispatchQueue.main.async { isWorktree = ok }
        }
    }

    private var nameColor: Color {
        isSelected ? Theme.textPrimary : Theme.textSecondary
    }
    private var rowFill: Color {
        if isSelected { return Theme.raised }
        if hovering   { return Theme.raised.opacity(0.5) }
        return .clear
    }

    // Which folder the drag is currently over (nil ⇒ this row's own folder).
    private func folderUnder(_ y: CGFloat) -> String? {
        folderRegions.first { $0.value.minY <= y && y <= $0.value.maxY }?.key
    }

    // Drag picks the row up. Within its own folder the list reflows live (stride
    // math). Over another folder we suppress the reflow, highlight that folder, and
    // move the tab there on release (hybrid — see ADR 0017).
    private var reorderGesture: some Gesture {
        DragGesture(minimumDistance: 8, coordinateSpace: .named("wsList"))
            .onChanged { value in
                if draggingID == nil {
                    draggingID = tab.tabID
                    store.select(tabID: tab.tabID, inWorkspace: workspaceID)
                }
                guard draggingID == tab.tabID, let from = index else { return }
                dragOffset = value.translation.height

                let over = folderUnder(value.location.y)
                if let over, over != workspaceID {
                    dropTargetWorkspaceID = over        // cross-folder: highlight, no reflow
                    return
                }
                dropTargetWorkspaceID = nil             // back home: resume live reflow
                let target = max(0, min(wsTabs.count - 1,
                                        from + Int((dragOffset / Self.stride).rounded())))
                if target != from {
                    store.reorder(tabID: tab.tabID, toIndex: target, inWorkspace: workspaceID)
                    dragOffset -= CGFloat(target - from) * Self.stride
                }
            }
            .onEnded { _ in
                if draggingID == tab.tabID {
                    if let dest = dropTargetWorkspaceID, dest != workspaceID {
                        store.moveTab(tab.tabID, toWorkspace: dest)
                    } else {
                        store.commitOrder(inWorkspace: workspaceID)
                    }
                }
                draggingID = nil
                dragOffset = 0
                dropTargetWorkspaceID = nil
            }
    }

    private func beginRename() {
        draft = tab.userTitle ?? tab.displayTitle
        editing = true
    }
    private func commit() {
        store.rename(tabID: tab.tabID, to: draft, inWorkspace: workspaceID)
        endEditing()
    }
    private func endEditing() {
        editing = false
        store.refocusActiveTerminal()
    }
}

// MARK: - Archived worktrees (global)

/// A single collapsible "Archived (N)" section pinned in the sidebar footer — all
/// archived worktrees across every workspace, newest first. Tap a row to restore
/// (recreating its workspace if gone); right-click to restore or delete. Collapsed
/// by default; the expanded list is height-capped so the footer stays bounded.
private struct GlobalArchivedSection: View {
    @EnvironmentObject var store: AgentStore
    @State private var expanded = false

    private var archives: [ArchivedWorktree] {
        store.archivedWorktrees.sorted { $0.archivedAt > $1.archivedAt }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if expanded {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: TabRow.gap) {
                        ForEach(archives) { a in ArchivedRow(archive: a) }
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                }
                .frame(maxHeight: 220)
            }
            Button(action: { expanded.toggle() }) {
                HStack(spacing: 8) {
                    Image(systemName: "archivebox")
                    Text("Archived")
                    Text("\(store.archivedWorktrees.count)")
                        .font(.ui(11, .medium))
                        .foregroundStyle(Theme.textDim)
                    Spacer()
                    Image(systemName: expanded ? "chevron.down" : "chevron.up")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Theme.textDim)
                }
                .font(.ui(12))
                .foregroundStyle(Theme.textSecondary)
                .padding(.horizontal, 16)
                .padding(.vertical, 11)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .focusable(false)
        }
    }
}

private struct ArchivedRow: View {
    @EnvironmentObject var store: AgentStore
    let archive: ArchivedWorktree
    @State private var hovering = false

    private var workspaceLabel: String {
        if let ws = store.workspaces.first(where: { $0.id == archive.workspaceID }),
           let i = store.workspaces.firstIndex(where: { $0.id == archive.workspaceID }) {
            return ws.displayName(index: i)
        }
        return (archive.workspaceName.map { "\($0) (new)" }) ?? "new workspace"
    }

    var body: some View {
        HStack(spacing: LeadingIcon.gutterGap) {
            Image(systemName: "archivebox")
                .font(.system(size: 10))
                .foregroundStyle(Theme.textDim)
                .frame(width: 14)
            VStack(alignment: .leading, spacing: 1) {
                Text(archive.name)
                    .font(.ui(12))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                Text(workspaceLabel)
                    .font(.ui(10))
                    .foregroundStyle(Theme.textDim)
                    .lineLimit(1)
            }
            Spacer(minLength: 6)
            Text(WorktreeArchive.archiveAgeString(archive.archivedAt, now: Date()))
                .font(.ui(10))
                .foregroundStyle(Theme.textDim)
        }
        .padding(.horizontal, 8)
        .frame(height: TabRow.height + 4)
        .background(RoundedRectangle(cornerRadius: 6).fill(hovering ? Theme.raised.opacity(0.5) : .clear))
        .opacity(hovering ? 1 : 0.75)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .help("\(archive.branch.isEmpty ? "detached" : archive.branch) · archived \(WorktreeArchive.archiveAgeString(archive.archivedAt, now: Date())) ago")
        .onTapGesture { store.restoreWorktree(archive.id) }
        .contextMenu {
            Button("Restore") { store.restoreWorktree(archive.id) }
            Button("Delete", role: .destructive) { store.deleteArchive(archive.id) }
        }
    }
}

// MARK: - Split tab group

/// A split tab — one sidebar row: a leading aggregate-state icon (the panes rolled
/// up), the tab's rename if set, then compact `● 1  ● 2` pips. Hover a pip for its
/// title; tap to focus that pane. Right-click → rename / close tab. Zoom dims the
/// non-zoomed pips.
private struct SplitTabGroup: View {
    @EnvironmentObject var store: AgentStore
    let tab: Tab
    let workspaceID: String

    @State private var editing = false
    @State private var draft = ""
    @State private var hovering = false
    @FocusState private var focused: Bool

    private var ws: Workspace? { store.workspaces.first { $0.id == workspaceID } }
    private var isSelected: Bool {
        store.selectedWorkspaceID == workspaceID && ws?.selectedTabID == tab.tabID
    }
    private var panes: [Pane] { tab.root.panes }

    // The tab's own name — only an explicit rename (userTitle). We can't use a
    // pane's OSC title: it differs pane-to-pane, so there's no single tab title.
    private var name: String? {
        guard let u = tab.userTitle, !u.isEmpty else { return nil }
        return u
    }

    var body: some View {
        HStack(spacing: LeadingIcon.gutterGap) {
            Color.clear.frame(width: LeadingIcon.gutter)   // aligns the dot under the folder dot
            LeadingIcon(state: aggregateState)
            if editing {
                renameField
            } else {
                if let name {
                    Text(name)
                        .font(.ui(13, isSelected ? .semibold : .medium))
                        .foregroundStyle(isSelected ? Theme.textPrimary : Theme.textSecondary)
                        .lineLimit(1)
                }
                ForEach(Array(panes.enumerated()), id: \.element.paneID) { idx, pane in
                    pip(pane, number: idx + 1)
                }
                Spacer(minLength: 6)
            }
        }
        .padding(.horizontal, 10)
        .frame(height: TabRow.height)
        .background(RoundedRectangle(cornerRadius: 6).fill(rowFill))
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture { store.select(tabID: tab.tabID, inWorkspace: workspaceID) }
        .contextMenu {
            Button("Rename") { beginRename() }
            Button("Close Tab") { store.closeTab(tab.tabID, inWorkspace: workspaceID) }
        }
    }

    /// Rolled-up state for the leading icon — the most important state across the
    /// panes (blocked > error > done > working > idle > shell), i.e. the tab's dot.
    private var aggregateState: AgentState {
        let states = panes.map(\.state)
        for s: AgentState in [.blocked, .error, .needsCheck, .working, .idle]
            where states.contains(s) { return s }
        return .shell
    }

    private var rowFill: Color {
        if isSelected { return Theme.raised }
        if hovering   { return Theme.raised.opacity(0.5) }
        return .clear
    }

    // Compact pip: a small state dot + the pane's 1-based number. Secondary to the
    // tab's leading aggregate icon; hover reveals the pane's title.
    private func pip(_ pane: Pane, number: Int) -> some View {
        HStack(spacing: 4) {
            Circle()
                .fill(pane.state.color)
                .frame(width: 6, height: 6)
            Text("\(number)")
                .font(.ui(11, .medium))
                .foregroundStyle(Theme.textDim)
        }
        .opacity(dim(pane))
        .contentShape(Rectangle())
        .help(pane.displayTitle)
        .onTapGesture { store.revealPane(pane.paneID) }
    }

    // MARK: shared bits

    /// Zoom dimming: a non-zoomed sibling fades; everything else is full opacity.
    private func dim(_ pane: Pane) -> Double {
        guard let zoomed = tab.zoomedPaneID else { return 1 }
        return pane.paneID == zoomed ? 1 : 0.4
    }

    // The one sidebar control that legitimately takes keyboard focus (mirrors
    // TabRow's rename); endEditing() hands first responder back to the terminal.
    private var renameField: some View {
        TextField("name", text: $draft)
            .textFieldStyle(.plain)
            .font(.ui(13))
            .foregroundStyle(Theme.textPrimary)
            .focused($focused)
            .onSubmit(commit)
            .onExitCommand { endEditing() }
            .onAppear { focused = true }
    }

    private func beginRename() {
        draft = tab.userTitle ?? tab.displayTitle
        editing = true
    }
    private func commit() {
        store.rename(tabID: tab.tabID, to: draft, inWorkspace: workspaceID)
        endEditing()
    }
    private func endEditing() {
        editing = false
        store.refocusActiveTerminal()
    }
}

/// A workspace's leading glyph — and its disclosure control: a filled folder when
/// expanded (open), an outline folder when collapsed (closed), so it doubles as the
/// open/closed indicator and folders never look like terminal rows. Tinted by the
/// workspace's rolled-up state: dim when idle/quiet, the state color when a pane
/// wants you, so attention still rolls up to the folder without a separate dot.
private struct FolderIcon: View {
    let open: Bool
    let state: AgentState

    var body: some View {
        TablerIcon(paths: open ? Tabler.folderOpen : Tabler.folder, size: 14)
            .foregroundStyle(tint)
    }

    private var tint: Color {
        switch state {
        case .shell, .idle: return Theme.textDim
        default:            return state.color
        }
    }
}

/// Tabler icon path data (24×24 grid, 2px stroke) — the same line-icon set Synara
/// draws, so glyphs read as thin strokes, not SF Symbols' heavier fills. Each icon
/// is its list of SVG `<path d>` values.
enum Tabler {
    static let folder = ["M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2"]
    static let folderOpen = ["M5 19l2.757 -7.351a1 1 0 0 1 .936 -.649h12.307a1 1 0 0 1 .986 1.164l-.996 5.211a2 2 0 0 1 -1.964 1.625h-14.026a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2h4l3 3h7a2 2 0 0 1 2 2v2"]
    static let terminal2 = ["M8 9l3 3l-3 3", "M13 15l3 0", "M3 6a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2l0 -12"]

    // git-pull-request family — Tabler encodes circles as path arcs, so the
    // path-only renderer handles them unchanged.
    static let pullRequest = [
        "M6 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
        "M6 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
        "M18 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
        "M6 8l0 8",
        "M11 6h5a2 2 0 0 1 2 2v8",
        "M14 9l-3 -3l3 -3"]
    static let gitMerge = [
        "M7 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
        "M7 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
        "M17 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
        "M7 8l0 8",
        "M7 8a4 4 0 0 0 4 4h4"]
    static let pullRequestClosed = [
        "M6 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
        "M6 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
        "M6 8l0 8",
        "M18 11l0 5",
        "M16 3l4 4",
        "M20 3l-4 4"]
    static let pullRequestDraft = [
        "M6 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
        "M6 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
        "M18 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
        "M6 8l0 8",
        "M18 11l0 5",
        "M18 5l0 .01"]
    static let file = [
        "M14 3v4a1 1 0 0 0 1 1h4",
        "M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z"]
    static let eye = [
        "M10 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
        "M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6"]
    static let x = ["M18 6l-12 12", "M6 6l12 12"]
    static let copy = [
        "M8 8m0 2a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2z",
        "M16 8v-2a2 2 0 0 0 -2 -2h-8a2 2 0 0 0 -2 2v8a2 2 0 0 0 2 2h2"]
    static let pencil = [
        "M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4",
        "M13.5 6.5l4 4"]
    static let check = ["M5 12l5 5l10 -10"]
}

/// Renders a Tabler stroke-icon from its SVG path list as a tint-able template
/// image, so `.foregroundStyle` colors it like an SF Symbol. Parsed images are
/// cached since rows redraw often (hover/drag).
struct TablerIcon: View {
    let paths: [String]
    var size: CGFloat = 14

    var body: some View {
        Image(nsImage: Self.image(paths))
            .renderingMode(.template)
            .resizable()
            .frame(width: size, height: size)
    }

    private static var cache: [String: NSImage] = [:]
    private static func image(_ paths: [String]) -> NSImage {
        let key = paths.joined(separator: "|")
        if let cached = cache[key] { return cached }
        let elements = paths.map { #"<path d="\#($0)"/>"# }.joined()
        let svg = """
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" \
        fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" \
        stroke-linejoin="round">\(elements)</svg>
        """
        let img = NSImage(data: Data(svg.utf8)) ?? NSImage()
        img.isTemplate = true
        cache[key] = img
        return img
    }
}

/// PR-status glyph shown in an idle agent's leading slot; click opens the PR. Icon
/// family conveys open/merged/closed/draft; color conveys the finer status.
struct PRStatusIcon: View {
    let status: PRStatus
    let onOpen: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: onOpen) {
            glyph
                .frame(width: 14, height: 14)   // layout footprint stays aligned with the state dot
                .background(
                    // Squircle hover chip — signals the icon is a clickable button.
                    // Drawn behind at a fixed size so it doesn't shift the row layout.
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(Theme.surface3)
                        .frame(width: 22, height: 22)
                        .opacity(hovering ? 1 : 0)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .focusable(false)
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
        .help("PR #\(status.number) · \(Self.label(status.kind)) — click to open")
    }

    @ViewBuilder private var glyph: some View {
        let color = Self.color(status.kind)
        if status.kind == .checksFailing {
            // Keep the PR glyph, add a tiny Tabler-x badge bottom-right.
            TablerIcon(paths: Tabler.pullRequest, size: 13)
                .foregroundStyle(color)
                .overlay(alignment: .bottomTrailing) {
                    TablerIcon(paths: Tabler.x, size: 7)
                        .foregroundStyle(color)
                        .padding(1)
                        .background(Circle().fill(Theme.ground))
                        .offset(x: 3, y: 3)
                }
        } else {
            TablerIcon(paths: Self.paths(status.kind), size: 13)
                .foregroundStyle(color)
        }
    }

    static func paths(_ kind: PRKind) -> [String] {
        switch kind {
        case .merged:           return Tabler.gitMerge
        case .closed:           return Tabler.pullRequestClosed
        case .draft:            return Tabler.pullRequestDraft
        case .changesRequested: return Tabler.file
        case .reviewRequired:   return Tabler.eye
        default:                return Tabler.pullRequest   // open, mergeReady, checksPending, checksFailing (badge in glyph)
        }
    }

    static func color(_ kind: PRKind) -> Color {
        switch kind {
        case .merged:                          return Theme.prMerged
        case .closed, .checksFailing,
             .changesRequested:                return Theme.error   // changes-requested reads red, GitHub-style
        case .draft:                           return Theme.textDim
        case .checksPending, .reviewRequired:  return Theme.blocked
        case .mergeReady:                      return Theme.needsCheck
        case .open:                            return Theme.working
        }
    }

    static func label(_ kind: PRKind) -> String {
        switch kind {
        case .merged: return "merged"
        case .closed: return "closed"
        case .draft: return "draft"
        case .checksFailing: return "checks failing"
        case .changesRequested: return "changes requested"
        case .checksPending: return "checks running"
        case .reviewRequired: return "review required"
        case .mergeReady: return "ready to merge"
        case .open: return "open"
        }
    }
}

/// Leading glyph: a colored status dot for agents (working breathes), a muted
/// terminal icon for plain shells — so every row reads, like T3's icon column.
struct LeadingIcon: View {
    let state: AgentState

    // Shared leading column so every dot (folder header + tab rows) lands on one
    // vertical rail: `gutter` holds the folder chevron (empty for tab rows),
    // `gutterGap` is the space between it and the dot. Header/rows use both + pad 10.
    static let gutter: CGFloat = 12
    static let gutterGap: CGFloat = 8

    var body: some View {
        Group {
            switch state {
            case .shell:
                TablerIcon(paths: Tabler.terminal2, size: 13)
                    .foregroundStyle(Theme.textDim)
            case .working:
                BreathingDot(color: state.color)
            default:
                Circle()
                    .fill(state.color)
                    .frame(width: 7, height: 7)
            }
        }
        .frame(width: 14, height: 14)
    }
}

/// Breathes for as long as it exists; recreated on each `.working` entry so
/// `onAppear` restarts the loop (a long-lived view won't re-fire a repeatForever).
private struct BreathingDot: View {
    let color: Color
    @State private var dim = false

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 7, height: 7)
            .opacity(dim ? 0.4 : 1)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
                    dim = true
                }
            }
    }
}
