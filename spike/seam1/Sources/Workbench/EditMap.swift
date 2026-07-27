import Foundation

/// A stitched edit resolved onto one file's lines.
struct FileEdit: Equatable {
    let path: String
    /// 0-based source lines the edit replaces. Contiguous, and always the new side.
    let lines: Range<Int>
}

/// Maps edits made in the stitched document back onto the files they came from.
///
/// This is the mapping W2.0 was built to make possible — every row is a real line of a real
/// file, so an edit has somewhere to go — and it is the one place in the workbench where a
/// mistake writes wrong bytes into someone's source. Pure, so it is testable without a text
/// view.
enum EditMap {

    /// The file and 0-based line range `rows` covers, or nil when the edit must be refused.
    ///
    /// Refused unless the rows are one contiguous ascending run of a single file's new-side
    /// lines. A file's rows are **discontinuous** — the hunks skip whatever is unchanged
    /// between them — so an edit spanning two hunks would rewrite every hidden line in the
    /// gap. Backspacing the two rows together is not an edit this document can express, and
    /// guessing is how you corrupt a file.
    static func fileEdit(rows: Range<Int>, origins: [RowOrigin]) -> FileEdit? {
        guard !rows.isEmpty, rows.lowerBound >= 0, rows.upperBound <= origins.count,
              let firstLine = origins[rows.lowerBound].newLineNumber else { return nil }
        let path = origins[rows.lowerBound].path
        var expected = firstLine
        for row in rows {
            guard origins[row].path == path, origins[row].newLineNumber == expected else {
                return nil
            }
            expected += 1
        }
        // 1-based line numbers in, 0-based range out.
        return FileEdit(path: path, lines: (firstLine - 1)..<(expected - 1))
    }

    /// How many rows an edit adds (positive) or removes (negative).
    ///
    /// The replaced span covers `rows.count` rows, so it contains `rows.count - 1` newlines;
    /// the replacement contributes one row per newline plus one.
    static func rowDelta(replacing rows: Range<Int>, with replacement: String) -> Int {
        newlineCount(replacement) + 1 - rows.count
    }

    /// The row table after an edit replaced `rows` with `newRowCount` rows.
    ///
    /// The replacement rows carry the edited file's path but **no diff line** (`lineIndex`
    /// of -1): a line you just typed is in no hunk, so it must not be addressable as one.
    /// Rows of the same file below the edit are renumbered; other files only move index.
    static func rowsAfterEdit(_ origins: [RowOrigin], replacing rows: Range<Int>,
                              withRowCount newRowCount: Int) -> [RowOrigin] {
        guard !rows.isEmpty, rows.lowerBound >= 0, rows.upperBound <= origins.count,
              newRowCount >= 0 else { return origins }
        let template = origins[rows.lowerBound]
        let firstLine = template.newLineNumber ?? 1

        let replacements = (0..<newRowCount).map { offset in
            RowOrigin(path: template.path, hunkIndex: template.hunkIndex, lineIndex: -1,
                      kind: .context, oldLineNumber: nil, newLineNumber: firstLine + offset)
        }

        var out = Array(origins[origins.startIndex..<rows.lowerBound])
        out.append(contentsOf: replacements)
        // Everything below the edit keeps its identity; only same-file line numbers move.
        let delta = newRowCount - rows.count
        for origin in origins[rows.upperBound...] {
            guard origin.path == template.path, let number = origin.newLineNumber else {
                out.append(origin)
                continue
            }
            out.append(RowOrigin(path: origin.path, hunkIndex: origin.hunkIndex,
                                 lineIndex: origin.lineIndex, kind: origin.kind,
                                 oldLineNumber: origin.oldLineNumber,
                                 newLineNumber: number + delta,
                                 deletedRefs: origin.deletedRefs))
        }
        return out
    }

    /// The line-start offsets of the whole document after an edit, without rescanning it.
    ///
    /// Rescanning is O(document) and this runs per keystroke; on a 32k-row diff that is a
    /// full pass over ~1MB of text for one typed character. Offsets before the edit are
    /// untouched, the edited rows' starts are recomputed from the replacement, and
    /// everything after shifts by the character delta.
    ///
    /// - Parameters:
    ///   - starts: line-start offsets before the edit.
    ///   - rows: the rows the edit replaced.
    ///   - editStart: UTF-16 offset the replacement begins at.
    ///   - removedLength: UTF-16 length replaced.
    ///   - replacement: the inserted text.
    static func lineStartsAfterEdit(_ starts: [Int], replacing rows: Range<Int>,
                                    editStart: Int, removedLength: Int,
                                    replacement: String) -> [Int] {
        guard !rows.isEmpty, rows.lowerBound >= 0, rows.upperBound <= starts.count else {
            return starts
        }
        let charDelta = (replacement as NSString).length - removedLength

        // The first edited row keeps its start; the rows it grew into begin after each
        // newline in the replacement.
        var inserted: [Int] = []
        var cursor = editStart
        for unit in Array(replacement.utf16) {
            cursor += 1
            if unit == 0x0A { inserted.append(cursor) }   // "\n"
        }

        var out = Array(starts[starts.startIndex...rows.lowerBound])
        out.append(contentsOf: inserted)
        out.append(contentsOf: starts[rows.upperBound...].map { $0 + charDelta })
        return out
    }

    /// UTF-16 offset of each line's first character, plus one entry for the empty line a
    /// trailing newline leaves — which is what hosts a band trailing the whole document.
    ///
    /// The canonical implementation lives here rather than beside the highlighter so the
    /// incremental `lineStartsAfterEdit` can be tested against it: the two disagreeing is
    /// exactly how row→offset lookups would drift as you type.
    static func lineStartOffsets(_ text: String) -> [Int] {
        var starts = [0]
        let ns = text as NSString
        ns.enumerateSubstrings(in: NSRange(location: 0, length: ns.length),
                               options: [.byLines, .substringNotRequired]) { _, range, _, _ in
            let next = range.location + range.length + 1
            if next <= ns.length { starts.append(next) }
        }
        return starts
    }

    private static func newlineCount(_ string: String) -> Int {
        var count = 0
        for unit in string.utf16 where unit == 0x0A { count += 1 }
        return count
    }
}
