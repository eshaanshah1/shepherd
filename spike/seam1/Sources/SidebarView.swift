import SwiftUI
import AppKit

struct SidebarView: View {
    @EnvironmentObject var store: AgentStore

    // Live-drag state, kept local so per-frame updates only redraw the sidebar.
    @State private var draggingID: String?
    @State private var dragOffset: CGFloat = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Color.clear.frame(height: 28)   // clear the traffic-light buttons

            Text("TABS")
                .font(.system(size: 11, weight: .semibold))
                .tracking(0.6)
                .foregroundStyle(Theme.textDim)
                .padding(.horizontal, 18)
                .padding(.bottom, 6)

            ScrollView {
                LazyVStack(spacing: TabRow.gap) {
                    ForEach(Array(store.tabs.enumerated()), id: \.element.id) { idx, tab in
                        if tab.isSplit {
                            SplitTabGroup(tab: tab)
                        } else {
                            TabRow(tab: tab, draggingID: $draggingID, dragOffset: $dragOffset)
                        }
                        // Boundary line between tabs (not between panes in a group).
                        if idx < store.tabs.count - 1 {
                            Rectangle()
                                .fill(Theme.hairline)
                                .frame(height: 1)
                                .padding(.horizontal, 6)
                        }
                    }
                }
                .padding(.horizontal, 8)
                .padding(.bottom, 6)
            }

