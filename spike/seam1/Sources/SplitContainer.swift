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
        let tab = store.tabs.first { $0.tabID == tabID }
        let focusedPaneID = tab?.focusedPaneID
        let isSplit = tab?.isSplit == true

        GeometryReader { geo in
            let rect = CGRect(origin: .zero, size: geo.size)
            let frames = node.frames(in: rect)
            ZStack(alignment: .topLeading) {
                ForEach(node.panes, id: \.paneID) { pane in
                    let f = placedFrame(pane.paneID, frames, rect)
                    // Visible = selected tab AND (not zoomed, or this is the zoomed
                    // pane) → occlusion, so every on-screen pane renders live.
                    let isVisible = isTabSelected && (zoomedPaneID == nil || pane.paneID == zoomedPaneID)
                    let isFocused = pane.paneID == focusedPaneID
                    GhosttyTerminal(paneID: pane.paneID,
                                    isVisible: isVisible,
                                    isSelected: isTabSelected && isFocused,
                                    focusTick: focusTick)
                        .frame(width: f.width, height: f.height)
                        .position(x: f.midX, y: f.midY)
                        // Inactive panes dim instead of the focused one drawing a
                        // ring; a single-pane tab is never dimmed.
                        .opacity(isSplit && !isFocused ? 0.60 : 1.0)
                        .clipped()
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
            }
        }
    }

    /// The frame to place `paneID` at. While zoomed, the zoomed pane fills `rect`
    /// and every other pane stays MOUNTED at 0×0 (its surface/PTY stays alive).
    /// Otherwise use the computed frame (the lone leaf gets the full rect).
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
