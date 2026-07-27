import AppKit
import CodeEditLanguages

/// Per-file, per-line syntax highlights for a stitched multibuffer.
///
/// A stitched document cannot be parsed as one file — its excerpts come from different
/// files and different languages and are discontinuous — so each source is parsed on
/// its own, exactly as the editor parses it. That is what makes the diff and the editor
/// agree: one tokenizer, not two.
///
/// Separate from ``MultiHighlighter`` so the parsing concern is isolated and can be
/// swapped for incremental clients once excerpt virtualization lands (spec §9 — N live
/// clients on a 50-file diff is the memory risk).
enum SourceHighlightCache {
    /// Highlight ranges for one file, bucketed by 0-based line, each range made
    /// line-relative so projecting onto a stitched line is pure addition.
    static func highlightsByLine(text: String, path: String) -> [Int: [HighlightRange]] {
        guard !text.isEmpty else { return [:] }
        let language = CodeLanguage.detectLanguageFrom(url: URL(fileURLWithPath: path))
        let starts = lineStartOffsets(text)
        guard !starts.isEmpty else { return [:] }

        var byLine: [Int: [HighlightRange]] = [:]
        for hl in TreeSitterClient.highlightRanges(string: text, language: language) {
            // The last line whose start is at or before the highlight's start.
            guard let line = lineIndex(for: hl.range.location, in: starts) else { continue }
            let relative = NSRange(location: hl.range.location - starts[line], length: hl.range.length)
            byLine[line, default: []].append(
                HighlightRange(range: relative, capture: hl.capture, modifiers: hl.modifiers)
            )
        }
        return byLine
    }

    /// UTF-16 offset of each line's first character. Lives on `EditMap`, which also has to
    /// maintain these incrementally as the user types.
    static func lineStartOffsets(_ text: String) -> [Int] { EditMap.lineStartOffsets(text) }

    /// Binary search for the line containing a UTF-16 offset.
    private static func lineIndex(for offset: Int, in starts: [Int]) -> Int? {
        guard let first = starts.first, offset >= first else { return nil }
        var low = 0, high = starts.count - 1
        while low < high {
            let mid = (low + high + 1) / 2
            if starts[mid] <= offset { low = mid } else { high = mid - 1 }
        }
        return low
    }
}

/// Highlights a stitched multibuffer by keeping one parse per source file and
/// projecting each file's ranges into stitched coordinates.
///
/// This is the fix for the original problem: the diff panel tokenized with
/// Highlight.js and remapped token colors by nearest-RGB distance, while the editor
/// used tree-sitter — so identical lines got different colors. Now there is one
/// tokenizer feeding both.
final class MultiHighlighter: HighlightProviding {
    /// The file, side, and 0-based source line a stitched row shows.
    ///
    /// A row-level anchor rather than a `StitchMap` lookup: excerpt line ranges are in
    /// stitched coordinates, so reading them as source lines painted each row with some
    /// other line's colors.
    private let anchor: (Int) -> (source: SourceID, side: DiffSide, line: Int)?
    /// A file's text on one side — the working copy, or the base blob.
    private let textForSource: (SourceID, DiffSide) -> String
    /// The stitched document's NSRange for a stitched line, or nil if not laid out.
    private let rangeForStitchedLine: (Int) -> NSRange?
    /// The stitched lines a document range covers.
    private let stitchedLineRange: (NSRange) -> Range<Int>?

    /// One parse per file **per side** — a removed line's colors come from the base blob,
    /// which is a different document from the working copy.
    private struct CacheKey: Hashable {
        let source: SourceID
        let side: DiffSide
    }
    private var cache: [CacheKey: [Int: [HighlightRange]]] = [:]

    /// LRU bookkeeping. Without a bound, scrolling a 287-file diff end to end kept a
    /// tree-sitter parse for every file (both sides) alive until the workbench closed.
    /// The cap is far above a viewport's worth of files, so it evicts history, not
    /// anything about to be redrawn.
    private var useCounter: UInt64 = 0
    private var lastUsed: [CacheKey: UInt64] = [:]
    private static let maxCachedParses = 24

