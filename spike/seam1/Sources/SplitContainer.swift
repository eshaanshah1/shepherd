import SwiftUI
import AppKit

/// Renders a tab's `SplitNode` tree as a FLAT, absolutely-positioned layout: every
/// pane's `GhosttyTerminal` lives in one `ZStack`, keyed by `paneID`, sized/placed
/// at its computed frame. Splitting only ADDS a pane to the list, so an existing
/// pane keeps its SwiftUI identity — its NSView/surface/PTY is never torn down.
/// (A recursive render reparents the original pane's view into a new container on
/// split, which frees its surface and restarts its shell.)
///
/// Dividers are an overlay derived from `node.dividers(in:)`; a divider's `path`
/// addresses its split from the root so a drag resizes the exact node.
struct SplitContainer: View {
    let node: SplitNode
    let tabID: String
    let isTabSelected: Bool
    let focusTick: Int
    var zoomedPaneID: String? = nil
    @EnvironmentObject var store: AgentStore

    var body: some View {
        let tab = store.anyTab(tabID)
        let focusedPaneID = tab?.focusedPaneID
        let isSplit = tab?.isSplit == true

        GeometryReader { geo in
            let rect = CGRect(origin: .zero, size: geo.size)
            ZStack(alignment: .topLeading) {
                // Panes are placed by a custom Layout that gives each backing view a
                // frame EQUAL to its pane rect. A SwiftUI `.position`/`.offset` wrapper
                // instead expands each pane's backing `_NSGraphicsView` to fill the
                // whole container; stacked, the topmost pane then swallows every click
                // landing over a sibling, so sibling panes can't be focused by mouse.
                PaneLayout(node: node, zoomedPaneID: zoomedPaneID) {
                    ForEach(node.panes, id: \.paneID) { pane in
                        let isVisible = isTabSelected && (zoomedPaneID == nil || pane.paneID == zoomedPaneID)
                        let isFocused = pane.paneID == focusedPaneID
                        GhosttyTerminal(paneID: pane.paneID,
                                        isVisible: isVisible,
                                        isSelected: isTabSelected && isFocused,
                                        focusTick: focusTick)
                            // Inactive panes dim instead of the focused one drawing a
                            // ring; a single-pane tab is never dimmed.
                            .opacity(isSplit && !isFocused ? 0.60 : 1.0)
                    }
                }

                if zoomedPaneID == nil {
                    ForEach(node.dividers(in: rect), id: \.key) { d in
                        PaneDivider(axis: d.axis, ratio: d.ratio, span: d.span,
                                    tabID: tabID, path: d.path)
                            .frame(width: d.axis == .row ? 6 : d.rect.width,
                                   height: d.axis == .column ? 6 : d.rect.height)
                            .position(x: d.rect.midX, y: d.rect.midY)
                    }
                }

                // ⌘F search overlay, pinned to the top-right of the focused pane.
                if isTabSelected, let fp = focusedPaneID, let search = store.searches[fp] {
                    let pr = paneFrame(fp, in: rect)
                    ZStack(alignment: .topTrailing) {
                        Color.clear
                        PaneSearchOverlay(paneID: fp, state: search)
                            .padding([.top, .trailing], 8)
                    }
                    .frame(width: pr.width, height: pr.height)
                    .position(x: pr.midX, y: pr.midY)
                }
            }
        }
    }

    /// Frame of a pane within the container (the whole rect when zoomed).
    private func paneFrame(_ id: String, in rect: CGRect) -> CGRect {
        if zoomedPaneID != nil { return rect }
        return node.frames(in: rect)[id] ?? rect
    }
}

