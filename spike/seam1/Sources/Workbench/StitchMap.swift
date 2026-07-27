import Foundation

/// A file participating in a stitched multibuffer, identified by absolute path.
struct SourceID: Hashable {
    let path: String
    init(_ path: String) { self.path = path }
}

/// Why a slice of a file is on screen. `.context` is unchanged surrounding code,
/// `.hunk` is changed code, `.conflict` is an unresolved merge region.
enum ExcerptKind: Equatable { case context, hunk, conflict }

/// One contiguous slice of one file. `lineRange` is 0-based source line indices.
struct Excerpt: Equatable, Identifiable {
    let id: String
    let source: SourceID
    var lineRange: Range<Int>
    let kind: ExcerptKind
}

/// The multibuffer's excerpt list plus bidirectional line mapping.
///
/// Pure and line-based on purpose: byte offsets and layout belong to the AppKit
/// layer, which reads this. Excerpt order is presentation order and is preserved
/// exactly as given — callers decide grouping (by directory, by staged/unstaged),
/// not this type.
struct StitchMap: Equatable {
    private(set) var excerpts: [Excerpt]

    init(excerpts: [Excerpt]) { self.excerpts = excerpts }

    var totalLines: Int { excerpts.reduce(0) { $0 + $1.lineRange.count } }

    /// The (file, source line) a stitched line shows, or nil if out of range.
    func sourceLocation(atStitchedLine line: Int) -> (source: SourceID, line: Int)? {
        guard let (excerpt, offset) = locate(line) else { return nil }
        return (excerpt.source, excerpt.lineRange.lowerBound + offset)
    }

    /// Where a source line appears in the stitched document, or nil if it isn't
    /// shown. The first matching excerpt wins when a line appears twice.
    func stitchedLine(for source: SourceID, line: Int) -> Int? {
        var cursor = 0
        for e in excerpts {
            if e.source == source, e.lineRange.contains(line) {
                return cursor + (line - e.lineRange.lowerBound)
            }
            cursor += e.lineRange.count
        }
        return nil
    }

    /// The excerpt owning a stitched line, or nil if out of range.
    func excerpt(atStitchedLine line: Int) -> Excerpt? { locate(line)?.excerpt }

    /// Absorb an edit that changed `source`'s line count at `atLine`. The excerpt
    /// containing the edit grows or shrinks; later excerpts *in the same file*
    /// slide. Other files are untouched.
    mutating func applyEdit(in source: SourceID, atLine line: Int, lineDelta: Int) {
        guard lineDelta != 0 else { return }
        for idx in excerpts.indices where excerpts[idx].source == source {
            let r = excerpts[idx].lineRange
            if r.contains(line) {
                // Clamp: deleting more lines than the excerpt holds must collapse it,
                // not invert the range (which would trap).
                excerpts[idx].lineRange = r.lowerBound..<max(r.lowerBound, r.upperBound + lineDelta)
            } else if r.lowerBound > line {
                let lower = max(0, r.lowerBound + lineDelta)
                excerpts[idx].lineRange = lower..<max(lower, r.upperBound + lineDelta)
            }
        }
    }

    /// The excerpt containing a stitched line and the line's offset within it.
    private func locate(_ line: Int) -> (excerpt: Excerpt, offset: Int)? {
        guard line >= 0 else { return nil }
        var cursor = 0
        for e in excerpts {
            let count = e.lineRange.count
            if line < cursor + count { return (e, line - cursor) }
            cursor += count
        }
        return nil
    }
}
