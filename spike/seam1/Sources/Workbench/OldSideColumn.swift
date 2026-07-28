import AppKit

/// What the left column shows on one row.
struct SideRow {
    let text: NSAttributedString
    /// Old-side line number, or nil where this row has no left-hand line at all.
    let number: Int?
    let tint: RowTint
    /// Changed-word spans as measured x offsets, like `DeletedLineRow`.
    let wordSpans: [(x: CGFloat, width: CGFloat)]
}

/// The old side of a split diff, drawn beside the editor.
///
/// **Not a second editor.** The new side is the one real `SourceEditor`, and this reads that
/// editor's layout manager for every y it draws at — so the two columns cannot drift, because
/// there is only one opinion about where a row sits. Monaco solves the same problem with two
/// editors and view zones; the reasoning for diverging, including the part of it that turned
/// out to be wrong, is in the side-by-side design doc.
///
/// Built the way `DiffGutterView` is, and repeating the rules that cost this project real
/// time: geometry from `editorLineMetrics`, scroll read live off the clip view with the
/// notification only triggering a repaint, `clipsToBounds` (false by default since macOS 14),
/// and a per-draw walk bounded to the visible rows.
final class OldSideColumnView: NSView {
    /// The left-hand content for a row, or nil where there is none.
    var row: ((Int) -> SideRow?)?
    /// A deletion band's rendered lines — the same bands that render inline, moved here.
    var bandLines: ((Block) -> [DeletedLineRow])?
    /// Height of the blocks above a row, so a row's own line is drawn below them.
    var blockHeightAbove: ((Int) -> CGFloat)?
    /// The blocks themselves, so each gets a matching treatment on this side. A band that
    /// stops at the divider reads as belonging to the right column alone, when a hunk gap
    /// or a file header is a fact about **both** sides.
    var blocksAbove: ((Int) -> [Block])?
    var lineMetrics: ((Int) -> (yPos: CGFloat, height: CGFloat)?)?
    var lineIndex: ((CGFloat) -> Int?)?
    var scrollViewProvider: (() -> NSScrollView?)?
    var rowCount = 0
    var rowHeight: CGFloat = 16
    var maxLineNumber = 1

    private var scrollY: CGFloat { scrollViewProvider?()?.contentView.bounds.origin.y ?? 0 }
    private weak var observedClipView: NSClipView?

    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        clipsToBounds = true
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        clipsToBounds = true
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    /// Repaint when the editor scrolls. Position is read live, so a missed notification
    /// costs a stale frame rather than a column that has slid against the text.
    func observeScroll() {
        guard let clipView = scrollViewProvider?()?.contentView,
              clipView !== observedClipView else { return }
        if let observedClipView {
            NotificationCenter.default.removeObserver(
                self, name: NSView.boundsDidChangeNotification, object: observedClipView)
        }
        clipView.postsBoundsChangedNotifications = true
        observedClipView = clipView
        NotificationCenter.default.addObserver(
            self, selector: #selector(clipViewDidScroll),
            name: NSView.boundsDidChangeNotification, object: clipView)
        needsDisplay = true
    }

    @objc private func clipViewDidScroll() { needsDisplay = true }

    private static let leadingPad: CGFloat = 10
    private static let gap: CGFloat = 8

    /// The rows overlapping a rect, bounded by how many could physically fit.
    ///
    /// Each step queries the layout manager, and this runs per scroll event — the unbounded
    /// version of this walk is what stalled scrolling in the gutter.
    private func visibleRange(in rect: NSRect) -> Range<Int> {
        guard rowHeight > 0, rowCount > 0 else { return 0..<0 }
        let top = rect.minY + scrollY
        let first = min(max(0, lineIndex?(top) ?? Int((top / rowHeight).rounded(.down))),
                        rowCount - 1)
        let capacity = Int((rect.height / rowHeight).rounded(.up)) * 2 + 4
        var last = first
        while last < min(rowCount, first + capacity),
              (lineMetrics?(last)?.yPos ?? CGFloat(last) * rowHeight) - scrollY <= rect.maxY {
            last += 1
        }
        return first..<min(last + 1, rowCount)
    }

