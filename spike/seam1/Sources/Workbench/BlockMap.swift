import Foundation
import CoreGraphics

/// What a non-text row shows.
enum BlockKind: Equatable {
    case fileHeader(SourceID)
    /// Removed lines, rendered as a block because they exist in no current file.
    case deletedLines(source: SourceID, lines: [String], startingOldLine: Int)
    /// Alignment padding on the shorter side of a split diff.
    case spacer(rows: Int)
    case conflictControls(SourceID)
    /// Hosts the rendered-markdown diff views (ADR 0019).
    case renderedMarkdown(SourceID)

    /// The file this block belongs to, or nil for file-agnostic blocks (spacers).
    var source: SourceID? {
        switch self {
        case .fileHeader(let s), .conflictControls(let s), .renderedMarkdown(let s):
            return s
        case .deletedLines(let s, _, _):
            return s
        case .spacer:
            return nil
        }
    }
}

/// A non-text row inserted immediately above `beforeStitchedLine`.
struct Block: Equatable, Identifiable {
    let id: String
    let kind: BlockKind
    var beforeStitchedLine: Int
    let height: CGFloat
}

/// Ordered non-text rows with height accounting.
///
/// Kept sorted by position so lookup is a scan of a sorted array and shifting is a
/// single pass — typing moves every block below the cursor, so this runs on every
/// keystroke and is the structure the spec flags as the performance risk.
struct BlockMap: Equatable {
    private(set) var blocks: [Block]

    init(blocks: [Block] = []) {
        self.blocks = blocks.sorted { $0.beforeStitchedLine < $1.beforeStitchedLine }
    }

    /// Insert, preserving sort order. Blocks at the same position keep insertion
    /// order, so a file header stays above the spacer that follows it.
    mutating func insert(_ block: Block) {
        let idx = blocks.firstIndex { $0.beforeStitchedLine > block.beforeStitchedLine }
            ?? blocks.count
        blocks.insert(block, at: idx)
    }

    /// Drop every block belonging to a file. Spacers belong to no file and survive.
    mutating func removeAll(for source: SourceID) {
        blocks.removeAll { $0.kind.source == source }
    }

    func blocks(beforeStitchedLine line: Int) -> [Block] {
        blocks.filter { $0.beforeStitchedLine == line }
    }

    /// Combined height of every block strictly above a stitched line — the y-offset
    /// the text at that line has been pushed down by.
    func totalHeight(aboveStitchedLine line: Int) -> CGFloat {
        blocks.reduce(0) { $0 + ($1.beforeStitchedLine < line ? $1.height : 0) }
    }

    /// Slide blocks at or below an edit point. Positions clamp at 0.
    mutating func shift(fromStitchedLine line: Int, by delta: Int) {
        guard delta != 0 else { return }
        for idx in blocks.indices where blocks[idx].beforeStitchedLine >= line {
            blocks[idx].beforeStitchedLine = max(0, blocks[idx].beforeStitchedLine + delta)
        }
        // A negative delta can only reorder by collapsing positions together, so a
        // stable sort keeps same-position blocks in their existing order.
        blocks = blocks.enumerated()
            .sorted {
                $0.element.beforeStitchedLine != $1.element.beforeStitchedLine
                    ? $0.element.beforeStitchedLine < $1.element.beforeStitchedLine
                    : $0.offset < $1.offset
            }
            .map(\.element)
    }
}
