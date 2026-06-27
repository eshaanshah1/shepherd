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
            // Active-pane ring: only when the tab is split AND this is the
            // selected tab's focused pane.
            .overlay(
                Rectangle()
                    .strokeBorder(Theme.hairline,
                                  lineWidth: (tab?.isSplit == true && isTabSelected && isFocused) ? 1 : 0)
                    .allowsHitTesting(false)
            )
    }

    @ViewBuilder
    private func split(axis: SplitAxis, ratio: Double, first: SplitNode, second: SplitNode) -> some View {
        GeometryReader { geo in
            switch axis {
            case .row:
                HStack(spacing: 0) {
                    child(first, 0).frame(width: geo.size.width * ratio)
                    PaneDivider(axis: axis, ratio: ratio, span: geo.size.width,
                                tabID: tabID, path: path)
                    child(second, 1)
                }
            case .column:
                VStack(spacing: 0) {
                    child(first, 0).frame(height: geo.size.height * ratio)
                    PaneDivider(axis: axis, ratio: ratio, span: geo.size.height,
                                tabID: tabID, path: path)
                    child(second, 1)
                }
            }
        }
    }

    private func child(_ node: SplitNode, _ branch: Int) -> SplitContainer {
        SplitContainer(node: node, tabID: tabID, isTabSelected: isTabSelected,
                       focusTick: focusTick, path: path + [branch])
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