    override func draw(_ dirtyRect: NSRect) {
        observeScroll()
        NSColor(hex24: Theme.Diff.buffer).setFill()
        bounds.fill()
        // A hairline against the editor, so the two columns read as two columns.
        NSColor(hex24: Theme.Diff.separator).setFill()
        NSRect(x: bounds.maxX - 1, y: 0, width: 1, height: bounds.height).fill()

        let font = WorkbenchMetrics.font
        let numberAttributes: [NSAttributedString.Key: Any] = [
            .font: NSFont(name: font.fontName, size: 12) ?? font,
            .foregroundColor: NSColor(hex24: Theme.Diff.gutterFg),
        ]
        let digit = ("0" as NSString).size(withAttributes: numberAttributes).width
        let numberWidth = CGFloat(String(max(1, maxLineNumber)).count) * digit
        let textX = Self.leadingPad + numberWidth + Self.gap
        let glyphHeight = ("0" as NSString).size(withAttributes: [.font: font]).height

        for index in visibleRange(in: dirtyRect) {
            let metrics = lineMetrics?(index)
            let blockHeight = blockHeightAbove?(index) ?? 0
            let blockTop = (metrics?.yPos ?? CGFloat(index) * self.rowHeight) - scrollY
            let lineTop = blockTop + blockHeight
            let height = (metrics?.height ?? self.rowHeight) - blockHeight

            // The removed lines that reserve blank space on the right are drawn here, in the
            // space their band already accounts for — that is the whole trick of the split
            // view: the right side's layout is unchanged, only where the text lands differs.
            drawBlocks(forRow: index, top: blockTop,
                       textX: textX, numberWidth: numberWidth, digit: digit,
                       numberAttributes: numberAttributes, glyphHeight: glyphHeight)

            guard let side = row?(index) else {
                // Nothing on this side of the row: the right column has a line here that the
                // old side never had. Hatched rather than left blank, because an empty row
                // is indistinguishable from a blank line in the file — which is exactly what
                // it must not be confused with. VSCode hatches these for the same reason.
                Self.drawVoid(NSRect(x: 0, y: lineTop, width: bounds.width, height: height))
                continue
            }
            if let bg = Self.rowColor(side.tint) {
                bg.setFill()
                NSRect(x: 0, y: lineTop, width: bounds.width, height: height).fill()
            }
            if let strong = Self.wordColor(side.tint), !side.wordSpans.isEmpty {
                strong.setFill()
                for span in side.wordSpans {
                    NSRect(x: textX + span.x, y: lineTop, width: span.width, height: height).fill()
                }
            }
            if let number = side.number {
                let text = String(number)
                let width = CGFloat(text.count) * digit
                (text as NSString).draw(
                    at: NSPoint(x: Self.leadingPad + numberWidth - width,
                                y: lineTop + (height - glyphHeight) / 2),
                    withAttributes: numberAttributes)
            }
            side.text.draw(at: NSPoint(x: textX, y: lineTop + (height - glyphHeight) / 2))
        }
    }

    /// Every band above a row, given the treatment that matches what the right column does
    /// with it — so a band reads as one band spanning two columns rather than two things.
    private func drawBlocks(forRow index: Int, top: CGFloat, textX: CGFloat,
                            numberWidth: CGFloat, digit: CGFloat,
                            numberAttributes: [NSAttributedString.Key: Any],
                            glyphHeight: CGFloat) {
        var y = top
        for block in blocksAbove?(index) ?? [] {
            let rect = NSRect(x: 0, y: y, width: bounds.width, height: block.height)
            y += block.height
            guard rect.intersects(visibleRect.isEmpty ? bounds : visibleRect) else { continue }

            switch block.kind {
            case .deletedLines:
                drawBand(block, in: rect, textX: textX, numberWidth: numberWidth,
                         digit: digit, numberAttributes: numberAttributes,
                         glyphHeight: glyphHeight)
            case .hunkGap:
                // The same fill the right column uses, so the "N lines skipped" strip runs
                // across both. The expand arrows stay in the gutter; this is the band's
                // other half, not a second copy of it.
                NSColor(hex24: Theme.Diff.hover).setFill()
                rect.fill()
            case .fileHeader, .sectionHeader:
                NSColor(hex24: Theme.Diff.hover).setFill()
                rect.fill()
                NSColor(hex24: Theme.Diff.separator).setFill()
                NSRect(x: 0, y: rect.maxY - 1, width: rect.width, height: 1).fill()
            default:
                // Anything else the right column reserves space for gets neutral ground
                // rather than a hole.
                NSColor(hex24: Theme.Diff.buffer).setFill()
                rect.fill()
            }
        }
    }

