import AppKit

/// A diff row's background treatment.
enum RowTint: Equatable {
    case none, added, removed, conflict
    /// The two sides of a merge conflict, tinted apart so a glance tells you which is which
    /// without reading the marker above it.
    case conflictOurs, conflictTheirs
}

/// What a row should look like: its tint plus the word-level spans inside it.
struct RowStyle: Equatable {
    let tint: RowTint
    let wordSpans: [WordSpan]

    static let plain = RowStyle(tint: .none, wordSpans: [])
}

/// One line of a deletion band, measured and coloured once so `draw` does no layout.
struct DeletedLineRow {
    let text: NSAttributedString
    let tint: RowTint
    /// Changed-word spans as x offsets in points, measured against `text` itself — the
    /// theme gives each token its own font, so multiplying a character index by one
    /// character's advance drifts further right the longer the line.
    let wordSpans: [(x: CGFloat, width: CGFloat)]
}

/// Geometry for the two conflict bands.
///
/// In one place because two views need it — `DiffRowView` paints the marker rules and
/// `WorkbenchOverlay` draws *and* hit-tests the controls strip.
/// Three opinions about where a row sits is how the gutter drifted against the text for two
/// days; the rule since is exactly one.
enum ConflictBandMetrics {
    /// The accept buttons get their own row, and the `<<<<<<<` marker its own line below
    /// them — the way VSCode stacks its action links above the marker. Sharing one row made
    /// the marker text and the buttons compete for the same horizontal space, so the buttons
    /// pushed the marker out of view.
    static let buttonRowHeight: CGFloat = 24

    static var controlsHeight: CGFloat { buttonRowHeight + WorkbenchMetrics.rowHeight }

    /// The buttons row and the marker line inside a controls band.
    static func controlsLayout(_ band: NSRect) -> (buttons: NSRect, marker: NSRect) {
        let buttons = NSRect(x: band.minX, y: band.minY,
                             width: band.width, height: buttonRowHeight)
        return (buttons, NSRect(x: band.minX, y: band.minY + buttonRowHeight,
                                width: band.width,
                                height: max(0, band.height - buttonRowHeight)))
    }
    /// A `=======` / `>>>>>>>` rule. One text line tall, like the code around it.
    static var markerHeight: CGFloat { WorkbenchMetrics.rowHeight }
}

/// A line fragment that paints a full-width diff tint behind its text, plus stronger
/// word-level tints for the parts that actually changed.
///
/// Full-bleed: the tint fills the fragment's whole width, so rows read as bands rather
/// than as highlighted text.
///
/// The style is resolved in ``setLineFragment(_:fragmentRange:renderer:)`` rather than
/// at init because the layout manager **recycles** these views — resolving once at
/// creation leaves a row wearing the previous row's tint after a scroll.
final class DiffRowView: LineFragmentView {
    /// Resolves the style for a fragment. Injected so this view knows nothing about
    /// the session (which would retain it through the text view).
    var styleProvider: ((LineFragment) -> RowStyle)?
    /// Blocks sitting immediately above this row, drawn in the space `BlockRenderer`
    /// reserved by inflating the fragment.
    var blockProvider: ((LineFragment) -> [Block])?
    /// Display name for a block's file, resolved by the session (repo-relative).
    var displayName: ((SourceID) -> String)?
    /// A deletion band's lines, already coloured and measured.
    var deletedLines: ((Block) -> [DeletedLineRow])?
    /// Full document width, so bands and row tints bleed the whole row instead of
    /// stopping where the line's text happens to end.
    var rowWidth: (() -> CGFloat)?

    private var blocks: [Block] = []
    private var blockHeight: CGFloat { blocks.reduce(0) { $0 + $1.height } }

    private var style: RowStyle = .plain
    /// The fragment's range within its line — `_xPos` is line-relative, so word spans
    /// need this to position correctly on wrapped lines.
    private var fragmentRange: NSRange = .init(location: 0, length: 0)

    override func setLineFragment(_ newFragment: LineFragment,
                                  fragmentRange: NSRange,
                                  renderer: LineFragmentRenderer) {
        super.setLineFragment(newFragment, fragmentRange: fragmentRange, renderer: renderer)
        // super sizes the view to the *text* width, which left tints and block bands
        // stopping wherever the line happened to end. Only `setLineFragment` sets the
        // size — the layout manager sets origin only — so widening here holds.
        if let full = rowWidth?(), full > frame.width {
            frame.size.width = full
        }
        self.fragmentRange = fragmentRange
        self.style = styleProvider?(newFragment) ?? .plain
        self.blocks = blockProvider?(newFragment) ?? []
        needsDisplay = true
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        style = .plain
        blocks = []
    }