            Divider().overlay(Theme.hairline)
            footer
        }
        .background(Theme.ground)
    }

    private var footer: some View {
        Button(action: { store.newTab() }) {
            HStack(spacing: 8) {
                Image(systemName: "plus")
                Text("New Tab")
                Spacer()
                Text("⌘T").foregroundStyle(Theme.textDim)
            }
            .font(.system(size: 12))
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
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textPrimary)
                    .focused($focused)
                    .onSubmit(commit)
                    .onExitCommand { endEditing() }
                    .onAppear { focused = true }
            } else {
                Text(tab.displayTitle)
                    .font(.system(size: 13, weight: isSelected ? .medium : .regular))
                    .foregroundStyle(nameColor)
                    .lineLimit(1)
            }

            Spacer(minLength: 6)

            if !editing, let s = statusWord(state, reason) {
                Text(s)
                    .font(.system(size: 11))
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

/// A split tab: its panes gathered under a thin leading bracket/rail (expanded)
/// or folded to a `● 1  ▸ 2  ○ 3` pip strip (collapsed). Shared by both branches:
/// a subtle hover-only disclosure chevron toggles `collapsed`; the whole group is
/// the tab's interactive target (right-click → rename / close tab). Zoom dims the
/// non-zoomed panes in both branches.
private struct SplitTabGroup: View {
    @EnvironmentObject var store: AgentStore
    let tab: Tab

    @State private var editing = false
    @State private var draft = ""
    @State private var hovering = false
    @FocusState private var focused: Bool

    private var isSelected: Bool { store.selectedTab == tab.tabID }
    private var panes: [Pane] { tab.root.panes }

    var body: some View {
        Group {
            if tab.collapsed { collapsed } else { expanded }
        }
        .background(RoundedRectangle(cornerRadius: 6).fill(isSelected ? Theme.raised : .clear))
        .overlay(alignment: .topLeading) { disclosure }
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .contextMenu {
            Button("Rename") { beginRename() }
            Button("Close Tab") { store.closeTab(tab.tabID) }
        }
    }

    // MARK: expanded — bracket + one row per pane

    private var expanded: some View {
        HStack(alignment: .top, spacing: 6) {
            Bracket()
                .stroke(Theme.textDim, lineWidth: 1)
                .frame(width: 6)
                .padding(.vertical, 5)
            VStack(spacing: TabRow.gap) {
                if editing { renameField }
                ForEach(Array(panes.enumerated()), id: \.element.paneID) { _, pane in
                    paneRow(pane)
                }
            }
        }
        .padding(.leading, 8)
    }

    private func paneRow(_ pane: Pane) -> some View {
        HStack(spacing: 9) {
            LeadingIcon(state: pane.state)
            Text(pane.displayTitle)
                .font(.system(size: 13))
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
            Spacer(minLength: 6)
            if let s = statusWord(pane.state, pane.reason) {
                Text(s)
                    .font(.system(size: 11))
                    .foregroundStyle(pane.state.color)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 8)
        .frame(height: TabRow.height)
        .opacity(dim(pane))
        .background(RoundedRectangle(cornerRadius: 5)
            .fill(store.selectedTab == tab.tabID && tab.focusedPaneID == pane.paneID ? Theme.raised.opacity(0.6) : .clear))
        .contentShape(Rectangle())
        .onTapGesture { store.revealPane(pane.paneID) }
    }

    // MARK: collapsed — the numbered pip strip (state dot + 1-based index)

    private var collapsed: some View {
        Group {
            if editing {
                HStack(spacing: 9) { renameField }
                    .padding(.horizontal, 10)
                    .frame(height: TabRow.height)
            } else {
                HStack(spacing: 12) {
                    ForEach(Array(panes.enumerated()), id: \.element.paneID) { idx, pane in
                        pip(pane, number: idx + 1)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 18)
                .frame(height: TabRow.height)
                .contentShape(Rectangle())
                .onTapGesture { store.select(tabID: tab.tabID) }
            }
        }
    }

    private func pip(_ pane: Pane, number: Int) -> some View {
        HStack(spacing: 5) {
            LeadingIcon(state: pane.state)
            Text("\(number)")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.textSecondary)
        }
        .opacity(dim(pane))
        .contentShape(Rectangle())
        .help(pane.displayTitle)   // hover reveals the pane's title
        .onTapGesture { store.revealPane(pane.paneID) }
    }

    // MARK: shared bits

    /// Zoom dimming: a non-zoomed sibling fades; everything else is full opacity.
    private func dim(_ pane: Pane) -> Double {
        guard let zoomed = tab.zoomedPaneID else { return 1 }
        return pane.paneID == zoomed ? 1 : 0.4
    }

    /// Subtle hover-only collapse toggle at the leading edge — no always-on chevron.
    @ViewBuilder private var disclosure: some View {
        if hovering && !editing {
            Button { store.setCollapsed(tab.tabID, !tab.collapsed) } label: {
                Image(systemName: tab.collapsed ? "chevron.right" : "chevron.down")
                    .font(.system(size: 8, weight: .semibold))
                    .foregroundStyle(Theme.textDim)
                    .frame(width: 14, height: 14)
            }
            .buttonStyle(.plain)
            .focusable(false)
            .padding(.leading, 1)
            .padding(.top, tab.collapsed ? 7 : 9)
        }
    }

    // The one sidebar control that legitimately takes keyboard focus (mirrors
    // TabRow's rename); endEditing() hands first responder back to the terminal.
    private var renameField: some View {
        TextField("name", text: $draft)
            .textFieldStyle(.plain)
            .font(.system(size: 13))
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

/// A thin rounded left rail with short top/bottom ticks — the group marker for a
/// split tab (deliberately not a curly `{`; ADR 0012). Drawn in a 6-pt-wide box,
/// stretched to the group's height.
private struct Bracket: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        let x = rect.midX
        p.move(to: CGPoint(x: rect.maxX, y: rect.minY))           // top tick
        p.addLine(to: CGPoint(x: x, y: rect.minY))
        p.addLine(to: CGPoint(x: x, y: rect.maxY))                // the rail
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))        // bottom tick
        return p
    }
}

/// Right-aligned status word — only on notable states (matches T3's labels).
/// Shared by `TabRow` and `SplitTabGroup`'s pane rows so the wording stays in one place.
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
private struct LeadingIcon: View {
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
