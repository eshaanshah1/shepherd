import SwiftUI
import AppKit

struct SidebarView: View {
    @EnvironmentObject var store: AgentStore

    // Live-drag state, kept local so per-frame updates only redraw the sidebar.
    @State private var draggingID: String?
    @State private var dragOffset: CGFloat = 0
    @Binding var showSwitcher: Bool
    @State private var sidebarHovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Color.clear.frame(height: 28)   // clear the traffic-light buttons

            header

            // All workspaces' tab lists sit side by side in one strip; sliding it
            // by -index*width makes the current workspace exit toward the swipe
            // direction and the next enter from the opposite edge — deterministic,
            // unlike an id-swap insertion/removal transition.
            GeometryReader { geo in
                let w = max(geo.size.width, 1)
                HStack(spacing: 0) {
                    ForEach(store.workspaces) { ws in
                        tabList(for: ws).frame(width: w)
                    }
                }
                .offset(x: -CGFloat(store.currentWorkspaceIndex ?? 0) * w)
                .animation(.easeInOut(duration: 0.25), value: store.selectedWorkspaceID)
            }
            .clipped()

            Divider().overlay(Theme.hairline)
            footer
        }
        .background(Theme.ground)
        .onHover { sidebarHovering = $0 }
        .background(SidebarSwipe(hovering: sidebarHovering,
                                 onSwipe: { store.swipeToWorkspace($0) })
            .frame(width: 0, height: 0))
    }

    private var header: some View {
        HStack(spacing: 8) {
            Button(action: { showSwitcher.toggle() }) {
                HStack(spacing: 4) {
                    Text(workspaceName)
                        .font(.ui(11, .semibold))
                        .tracking(0.6)
                        .foregroundStyle(Theme.textDim)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundStyle(Theme.textDim)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .focusable(false)

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
        }
        .padding(.horizontal, 18)
        .padding(.bottom, 6)
    }

    private var workspaceName: String {
        guard let i = store.currentWorkspaceIndex else { return "WORKSPACE" }
        return store.workspaces[i].displayName(index: i).uppercased()
    }

    /// One workspace's tab list — a single column in the sliding strip.
    private func tabList(for ws: Workspace) -> some View {
        ScrollView {
            LazyVStack(spacing: TabRow.gap) {
                ForEach(ws.tabs) { tab in
                    if tab.isSplit {
                        SplitTabGroup(tab: tab)
                    } else {
                        TabRow(tab: tab, draggingID: $draggingID, dragOffset: $dragOffset)
                    }
                }
            }
            .padding(.horizontal, 8)
            .padding(.bottom, 6)
        }
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
}

private struct TabRow: View {
    @EnvironmentObject var store: AgentStore
    let tab: Tab
    @Binding var draggingID: String?
    @Binding var dragOffset: CGFloat

    static let height: CGFloat = 28
    static let gap: CGFloat = 1
    static var stride: CGFloat { height + gap }

    @State private var editing = false
    @State private var draft = ""
    @State private var hovering = false
    @FocusState private var focused: Bool

    private var isSelected: Bool { store.selectedTab == tab.tabID }
    private var isDragging: Bool { draggingID == tab.tabID }
    private var index: Int? { store.tabs.firstIndex { $0.tabID == tab.tabID } }

    // Single-pane tab: the row reflects its one (focused) pane, just like today.
    private var state: AgentState { tab.focusedPane()?.state ?? .shell }
    private var reason: String? { tab.focusedPane()?.reason }

    var body: some View {
        HStack(spacing: 9) {
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

            if !editing, let s = statusWord(state, reason) {
                Text(s)
                    .font(.ui(11))
                    .foregroundStyle(state.color)
                    .lineLimit(1)
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
        .onHover { hovering = $0 }
        .onTapGesture { store.select(tabID: tab.tabID) }
        .gesture(reorderGesture)
        .contextMenu {
            Button("Rename") { beginRename() }
            Button("Close Tab") { store.closeTab(tab.tabID) }
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

    // Drag picks the row up; the list reflows live and commits on release.
    private var reorderGesture: some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in
                if draggingID == nil {
                    draggingID = tab.tabID
                    store.select(tabID: tab.tabID)
                }
                guard draggingID == tab.tabID, let from = index else { return }
                dragOffset = value.translation.height
                let target = max(0, min(store.tabs.count - 1,
                                        from + Int((dragOffset / Self.stride).rounded())))
                if target != from {
                    store.reorder(tabID: tab.tabID, toIndex: target)
                    dragOffset -= CGFloat(target - from) * Self.stride
                }
            }
            .onEnded { _ in
                if draggingID == tab.tabID { store.commitOrder() }
                draggingID = nil
                dragOffset = 0
            }
    }

    private func beginRename() {
        draft = tab.userTitle ?? tab.displayTitle
        editing = true
    }
    private func commit() {
        store.rename(tabID: tab.tabID, to: draft)
        endEditing()
    }
    private func endEditing() {
        editing = false
        store.refocusActiveTerminal()
    }
}

// MARK: - Split tab group

/// A split tab — one sidebar row at the same indent as any tab: a leading
/// aggregate-state icon (the panes rolled up), the tab's rename if set, then
/// compact `● 1  ● 2` pips. Hover a pip for its title; tap to focus that pane.
/// Right-click → rename / close tab. Zoom dims the non-zoomed pips.
private struct SplitTabGroup: View {
    @EnvironmentObject var store: AgentStore
    let tab: Tab

    @State private var editing = false
    @State private var draft = ""
    @State private var hovering = false
    @FocusState private var focused: Bool

    private var isSelected: Bool { store.selectedTab == tab.tabID }
    private var panes: [Pane] { tab.root.panes }

    // The tab's own name — only an explicit rename (userTitle). We can't use a
    // pane's OSC title: it differs pane-to-pane, so there's no single tab title.
    private var name: String? {
        guard let u = tab.userTitle, !u.isEmpty else { return nil }
        return u
    }

    var body: some View {
        HStack(spacing: 9) {
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
        .onTapGesture { store.select(tabID: tab.tabID) }
        .contextMenu {
            Button("Rename") { beginRename() }
            Button("Close Tab") { store.closeTab(tab.tabID) }
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
        store.rename(tabID: tab.tabID, to: draft)
        endEditing()
    }
    private func endEditing() {
        editing = false
        store.refocusActiveTerminal()
    }
}

/// Right-aligned status word — only on notable states (matches T3's labels).
/// Used by `TabRow` (split tabs show pips, not a status word).
private func statusWord(_ state: AgentState, _ reason: String?) -> String? {
    switch state {
    case .working:      return "Working"
    case .needsCheck:   return "Done"
    case .blocked:      return (reason?.isEmpty == false) ? capitalizedFirst(reason!) : "Blocked"
    case .error:        return "Error"
    case .idle, .shell: return nil
    }
}
private func capitalizedFirst(_ s: String) -> String { s.prefix(1).uppercased() + s.dropFirst() }

/// Leading glyph: a colored status dot for agents (working breathes), a muted
/// terminal icon for plain shells — so every row reads, like T3's icon column.
struct LeadingIcon: View {
    let state: AgentState

    var body: some View {
        Group {
            switch state {
            case .shell:
                Image(systemName: "terminal")
                    .font(.system(size: 10))
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