    override func draw(_ dirtyRect: NSRect) {
        // Blocks occupy the top of the fragment; `BlockRenderer` grew it by exactly
        // their height, and pushed the text's baseline down past them.
        let textTop = blockHeight
        if let bg = Self.rowColor(for: style.tint) {
            bg.setFill()
            NSRect(x: 0, y: textTop, width: bounds.width, height: bounds.height - textTop).fill()
            drawWordSpans(below: textTop)
        }
        // A deletion band is as tall as the run it shows, so deleting a hundred lines makes
        // one row a hundred lines tall. Bound the work to what is on screen — but by
        // `visibleRect`, **never** by `dirtyRect` alone: AppKit hands a view this tall a
        // partial dirty rect, and on a fragment view that has just scrolled into existence
        // there is no earlier content to preserve, so everything skipped stayed blank. The
        // union means a pass can only ever paint more than asked, never less.
        let onscreen = visibleRect.isEmpty ? bounds : visibleRect.union(dirtyRect)
        drawBlocks(in: onscreen)
        super.draw(dirtyRect)   // text last, so it sits on top of the tint
    }

    private func drawBlocks(in onscreen: NSRect) {
        var y: CGFloat = 0
        for block in blocks {
            let rect = NSRect(x: 0, y: y, width: bounds.width, height: block.height)
            y += block.height
            guard rect.intersects(onscreen) else { continue }
            switch block.kind {
            case .fileHeader(let source):
                drawFileHeader(source, in: rect)
            case .sectionHeader(let title):
                drawSectionHeader(title, in: rect)
            case .hunkGap(_, let collapsed):
                drawHunkGap(collapsed, in: rect)
            case .deletedLines:
                drawDeletedLines(block, in: rect, onscreen: onscreen)
            case .conflictMarker(_, _, let label, let side, let isEnd):
                drawConflictMarker(label: label, side: side, isEnd: isEnd, in: rect)
            case .reviewNote(_, let origin, let header, let body):
                drawReviewNote(origin: origin, header: header, body: body, in: rect)
            case .conflictControls:
                // Drawn by `WorkbenchOverlay`, which also hit-tests it. A line-fragment
                // subview never receives a click (`TextView.hitTest` returns the text view
                // for any point inside it), and painting it here while another view owned
                // its buttons would be two opinions about where they are.
                break
            default:
                break   // rendered markdown arrives with ADR 0019
            }
        }
    }

    /// A run of removed lines: one tinted row each, drawn as text rather than as document
    /// lines because a removed line exists in no file on disk and so has no row of its own.
    private func drawDeletedLines(_ block: Block, in band: NSRect, onscreen: NSRect) {
        let lines = deletedLines?(block) ?? []
        guard !lines.isEmpty else { return }
        // Divide the reserved space rather than re-deriving a row height, so the band's
        // own rows, and the gutter numbers beside them, cannot disagree about where a
        // line sits — the mistake that put the gutter and the text out of step once.
        let rowHeight = band.height / CGFloat(lines.count)
        // Resolved once for the band, never per line: this method runs per frame, and this
        // was a font lookup plus a text measurement.
        let glyphHeight = Self.bandGlyphHeight
        let strong = Self.wordColor(for: .removed)

        for (index, line) in lines.enumerated() {
            let rect = NSRect(x: 0, y: band.minY + CGFloat(index) * rowHeight,
                              width: band.width, height: rowHeight)
            guard rect.intersects(onscreen) else { continue }
            if let bg = Self.rowColor(for: line.tint) {
                bg.setFill()
                rect.fill()
            }
            if let strong, !line.wordSpans.isEmpty {
                strong.setFill()
                for span in line.wordSpans {
                    NSRect(x: span.x, y: rect.minY, width: span.width, height: rect.height).fill()
                }
            }
            line.text.draw(at: NSPoint(x: 0, y: rect.midY - glyphHeight / 2))
        }
    }

