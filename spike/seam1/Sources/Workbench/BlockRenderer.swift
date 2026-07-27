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

    private var style: RowStyle = .plain
    /// The fragment's range within its line — `_xPos` is line-relative, so word spans
    /// need this to position correctly on wrapped lines.
    private var fragmentRange: NSRange = .init(location: 0, length: 0)

    override func setLineFragment(_ newFragment: LineFragment,
                                  fragmentRange: NSRange,
                                  renderer: LineFragmentRenderer) {
        super.setLineFragment(newFragment, fragmentRange: fragmentRange, renderer: renderer)
        self.fragmentRange = fragmentRange
        self.style = styleProvider?(newFragment) ?? .plain
        needsDisplay = true
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        style = .plain
    }

    override func draw(_ dirtyRect: NSRect) {
        if let bg = Self.rowColor(for: style.tint) {
            bg.setFill()
            bounds.fill()
            drawWordSpans()
        }
        super.draw(dirtyRect)   // text last, so it sits on top of the tint
    }

    /// Word tints, positioned by asking the fragment for each offset's x — so they line
    /// up with the glyphs whatever the font.
    private func drawWordSpans() {
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
            NSRect(x: x0, y: 0, width: max(1, x1 - x0), height: bounds.height).fill()
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

    init(stitchedLineForOffset: @escaping (Int) -> Int?,
         styleForStitchedLine: @escaping (Int) -> RowStyle) {
        self.stitchedLineForOffset = stitchedLineForOffset
        self.styleForStitchedLine = styleForStitchedLine
    }

    func lineFragmentView(for lineFragment: LineFragment) -> LineFragmentView {
        let view = DiffRowView()
        view.styleProvider = { [stitchedLineForOffset, styleForStitchedLine] fragment in
            guard let line = stitchedLineForOffset(fragment.documentRange.location) else {
                return .plain
            }
            return styleForStitchedLine(line)
        }
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
