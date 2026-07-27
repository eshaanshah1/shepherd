import AppKit

/// What one gutter row shows. Position is not part of it — the view derives y from the
/// row index (see `yFor`), which is what lets it draw only the visible window instead of
/// being handed every row in the document.
struct GutterRow: Equatable {
    /// The one number to show: the new-side number, or the old-side one on a removal.
    let lineNumber: Int?
    let sign: Character?      // "+", "-", or nil for context
    let tint: RowTint
    let selected: Bool
}

/// The workbench gutter: `[line no] [sign]`.
///
/// A sibling view rather than a fork of CESE's `GutterView`, whose `drawLineNumbers`
/// is private — one of the two walls that forced vendoring.
///
/// **One number column, not two.** A unified diff can show old|new side by side, but on
/// context lines — most of any diff — the two are identical, so it reads as every number
/// stuttering. The sign column already says which side a number belongs to.
///
/// **No checkbox column.** Per-line staging selection is the editor's own text selection
/// (drag in the text, or drag here to take whole lines); a permanently reserved tick box
/// on every row was a lot of chrome for something used occasionally.
///
/// The sign gets its own column instead of being prefixed into the text. The old diff
/// panel prefixed it, which pushed changed lines one character right of context lines.
final class DiffGutterView: NSView {
    /// Pulled per row, on demand, for the visible window only.
    var row: ((Int) -> GutterRow?)?
    var rowCount = 0
    var rowHeight: CGFloat = 16
    var scrollY: CGFloat = 0
    /// Sizes the number column. Passed in rather than scanned off the rows, which for a
    /// 32k-row document meant a full pass per draw.
    var maxLineNumber = 1
    /// Whole-line selection dragged in the gutter.
    var onSelectRows: ((Range<Int>) -> Void)?

