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

            Divider().overlay(Theme.hairline)
            footer
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
        Button(action: { store.newTab() }) {
            HStack(spacing: 8) {
                Image(systemName: "plus")
                Text("New Tab")
                Spacer()
                Text("⌘T").foregroundStyle(Theme.textDim)
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
    @FocusState private var focused: Bool

    static let height: CGFloat = 26

    private var isActive: Bool { ws.id == store.selectedWorkspaceID }

    var body: some View {
        HStack(spacing: LeadingIcon.gutterGap) {
            FolderIcon(open: !ws.collapsed, state: ws.aggregateState)

            if editing {
                renameField
            } else {
                Text(ws.displayName(index: index))
                    .font(.ui(12, .medium))
                    .foregroundStyle(isActive ? Theme.textPrimary : Theme.textSecondary)
                    .lineLimit(1)
                Spacer(minLength: 6)
                if hovering {
                    Button(action: { store.newTab(inWorkspace: ws.id) }) {
                        Image(systemName: "plus")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Theme.textDim)
                    }
                    .buttonStyle(.plain)
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
        .onHover { hovering = $0 }
        .onTapGesture { if !editing { store.toggleWorkspaceCollapsed(ws.id) } }
        .gesture(reorderGesture)
        .contextMenu {
            Button("Rename") { beginRename() }
            Button(ws.collapsed ? "Expand" : "Collapse") { store.toggleWorkspaceCollapsed(ws.id) }
            if store.workspaces.count > 1 {
                Button("Delete", role: .destructive) { confirmDelete() }
            }
        }
    }

    private var renameField: some View {
        TextField("name", text: $draft)
            .textFieldStyle(.plain)
            .font(.ui(12, .medium))
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

    var body: some View {
        HStack(spacing: LeadingIcon.gutterGap) {
            Color.clear.frame(width: LeadingIcon.gutter)   // aligns the dot under the folder dot
            LeadingIcon(state: state)

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
        .padding(.horizontal, 10)
        .frame(height: Self.height)
        .background(RoundedRectangle(cornerRadius: 6).fill(rowFill))
        .contentShape(Rectangle())
        .shadow(color: .black.opacity(isDragging ? 0.5 : 0),
                radius: isDragging ? 8 : 0, y: isDragging ? 4 : 0)
        .offset(y: isDragging ? dragOffset : 0)
        .zIndex(isDragging ? 1 : 0)
        .animation(isDragging ? nil : .spring(response: 0.28, dampingFraction: 0.82), value: index)
        .onHover { hovering = $0 }
        .onTapGesture { store.select(tabID: tab.tabID, inWorkspace: workspaceID) }
        .gesture(reorderGesture)
        .contextMenu {
            Button("Rename") { beginRename() }
            Button("Close Tab") { store.closeTab(tab.tabID, inWorkspace: workspaceID) }
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
