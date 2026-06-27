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
                    ForEach(store.tabs) { tab in
                        TabRow(tab: tab, draggingID: $draggingID, dragOffset: $dragOffset)
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
    let tab: Agent
    @Binding var draggingID: String?
    @Binding var dragOffset: CGFloat

    static let height: CGFloat = 28
    static let gap: CGFloat = 1
    static var stride: CGFloat { height + gap }

    @State private var editing = false
    @State private var draft = ""
    @State private var hovering = false
    @FocusState private var focused: Bool

    private var isSelected: Bool { store.selected == tab.tabID }
    private var isDragging: Bool { draggingID == tab.tabID }
    private var index: Int? { store.tabs.firstIndex { $0.tabID == tab.tabID } }

    var body: some View {
        HStack(spacing: 9) {
            LeadingIcon(state: tab.state)

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

            if !editing, let s = statusText {
                Text(s)
                    .font(.system(size: 11))
                    .foregroundStyle(tab.state.color)
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
        .onTapGesture { store.select(tab.tabID) }
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
    // Right-aligned status word — only on notable states (matches T3's labels).
    private var statusText: String? {
        switch tab.state {
        case .working:      return "Working"
        case .needsCheck:   return "Done"
        case .blocked:      return (tab.reason?.isEmpty == false) ? capitalized(tab.reason!) : "Blocked"
        case .error:        return "Error"
        case .idle, .shell: return nil
        }
    }
    private func capitalized(_ s: String) -> String { s.prefix(1).uppercased() + s.dropFirst() }

    // Drag picks the row up; the list reflows live and commits on release.
    private var reorderGesture: some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in
                if draggingID == nil {
                    draggingID = tab.tabID
                    store.select(tab.tabID)
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