    /// A `=======` or `>>>>>>> branch` rule.
    ///
    /// The marker text is drawn, not parsed — git's own shape is the one every developer
    /// already reads without being taught, so the resolver wears it even though the data
    /// underneath comes from a three-way merge of the index's stage blobs.
    private func drawConflictMarker(label: String, side: MergeSide?, isEnd: Bool,
                                   in band: NSRect) {
        // The closer wears the colour of the block it closes, so the two sides read as
        // bounded regions rather than as one long tinted run. The `=======` between them
        // belongs to neither and stays neutral.
        let accent = NSColor(hex24: side == .ours ? Theme.Diff.addition : Theme.Diff.modified)
        accent.withAlphaComponent(side == nil ? 0.10 : 0.22).setFill()
        band.fill()

        let text = (isEnd ? ">>>>>>> \(label)" : "=======") as NSString
        let attributes: [NSAttributedString.Key: Any] = [
            .font: WorkbenchMetrics.font,
            .foregroundColor: accent,
        ]
        let size = text.size(withAttributes: attributes)
        text.draw(at: NSPoint(x: 0, y: band.midY - size.height / 2), withAttributes: attributes)
    }

    /// Glyph height for band text, cached against the font.
    private static var cachedGlyphHeight: (font: NSFont, height: CGFloat)?

    private static var bandGlyphHeight: CGFloat {
        let font = WorkbenchMetrics.font
        if let cached = cachedGlyphHeight, cached.font == font { return cached.height }
        let height = ("0" as NSString).size(withAttributes: [.font: font]).height
        cachedGlyphHeight = (font, height)
        return height
    }

