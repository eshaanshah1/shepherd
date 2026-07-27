import AppKit

/// A diff row's background treatment.
enum RowTint: Equatable { case none, added, removed, conflict }

/// What a row should look like: its tint plus the word-level spans inside it.
struct RowStyle: Equatable {
    let tint: RowTint
    let wordSpans: [WordSpan]

    static let plain = RowStyle(tint: .none, wordSpans: [])
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
        drawBlocks()
        super.draw(dirtyRect)   // text last, so it sits on top of the tint
    }

    private func drawBlocks() {
        var y: CGFloat = 0
        for block in blocks {
            let rect = NSRect(x: 0, y: y, width: bounds.width, height: block.height)
            switch block.kind {
            case .fileHeader(let source):
                drawFileHeader(source, in: rect)
            case .hunkGap(_, let collapsed):
                drawHunkGap(collapsed, in: rect)
            default:
                break   // other kinds arrive with W2/W3
            }
            y += block.height
        }
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
        }
    }

    private static func wordColor(for tint: RowTint) -> NSColor? {
        switch tint {
        case .none:     return nil
        case .added:    return NSColor(hex24: Theme.Diff.wordAdd).withAlphaComponent(0.55)
        case .removed:  return NSColor(hex24: Theme.Diff.wordDel).withAlphaComponent(0.55)
        case .conflict: return NSColor(hex24: Theme.Diff.modified).withAlphaComponent(0.28)
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
    private let rowWidth: () -> CGFloat
    /// Reveal part of a gap: `(file, collapsed range, from the top)`.
    private let onExpandGap: (SourceID, Range<Int>, Bool) -> Void

    init(stitchedLineForOffset: @escaping (Int) -> Int?,
         styleForStitchedLine: @escaping (Int) -> RowStyle,
         blocksForStitchedLine: @escaping (Int) -> [Block] = { _ in [] },
         displayName: @escaping (SourceID) -> String = { $0.path },
         rowWidth: @escaping () -> CGFloat = { 0 },
         onExpandGap: @escaping (SourceID, Range<Int>, Bool) -> Void = { _, _, _ in }) {
        self.onExpandGap = onExpandGap
        self.stitchedLineForOffset = stitchedLineForOffset
        self.styleForStitchedLine = styleForStitchedLine
        self.blocksForStitchedLine = blocksForStitchedLine
        self.displayName = displayName
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