    /// Where a gutter drag began, so a drag extends the selection rather than replacing
    /// it row by row.
    private var dragAnchorRow: Int?

    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        // `NSView.clipsToBounds` defaults to **false** since macOS 14. Rows are placed at
        // `yPos - scrollY`, so scrolled-past rows have negative y and were painting
        // straight over the workbench header above the gutter.
        clipsToBounds = true
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        clipsToBounds = true
    }

    private weak var observedClipView: NSClipView?

    /// Track the editor's scroll directly off its clip view.
    ///
    /// The offset used to arrive through SwiftUI state, which the editor publishes on the
    /// next run-loop pass — so the gutter was always a frame behind the text and appeared
    /// to slide against it while scrolling. Observing the clip view redraws in the same
    /// pass as the text.
    /// Resolves the editor's scroll view, which does not exist until the text controller
    /// has loaded its view — later than this gutter is first configured.
    var scrollViewProvider: (() -> NSScrollView?)?

    /// Attach to whatever scroll view exists *now*. Cheap and idempotent; the editor
    /// pushes this once its controller has loaded, and `draw` calls it as a backstop.
    ///
    /// Deliberately does not skip when already attached. Rebuilding the document
    /// re-inits the editor (`.id(session.revision)`), which brings a whole new scroll
    /// view and clip view — so an "already attached" short-circuit left the gutter
    /// observing a dead clip view and frozen from the first rebuild onward. `attach(to:)`
    /// is the one that no-ops when the clip view really is unchanged.
    func attachIfNeeded() {
        guard let scrollView = scrollViewProvider?() else { return }
        attach(to: scrollView)
    }

    func attach(to scrollView: NSScrollView) {
        let clipView = scrollView.contentView
        guard clipView !== observedClipView else { return }
        if let observedClipView {
            NotificationCenter.default.removeObserver(
                self, name: NSView.boundsDidChangeNotification, object: observedClipView)
        }
        clipView.postsBoundsChangedNotifications = true
        observedClipView = clipView
        NotificationCenter.default.addObserver(
            self, selector: #selector(clipViewDidScroll(_:)),
            name: NSView.boundsDidChangeNotification, object: clipView)
        scrollY = clipView.bounds.origin.y
        needsDisplay = true
    }

    @objc private func clipViewDidScroll(_ notification: Notification) {
        guard let clipView = notification.object as? NSClipView else { return }
        scrollY = clipView.bounds.origin.y
        needsDisplay = true
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    /// Real per-line geometry from the editor's layout manager, in document coordinates.
    ///
    /// The gutter used to place rows arithmetically at `index × rowHeight`, where
    /// `rowHeight` came from `NSLayoutManager.defaultLineHeight`. The editor types its
    /// lines with CoreText — `(ascent + descent + leading) × multiplier` — which is a
    /// different number, so the two drifted apart further down the document. Asking the
    /// layout manager removes the second opinion; `rowHeight` survives only as a
    /// fallback before the editor exists.
    var lineMetrics: ((Int) -> (yPos: CGFloat, height: CGFloat)?)?
    /// Row index at a document y, so the visible window is found the same way.
    var lineIndex: ((CGFloat) -> Int?)?
    /// Height of the blocks above a row. The layout manager folds that space into the
    /// row's height, so without it the number would centre against the block band
    /// instead of against its own line of text.
    var blockHeightAbove: ((Int) -> CGFloat)?
    /// The blocks above a row, so gap bands can put their expand arrows here.
    ///
    /// They live in the gutter — as GitHub's do — rather than in the band itself because
    /// `TextView.hitTest` returns the text view for any point inside it, so line-fragment
    /// subviews never receive a click. The gutter is our own view and already has mouse
    /// handling.
    var blocksAbove: ((Int) -> [Block])?
    /// Reveal part of a gap: `(file, collapsed range, from the top)`.
    var onExpandGap: ((SourceID, Range<Int>, Bool) -> Void)?

    /// A row's top edge in the gutter's own coordinates.
    private func yFor(_ index: Int) -> CGFloat {
        (lineMetrics?(index)?.yPos ?? CGFloat(index) * rowHeight) - scrollY
    }

    /// The rows overlapping a rect, clamped to the document.
    ///
    /// The walk is bounded by how many rows could physically fit in the rect. Each step
    /// queries the layout manager, and an unbounded walk over a 32k-row document ran that
    /// query thousands of times per draw — once per scroll event, which stalled
    /// scrolling outright. `rowHeight` is only an estimate of the real line height, so
    /// the bound carries generous slack rather than trusting it.
    private func visibleRange(in rect: NSRect) -> Range<Int> {
        guard rowHeight > 0, rowCount > 0 else { return 0..<0 }
        let top = rect.minY + scrollY
        let first = min(max(0, lineIndex?(top) ?? Int((top / rowHeight).rounded(.down))),
                        rowCount - 1)
        let capacity = Int((rect.height / rowHeight).rounded(.up)) * 2 + 4

        var last = first
        while last < min(rowCount, first + capacity), yFor(last) <= rect.maxY { last += 1 }
        return first..<min(last + 1, rowCount)
    }

    private static let leadingPad: CGFloat = 10
    private static let signColumn: CGFloat = 12
    private static let gap: CGFloat = 6
    private static let trailingPad: CGFloat = 8
    private static let fontSize: CGFloat = 12

    /// Everything the gutter draws with, resolved once per theme/font change.
    ///
    /// All of this used to be rebuilt inside `draw` — which runs per scroll event — and
    /// some of it per *row*: `Self.font` was a computed property doing an `NSFont(name:)`
    /// lookup, the sign got a freshly built attributes dictionary, and every tint
    /// allocated an `NSColor`. That is ~150 allocations and 40 text measurements a frame
    /// for values that only move when the theme or font does.
    private struct Style {
        let font: NSFont
        /// Monospace, so a number's width is its digit count times this.
        let digitAdvance: CGFloat
        let numberAttributes: [NSAttributedString.Key: Any]
        let addSignAttributes: [NSAttributedString.Key: Any]
        let removeSignAttributes: [NSAttributedString.Key: Any]
        let background: NSColor
        let addedTint: NSColor
        let removedTint: NSColor
        let conflictTint: NSColor
        let selectionTint: NSColor
        /// Cache key — the two things that change any of the above.
        let mode: ThemeMode
        let fontName: String?

        init() {
            let name = Theme.monoFontName
            let font = name.flatMap { NSFont(name: $0, size: DiffGutterView.fontSize) }
                ?? .monospacedSystemFont(ofSize: DiffGutterView.fontSize, weight: .regular)
            self.font = font
            self.fontName = name
            self.mode = Theme.mode
            self.digitAdvance = ("0" as NSString).size(withAttributes: [.font: font]).width
            self.numberAttributes = [
                .font: font, .foregroundColor: NSColor(hex24: Theme.Diff.gutterFg),
            ]
            self.addSignAttributes = [
                .font: font, .foregroundColor: NSColor(hex24: Theme.Diff.addition),
            ]
            self.removeSignAttributes = [
                .font: font, .foregroundColor: NSColor(hex24: Theme.Diff.deletion),
            ]
            self.background = NSColor(hex24: Theme.Diff.buffer)
            self.addedTint = NSColor(hex24: Theme.Diff.addition).withAlphaComponent(0.08)
            self.removedTint = NSColor(hex24: Theme.Diff.deletion).withAlphaComponent(0.08)
            self.conflictTint = NSColor(hex24: Theme.Diff.modified).withAlphaComponent(0.08)
            self.selectionTint = NSColor(hex24: Theme.Diff.modified).withAlphaComponent(0.22)
        }

        var isStale: Bool { mode != Theme.mode || fontName != Theme.monoFontName }
    }

    private static var cachedStyle = Style()

    private static var style: Style {
        if cachedStyle.isStale { cachedStyle = Style() }
        return cachedStyle
    }

    fileprivate static var font: NSFont { style.font }

    /// Total width for a document whose largest line number is `maxLineNumber`. Measured
    /// from the digits rather than guessed, so it doesn't clip past line 1000.
    static func width(maxLineNumber: Int) -> CGFloat {
        leadingPad + digitWidth(maxLineNumber) + gap + signColumn + trailingPad
    }

    private static func digitWidth(_ maxLineNumber: Int) -> CGFloat {
        CGFloat(String(max(1, maxLineNumber)).count) * style.digitAdvance
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        attachIfNeeded()
    }

    override func draw(_ dirtyRect: NSRect) {
        attachIfNeeded()
        // Resolved once here, never per row: this whole method runs per scroll event.
        let style = Self.style
        style.background.setFill()
        bounds.fill()

        // Monospace, so glyph height is uniform and the baseline offset is one division.
        let glyphHeight = ("0" as NSString).size(withAttributes: style.numberAttributes).height
        let numberWidth = CGFloat(String(max(1, maxLineNumber)).count) * style.digitAdvance

        for index in visibleRange(in: dirtyRect) {
            guard let row = row?(index) else { continue }
            // One layout query per row, not one per geometry question.
            let metrics = lineMetrics?(index)
            // The row's box includes any block band above it; the line itself is what's
            // left underneath, and that is what the number and tint belong to.
            let blockHeight = blockHeightAbove?(index) ?? 0
            let blockTop = (metrics?.yPos ?? CGFloat(index) * self.rowHeight) - scrollY
            let y = blockTop + blockHeight
            let rowHeight = (metrics?.height ?? self.rowHeight) - blockHeight
            drawExpandArrows(forRow: index, blockTop: blockTop, style: style)
            if let bg = tintColor(row.tint, style) {
                bg.setFill()
                NSRect(x: 0, y: y, width: bounds.width, height: rowHeight).fill()
            }
            if row.selected {
                style.selectionTint.setFill()
                NSRect(x: 0, y: y, width: bounds.width, height: rowHeight).fill()
            }

            let textY = y + (rowHeight - glyphHeight) / 2
            if let value = row.lineNumber {
                let text = String(value)
                // Right-aligned by digit count rather than by measuring the string.
                let width = CGFloat(text.count) * style.digitAdvance
                (text as NSString).draw(at: NSPoint(x: Self.leadingPad + numberWidth - width,
                                                    y: textY),
                                        withAttributes: style.numberAttributes)
            }

            if let sign = row.sign {
                let attributes = sign == "+" ? style.addSignAttributes : style.removeSignAttributes
                (String(sign) as NSString).draw(
                    at: NSPoint(x: Self.leadingPad + numberWidth + Self.gap, y: textY),
                    withAttributes: attributes)
            }
        }
    }

    /// Expand arrows for any gap band above `row`, laid out by `expandTargets` so drawing
    /// and hit testing cannot disagree.
    private func drawExpandArrows(forRow row: Int, blockTop: CGFloat, style: Style) {
        var y = blockTop
        for block in blocksAbove?(row) ?? [] {
            defer { y += block.height }
            guard case .hunkGap(_, let collapsed) = block.kind else { continue }
            let band = NSRect(x: 0, y: y, width: bounds.width, height: block.height)
            for (glyph, target) in Self.expandTargets(collapsed, in: band) {
                style.selectionTint.setFill()
                NSBezierPath(roundedRect: target, xRadius: 3, yRadius: 3).fill()
                let text = glyph as NSString
                let size = text.size(withAttributes: style.numberAttributes)
                text.draw(at: NSPoint(x: target.midX - size.width / 2,
                                      y: target.midY - size.height / 2),
                          withAttributes: style.numberAttributes)
            }
        }
    }

    /// Where a gap band's expand buttons sit, in gutter coordinates.
    static func expandTargets(_ collapsed: Range<Int>, in band: NSRect)
        -> [(glyph: String, rect: NSRect)] {
        let side: CGFloat = 16
        let y = band.midY - side / 2
        if HunkGaps.isFullyExpandable(collapsed) {
            return [("↕", NSRect(x: band.midX - side / 2, y: y, width: side, height: side))]
        }
        let gap: CGFloat = 3
        let total = side * 2 + gap
        return [
            ("↓", NSRect(x: band.midX - total / 2, y: y, width: side, height: side)),
            ("↑", NSRect(x: band.midX - total / 2 + side + gap, y: y, width: side, height: side)),
        ]
    }

    /// A gap-band expand button at a point, if any.
    private func expandTarget(at point: NSPoint)
        -> (source: SourceID, collapsed: Range<Int>, fromTop: Bool)? {
        guard rowHeight > 0, rowCount > 0 else { return nil }
        let documentY = point.y + scrollY
        guard let row = lineIndex?(documentY) ?? Int(exactly: (documentY / rowHeight).rounded(.down)),
              row >= 0, row < rowCount,
              let metrics = lineMetrics?(row) else { return nil }
        var y = metrics.yPos - scrollY
        for block in blocksAbove?(row) ?? [] {
            defer { y += block.height }
            guard case .hunkGap(let source, let collapsed) = block.kind else { continue }
            let band = NSRect(x: 0, y: y, width: bounds.width, height: block.height)
            for (glyph, target) in Self.expandTargets(collapsed, in: band)
            where target.contains(point) {
                return (source, collapsed, glyph != "↑")
            }
        }
        return nil
    }

    /// Softer than the text rows' tint — the gutter should read as chrome, not content.
    private func tintColor(_ tint: RowTint, _ style: Style) -> NSColor? {
        switch tint {
        case .none:     return nil
        case .added:    return style.addedTint
        case .removed:  return style.removedTint
        case .conflict: return style.conflictTint
        }
    }

    /// Click a row to select the whole line; drag to extend. The row index is arithmetic
    /// from the y, the inverse of `yFor`.
    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if let target = expandTarget(at: point) {
            onExpandGap?(target.source, target.collapsed, target.fromTop)
            return
        }
        guard let index = rowIndex(at: event) else { return super.mouseDown(with: event) }
        dragAnchorRow = index
        onSelectRows?(index..<(index + 1))
    }

    override func mouseDragged(with event: NSEvent) {
        guard let anchor = dragAnchorRow, let index = rowIndex(at: event) else { return }
        onSelectRows?(min(anchor, index)..<(max(anchor, index) + 1))
    }

    override func mouseUp(with event: NSEvent) { dragAnchorRow = nil }

    private func rowIndex(at event: NSEvent) -> Int? {
        guard rowHeight > 0, rowCount > 0 else { return nil }
        let point = convert(event.locationInWindow, from: nil)
        let documentY = point.y + scrollY
        let index = lineIndex?(documentY) ?? Int(documentY / rowHeight)
        return (index >= 0 && index < rowCount) ? index : nil
    }
}