    /// "N lines skipped", with the click targets that reveal them ten at a time.
    private func drawHunkGap(_ collapsed: Range<Int>, in rect: NSRect) {
        NSColor(hex24: Theme.Diff.hover).setFill()
        rect.fill()

        let count = collapsed.count
        let label = "\(count) line\(count == 1 ? "" : "s") skipped"
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 10.5, weight: .medium),
            .foregroundColor: NSColor(hex24: Theme.Diff.gutterFg),
        ]
        // Left-aligned, not centred: the row is as wide as the whole document, so a
        // centred label sits far off the right of the viewport. The expand arrows live
        // in the gutter (see `DiffGutterView.expandTargets`).
        let text = label as NSString
        let size = text.size(withAttributes: attributes)
        text.draw(at: NSPoint(x: 12, y: rect.midY - size.height / 2), withAttributes: attributes)
    }

    /// A review note under the line it is about.
    ///
    /// The two origins are told apart three ways, not one — colour alone fails for the ~8%
    /// of men with a colour vision deficiency, and these two are a blue and a violet:
    /// `mine` gets a square marker and a "you" label, `github` an octagonal one and the
    /// author's handle. The accent bar and tint reinforce it.
    private func drawReviewNote(origin: ReviewNoteOrigin, header: String, body: String,
                               in band: NSRect) {
        let accent = origin == .mine
            ? NSColor(hex24: Theme.Diff.modified)      // blue — bound for the agent
            : NSColor(hex24: 0xA371F7)                 // violet — somebody else's review
        let width = min(band.width, WorkbenchSession.noteWrapWidth)
        let card = NSRect(x: 0, y: band.minY, width: width, height: band.height)

        accent.withAlphaComponent(0.10).setFill()
        card.fill()
        accent.setFill()
        NSRect(x: 0, y: card.minY, width: 2, height: card.height).fill()

        let marker = origin == .mine ? "▪" : "⬢"
        let headerText = "\(marker) \(origin == .mine ? "you" : "")\(header)" as NSString
        headerText.draw(at: NSPoint(x: 10, y: card.minY + 4), withAttributes: [
            .font: NSFont.systemFont(ofSize: 10, weight: .semibold),
            .foregroundColor: accent,
        ])
        (body as NSString).draw(
            with: NSRect(x: 10, y: card.minY + 16, width: width - 24, height: card.height - 20),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: NSFont.systemFont(ofSize: 11),
                         .foregroundColor: NSColor(hex24: Theme.Code.text)])
    }

    /// A divider naming the group of files below it, louder than a file header so the two
    /// halves of the working tree read as separate.
    private func drawSectionHeader(_ title: String, in rect: NSRect) {
        let accent = NSColor(hex24: Theme.Diff.addition)
        accent.withAlphaComponent(0.14).setFill()
        rect.fill()
        accent.setFill()
        NSRect(x: 0, y: rect.maxY - 1, width: rect.width, height: 1).fill()
        let text = title as NSString
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 10, weight: .bold),
            .foregroundColor: accent,
        ]
        let size = text.size(withAttributes: attributes)
        text.draw(at: NSPoint(x: 10, y: rect.midY - size.height / 2), withAttributes: attributes)
    }

    /// A full-bleed band naming the file, so files don't run into each other.
    private func drawFileHeader(_ source: SourceID, in rect: NSRect) {
        NSColor(hex24: Theme.Diff.hover).setFill()
        rect.fill()
        NSColor(hex24: Theme.Diff.separator).setFill()
        NSRect(x: 0, y: rect.maxY - 1, width: rect.width, height: 1).fill()

        let name = displayName?(source) ?? source.path
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
            .foregroundColor: NSColor(hex24: Theme.Code.text),
        ]
        let text = name as NSString
        let size = text.size(withAttributes: attributes)
        text.draw(at: NSPoint(x: 8, y: rect.midY - size.height / 2), withAttributes: attributes)
    }

    /// Word tints, positioned by asking the fragment for each offset's x — so they line
    /// up with the glyphs whatever the font.
    private func drawWordSpans(below textTop: CGFloat) {
        guard let fragment = lineFragment,
              !style.wordSpans.isEmpty,
              let strong = Self.wordColor(for: style.tint) else { return }
        let start = fragmentRange.location
        let end = start + fragmentRange.length
        let originX = fragment._xPos(for: start)
        strong.setFill()
        for span in style.wordSpans where span.changed {
            // Clip the span to this fragment; a wrapped line splits spans across rows.
            let lower = max(span.range.lowerBound, start)
            let upper = min(span.range.upperBound, end)
            guard lower < upper else { continue }
            let x0 = fragment._xPos(for: lower) - originX
            let x1 = fragment._xPos(for: upper) - originX
            NSRect(x: x0, y: textTop, width: max(1, x1 - x0),
                   height: bounds.height - textTop).fill()
        }
    }

    private static func rowColor(for tint: RowTint) -> NSColor? {
        switch tint {
        case .none:     return nil
        case .added:    return NSColor(hex24: Theme.Diff.addition).withAlphaComponent(0.14)
        case .removed:  return NSColor(hex24: Theme.Diff.deletion).withAlphaComponent(0.14)
        case .conflict: return NSColor(hex24: Theme.Diff.modified).withAlphaComponent(0.14)
        case .conflictOurs:
            return NSColor(hex24: Theme.Diff.addition).withAlphaComponent(0.12)
        case .conflictTheirs:
            return NSColor(hex24: Theme.Diff.modified).withAlphaComponent(0.14)
        }
    }

    private static func wordColor(for tint: RowTint) -> NSColor? {
        switch tint {
        case .none:     return nil
        case .added:    return NSColor(hex24: Theme.Diff.wordAdd).withAlphaComponent(0.55)
        case .removed:  return NSColor(hex24: Theme.Diff.wordDel).withAlphaComponent(0.55)
        case .conflict:
            return NSColor(hex24: Theme.Diff.modified).withAlphaComponent(0.28)
        // Each side's changed words brighten in that side's own colour, so the highlight
        // reinforces which block you are reading rather than fighting it.
        case .conflictOurs:
            return NSColor(hex24: Theme.Diff.wordAdd).withAlphaComponent(0.55)
        case .conflictTheirs:
            return NSColor(hex24: Theme.Diff.modified).withAlphaComponent(0.34)
        }
    }
}

/// Supplies tinted ``DiffRowView``s to the layout manager.
///
/// Style lookup is injected as closures rather than reading a session directly: the
/// layout manager holds this delegate, and the session holds the text view, so a
/// strong reference here would close a retain cycle. Built the same way CESE's own
/// minimap is (see `Minimap/MinimapLineRenderer.swift`).
final class BlockRenderer: TextLayoutManagerRenderDelegate {
    /// Document offset → stitched line, or nil if the offset maps to no line.
    private let stitchedLineForOffset: (Int) -> Int?
    /// Stitched line → how that row should be painted.
    private let styleForStitchedLine: (Int) -> RowStyle
    /// Non-text rows sitting immediately above a stitched line.
    private let blocksForStitchedLine: (Int) -> [Block]
    /// Repo-relative name for a block's file.
    private let displayName: (SourceID) -> String
    /// A deletion band's rendered lines.
    private let deletedLines: (Block) -> [DeletedLineRow]
    private let rowWidth: () -> CGFloat
    /// Reveal part of a gap: `(file, collapsed range, from the top)`.
    private let onExpandGap: (SourceID, Range<Int>, Bool) -> Void

