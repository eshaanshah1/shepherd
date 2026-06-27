import SwiftUI
import AppKit

/// Recursively renders a tab's `SplitNode` tree: leaves become `GhosttyTerminal`
/// surfaces, splits lay their two children out by `ratio` with a draggable
/// hairline between. A single-leaf tree degenerates to one terminal filling the
/// area (no ring, no divider) — i.e. behaves exactly like an unsplit tab.
///
/// `path` addresses this node from the tab's root (0 = first, 1 = second); a
/// divider drag uses it to resize the exact split via `store.setRatio`.
struct SplitContainer: View {
    let node: SplitNode
    let tabID: String
    let isTabSelected: Bool
    let focusTick: Int
    var path: [Int] = []
    var zoomedPaneID: String? = nil
    @EnvironmentObject var store: AgentStore

    var body: some View {
        switch node {
        case .leaf(let pane):
            leaf(pane)
        case .split(let axis, let ratio, let first, let second):
            split(axis: axis, ratio: ratio, first: first, second: second)
        }
    }

    @ViewBuilder
    private func leaf(_ pane: Pane) -> some View {
        let tab = store.tabs.first { $0.tabID == tabID }
        let isFocused = pane.paneID == tab?.focusedPaneID
        GhosttyTerminal(paneID: pane.paneID,
                        isSelected: isTabSelected && isFocused,
                        focusTick: focusTick)
            // Inactive panes dim instead of the focused one drawing a ring; a
            // single-pane tab is never dimmed.
            .opacity(tab?.isSplit == true && !isFocused ? 0.82 : 1.0)
    }

    @ViewBuilder
    private func split(axis: SplitAxis, ratio: Double, first: SplitNode, second: SplitNode) -> some View {
        // Zoom funnel: when one child subtree contains the zoomed pane, render that
        // child full-size and starve the other to 0×0 (kept mounted so its surface
        // stays alive); hide the divider. Recursion funnels down to the zoomed leaf.
        let zoomFirst  = zoomedPaneID.map { first.leafIDs.contains($0) } ?? false
        let zoomSecond = zoomedPaneID.map { second.leafIDs.contains($0) } ?? false
        let zoomed = zoomFirst || zoomSecond

        GeometryReader { geo in
            switch axis {
            case .row:
                HStack(spacing: 0) {
                    child(first, 0)
                        .frame(width: zoomed ? (zoomFirst ? geo.size.width : 0) : geo.size.width * ratio)
                        .clipped()
                    if !zoomed {
                        PaneDivider(axis: axis, ratio: ratio, span: geo.size.width,
                                    tabID: tabID, path: path)
                    }
                    child(second, 1)
                        .frame(width: zoomed && !zoomSecond ? 0 : nil)
                        .clipped()
                }
            case .column:
                VStack(spacing: 0) {
                    child(first, 0)
                        .frame(height: zoomed ? (zoomFirst ? geo.size.height : 0) : geo.size.height * ratio)
                        .clipped()
                    if !zoomed {
                        PaneDivider(axis: axis, ratio: ratio, span: geo.size.height,
                                    tabID: tabID, path: path)
                    }
                    child(second, 1)
                        .frame(height: zoomed && !zoomSecond ? 0 : nil)
                        .clipped()
                }
            }
        }
    }

    private func child(_ node: SplitNode, _ branch: Int) -> SplitContainer {
        SplitContainer(node: node, tabID: tabID, isTabSelected: isTabSelected,
                       focusTick: focusTick, path: path + [branch], zoomedPaneID: zoomedPaneID)
    }
}

/// A 1px `Theme.hairline` centred in a 6px draggable strip (mirrors the sidebar
/// divider). Dragging sets the owning split's `ratio`; `span` is the parent
/// `GeometryReader`'s extent along the split axis, used to convert the drag
/// translation into a ratio delta. Clamping happens in `SplitNode.setRatio`.
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
        .frame(width: axis == .row ? 6 : nil, height: axis == .column ? 6 : nil)
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