    init(anchor: @escaping (Int) -> (source: SourceID, side: DiffSide, line: Int)?,
         textForSource: @escaping (SourceID, DiffSide) -> String,
         rangeForStitchedLine: @escaping (Int) -> NSRange?,
         stitchedLineRange: @escaping (NSRange) -> Range<Int>?) {
        self.anchor = anchor
        self.textForSource = textForSource
        self.rangeForStitchedLine = rangeForStitchedLine
        self.stitchedLineRange = stitchedLineRange
    }

    /// Drop a file's cached highlights (both sides) — call when its buffer changes.
    func invalidate(source: SourceID) {
        cache.removeValue(forKey: CacheKey(source: source, side: .new))
        cache.removeValue(forKey: CacheKey(source: source, side: .old))
    }

    func invalidateAll() { cache.removeAll() }

    /// Highlights for one line of a file's **base** blob, for the deletion bands — removed
    /// lines are not in the stitched document, so they can't come through
    /// `queryHighlightsFor`, but they are still code and should read as code.
    func baseHighlights(source: SourceID, line: Int) -> [HighlightRange] {
        highlights(for: source, side: .old, line: line)
    }

    // MARK: - HighlightProviding

    /// Language is per-excerpt, resolved from each file's extension, so there is
    /// nothing to configure globally.
    func setUp(textView: TextView, codeLanguage: CodeLanguage) { }

    func willApplyEdit(textView: TextView, range: NSRange) { }

    func applyEdit(textView: TextView, range: NSRange, delta: Int,
                   completion: @escaping @MainActor (Result<IndexSet, Error>) -> Void) {
        // Invalidate only the edited file; other excerpts are unaffected.
        if let lines = stitchedLineRange(range),
           let source = anchor(lines.lowerBound)?.source {
            invalidate(source: source)
        }
        let length = max(0, range.length + delta)
        completion(.success(IndexSet(integersIn: range.location..<(range.location + length + 1))))
    }

    func queryHighlightsFor(textView: TextView, range: NSRange,
                            completion: @escaping @MainActor (Result<[HighlightRange], Error>) -> Void) {
        guard let lines = stitchedLineRange(range) else {
            completion(.success([]))
            return
        }
        var out: [HighlightRange] = []
        for stitched in lines {
            guard let loc = anchor(stitched),
                  let target = rangeForStitchedLine(stitched) else { continue }
            for hl in highlights(for: loc.source, side: loc.side, line: loc.line) {
                // Re-base the file-local range onto this stitched line, clipping to it.
                guard hl.range.location < target.length else { continue }
                let length = min(hl.range.length, target.length - hl.range.location)
                guard length > 0 else { continue }
                out.append(HighlightRange(
                    range: NSRange(location: target.location + hl.range.location, length: length),
                    capture: hl.capture,
                    modifiers: hl.modifiers
                ))
            }
        }
        completion(.success(out.sorted { $0.range.location < $1.range.location }))
    }

    /// Per-file, per-side, per-line highlights, parsing and caching on first use.
    private func highlights(for source: SourceID, side: DiffSide, line: Int) -> [HighlightRange] {
        let key = CacheKey(source: source, side: side)
        useCounter += 1
        lastUsed[key] = useCounter
        if let cached = cache[key] { return cached[line] ?? [] }
        let byLine = SourceHighlightCache.highlightsByLine(text: textForSource(source, side),
                                                           path: source.path)
        cache[key] = byLine
        evictIfNeeded()
        return byLine[line] ?? []
    }

    /// Drop the least recently used parses once over the cap.
    private func evictIfNeeded() {
        while cache.count > Self.maxCachedParses {
            guard let oldest = lastUsed.filter({ cache[$0.key] != nil })
                .min(by: { $0.value < $1.value })?.key else { return }
            cache.removeValue(forKey: oldest)
            lastUsed.removeValue(forKey: oldest)
        }
    }
}