/// Floating find bar over the focused pane. libghostty matches + highlights the
/// grid; this just drives the query and shows the match counter.
private struct PaneSearchOverlay: View {
    let paneID: String
    let state: SearchState
    @EnvironmentObject var store: AgentStore
    @FocusState private var fieldFocused: Bool
    @State private var query = ""
    @State private var shiftReturnMonitor: Any?

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 11))
                .foregroundColor(Theme.textDim)
            TextField("Find", text: $query)
                .textFieldStyle(.plain)
                .font(.system(size: 12))
                .foregroundColor(Theme.textPrimary)
                .frame(width: 150)
                .focused($fieldFocused)
                .onSubmit { store.navigateSearch(.next, paneID: paneID) }
                .onChange(of: query) { store.setSearchQuery($0, paneID: paneID) }
            if !state.counter.isEmpty {
                Text(state.counter)
                    .font(.system(size: 11).monospacedDigit())
                    .foregroundColor(state.noMatches ? Theme.error : Theme.textSecondary)
            }
            iconButton("chevron.up")   { store.navigateSearch(.previous, paneID: paneID) }
            iconButton("chevron.down") { store.navigateSearch(.next, paneID: paneID) }
            iconButton("xmark")        { store.closeSearch(paneID: paneID) }
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Theme.raised)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.hairline, lineWidth: 1))
                .shadow(color: .black.opacity(0.35), radius: 8, y: 2)
        )
        .onExitCommand { store.closeSearch(paneID: paneID) }   // Esc
        .onAppear {
            query = state.query; fieldFocused = true
            shiftReturnMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
                // keyCode 36 = Return. Shift-Return → previous match; swallow it.
                if event.keyCode == 36, event.modifierFlags.contains(.shift) {
                    store.navigateSearch(.previous, paneID: paneID)
                    return nil
                }
                return event
            }
        }
        .onDisappear {
            if let m = shiftReturnMonitor { NSEvent.removeMonitor(m) }
            shiftReturnMonitor = nil
        }
        .onChange(of: store.searchFocusTick) { _ in fieldFocused = true }
    }

    private func iconButton(_ name: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: name)
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(Theme.textSecondary)
                .frame(width: 16, height: 16)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .focusable(false)
    }
}

/// Places each pane subview at its exact rect from `node.frames`, so the backing
/// NSView's frame equals the pane rect (no full-container expansion → no click
/// swallowing between siblings). Subview order matches `ForEach(node.panes)`, so
/// `subviews[i]` is `node.panes[i]`. While zoomed, the zoomed pane fills the bounds
/// and every other pane stays MOUNTED at 0×0 (its surface/PTY stays alive).
private struct PaneLayout: Layout {
    let node: SplitNode
    let zoomedPaneID: String?

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let frames = node.frames(in: CGRect(origin: .zero, size: bounds.size))
        let panes = node.panes
        for (i, sub) in subviews.enumerated() {
            guard i < panes.count else { break }
            let f = placedFrame(panes[i].paneID, frames, CGRect(origin: .zero, size: bounds.size))
            sub.place(at: CGPoint(x: bounds.minX + f.minX, y: bounds.minY + f.minY),
                      anchor: .topLeading,
                      proposal: ProposedViewSize(width: f.width, height: f.height))
        }
    }

    private func placedFrame(_ paneID: String, _ frames: [String: CGRect], _ rect: CGRect) -> CGRect {
        if let zoomedPaneID {
            return paneID == zoomedPaneID ? rect : CGRect(x: rect.minX, y: rect.minY, width: 0, height: 0)
        }
        return frames[paneID] ?? rect
    }
}

/// A 1px `Theme.hairline` centred in a 6px draggable strip (mirrors the sidebar
/// divider). Dragging sets the owning split's `ratio`; `span` is the split rect's
/// extent along the axis, used to convert the drag translation into a ratio delta.
/// Clamping happens in `SplitNode.setRatio`.
private struct PaneDivider: View {
    let axis: SplitAxis
    let ratio: Double
    let span: CGFloat
    let tabID: String
    let path: [Int]
    @EnvironmentObject var store: AgentStore
    @State private var startRatio: Double?

    var body: some View {
        ZStack {
            Rectangle().fill(Theme.hairline)
                .frame(width: axis == .row ? 1 : nil, height: axis == .column ? 1 : nil)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .focusable(false)
        .onHover { inside in
            if inside { (axis == .row ? NSCursor.resizeLeftRight : NSCursor.resizeUpDown).push() }
            else { NSCursor.pop() }
        }
        .gesture(
            DragGesture(minimumDistance: 1)
                .onChanged { v in
                    if startRatio == nil { startRatio = ratio }
                    guard span > 0 else { return }
                    let delta = axis == .row ? v.translation.width : v.translation.height
                    store.setRatio(tabID: tabID, path: path, to: startRatio! + Double(delta) / Double(span))
                }
                .onEnded { _ in startRatio = nil }
        )
    }
}
