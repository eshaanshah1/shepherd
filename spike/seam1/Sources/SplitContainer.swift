import SwiftUI

/// Recursively renders a tab's `SplitNode` tree: leaves become `GhosttyTerminal`
/// surfaces, splits lay their two children out by `ratio` with a hairline between.
/// A single-leaf tree degenerates to one terminal filling the area (no ring, no
/// divider) — i.e. behaves exactly like an unsplit tab.
struct SplitContainer: View {
    let node: SplitNode
    let tabID: String
    let isTabSelected: Bool
    let focusTick: Int
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
                    child(first).frame(width: geo.size.width * ratio)
                    Rectangle().fill(Theme.hairline).frame(width: 1)
                    child(second)
                }
            case .column:
                VStack(spacing: 0) {
                    child(first).frame(height: geo.size.height * ratio)
                    Rectangle().fill(Theme.hairline).frame(height: 1)
                    child(second)
                }
            }
        }
    }

    private func child(_ node: SplitNode) -> SplitContainer {
        SplitContainer(node: node, tabID: tabID, isTabSelected: isTabSelected, focusTick: focusTick)
    }
}