    init(stitchedLineForOffset: @escaping (Int) -> Int?,
         styleForStitchedLine: @escaping (Int) -> RowStyle,
         blocksForStitchedLine: @escaping (Int) -> [Block] = { _ in [] },
         displayName: @escaping (SourceID) -> String = { $0.path },
         deletedLines: @escaping (Block) -> [DeletedLineRow] = { _ in [] },
         rowWidth: @escaping () -> CGFloat = { 0 },
         onExpandGap: @escaping (SourceID, Range<Int>, Bool) -> Void = { _, _, _ in }) {
        self.onExpandGap = onExpandGap
        self.stitchedLineForOffset = stitchedLineForOffset
        self.styleForStitchedLine = styleForStitchedLine
        self.blocksForStitchedLine = blocksForStitchedLine
        self.displayName = displayName
        self.deletedLines = deletedLines
        self.rowWidth = rowWidth
    }

    /// Reserve room above a row for its blocks.
    ///
    /// Grows the line's first fragment, following the pattern `MinimapLineRenderer`
    /// establishes: `lineFragments` is a sum tree that caches each fragment's height, so
    /// mutating a fragment **must** be paired with `update(atOffset:delta:deltaHeight:)`
    /// or every y position below it goes stale.
    ///
    /// Both `height` and `scaledHeight` grow. `height` is what
    /// `LineFragmentRenderer` measures the baseline down from, so raising it puts the
    /// text at the *bottom* of the taller row and leaves the reserved space above it —
    /// raising only `scaledHeight` would centre the text and split the space in two.
    func prepareForDisplay( // swiftlint:disable:this function_parameter_count
        textLine: TextLine,
        displayData: TextLine.DisplayData,
        range: NSRange,
        stringRef: NSTextStorage,
        markedRanges: MarkedRanges?,
        attachments: [AnyTextAttachment]
    ) {
        textLine.prepareForDisplay(displayData: displayData, range: range, stringRef: stringRef,
                                   markedRanges: markedRanges, attachments: attachments)

        guard let line = stitchedLineForOffset(range.location) else { return }
        let extra = blocksForStitchedLine(line).reduce(0) { $0 + $1.height }
        guard extra > 0, let first = textLine.lineFragments.first else { return }

        textLine.lineFragments.update(atOffset: first.range.location, delta: 0, deltaHeight: extra)
        first.data.height += extra
        first.data.scaledHeight += extra
        // Tells the caret and selection rects that this space is decoration, not text.
        first.data.topInset = extra
    }

    func lineFragmentView(for lineFragment: LineFragment) -> LineFragmentView {
        let view = DiffRowView()
        view.styleProvider = { [stitchedLineForOffset, styleForStitchedLine] fragment in
            guard let line = stitchedLineForOffset(fragment.documentRange.location) else {
                return .plain
            }
            return styleForStitchedLine(line)
        }
        view.blockProvider = { [stitchedLineForOffset, blocksForStitchedLine] fragment in
            guard let line = stitchedLineForOffset(fragment.documentRange.location) else {
                return []
            }
            return blocksForStitchedLine(line)
        }
        view.displayName = displayName
        view.deletedLines = deletedLines
        view.rowWidth = rowWidth
        return view
    }

    /// nil defers to the text view's own metric, which reads `Theme.lineHeightMultiple`.
    func estimatedLineHeight() -> CGFloat? { nil }
}

extension NSColor {
    /// #RRGGBB from a 24-bit integer, matching `Color(hex:)` in Theme.swift.
    ///
    /// Distinct label from the vendored editor's `init(hex: Int, alpha:)` so the two
    /// can coexist without an ambiguity at every call site.
    convenience init(hex24: UInt32) {
        self.init(srgbRed: CGFloat((hex24 >> 16) & 0xFF) / 255,
                  green: CGFloat((hex24 >> 8) & 0xFF) / 255,
                  blue: CGFloat(hex24 & 0xFF) / 255,
                  alpha: 1)
    }
}