    /// Removed lines, in the band's own reserved space.
    ///
    /// The line height divides **the band's own height**, exactly as `DiffRowView` and
    /// `DiffGutterView` divide it — never `rowHeight`, which is an estimate of the text's
    /// line height and drifts down a long run.
    private func drawBand(_ block: Block, in band: NSRect, textX: CGFloat,
                          numberWidth: CGFloat, digit: CGFloat,
                          numberAttributes: [NSAttributedString.Key: Any],
                          glyphHeight: CGFloat) {
        let lines = bandLines?(block) ?? []
        guard !lines.isEmpty, band.height > 0 else { return }
        let each = band.height / CGFloat(lines.count)
        for (offset, line) in lines.enumerated() {
            let rect = NSRect(x: 0, y: band.minY + CGFloat(offset) * each,
                              width: bounds.width, height: each)
            guard rect.intersects(visibleRect.isEmpty ? bounds : visibleRect) else { continue }
            if let bg = Self.rowColor(line.tint) {
                bg.setFill()
                rect.fill()
            }
            if let strong = Self.wordColor(line.tint), !line.wordSpans.isEmpty {
                strong.setFill()
                for span in line.wordSpans {
                    NSRect(x: textX + span.x, y: rect.minY,
                           width: span.width, height: rect.height).fill()
                }
            }
            line.text.draw(at: NSPoint(x: textX, y: rect.midY - glyphHeight / 2))
        }
    }

    /// Diagonal hatching for a row the old side does not have.
    ///
    /// Drawn rather than filled flat so it reads as "no content here" instead of as a
    /// differently-coloured line. Clipped to the row, and cheap: a handful of strokes.
    private static func drawVoid(_ rect: NSRect) {
        guard rect.height > 0, rect.width > 0 else { return }
        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }
        NSBezierPath(rect: rect).addClip()

        NSColor(hex24: Theme.Diff.buffer).blended(withFraction: 0.5,
                                                  of: NSColor.black)?.setFill()
        rect.fill()

        let stripe = NSBezierPath()
        stripe.lineWidth = 1.5
        let spacing: CGFloat = 6
        // Slope of 1, so the stripes stay 45° whatever the row height.
        var x = rect.minX - rect.height
        while x < rect.maxX {
            stripe.move(to: NSPoint(x: x, y: rect.maxY))
            stripe.line(to: NSPoint(x: x + rect.height, y: rect.minY))
            x += spacing
        }
        // Bright enough to actually read. The first attempt used the separator colour at
        // half alpha and was invisible against the buffer.
        NSColor(hex24: Theme.Diff.gutterFg).withAlphaComponent(0.30).setStroke()
        stripe.stroke()

        // A border, so a run of void rows reads as one region with edges rather than as
        // texture that happens to be there.
        NSColor(hex24: Theme.Diff.gutterFg).withAlphaComponent(0.22).setFill()
        NSRect(x: 0, y: rect.minY, width: rect.width, height: 1).fill()
        NSRect(x: 0, y: rect.maxY - 1, width: rect.width, height: 1).fill()
    }

    private static func rowColor(_ tint: RowTint) -> NSColor? {
        switch tint {
        case .none:    return nil
        case .removed: return NSColor(hex24: Theme.Diff.deletion).withAlphaComponent(0.14)
        default:       return nil
        }
    }

    private static func wordColor(_ tint: RowTint) -> NSColor? {
        tint == .removed ? NSColor(hex24: Theme.Diff.wordDel).withAlphaComponent(0.55) : nil
    }
}
