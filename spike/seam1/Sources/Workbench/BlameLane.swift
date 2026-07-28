import Foundation

/// How hot a lane cell is drawn. Age only — the run separator carries grouping, so the shade
/// does not also have to distinguish neighbouring commits.
enum BlameShade: Int, Equatable {
    case fresh, recent, stale, old, uncommitted
}

/// One row's lane cell.
struct BlameRow: Equatable {
    let sha: String
    let shade: BlameShade
    /// True when the row above belongs to a different commit (or to none). The hairline
    /// separator is drawn from this.
    let isRunStart: Bool
}

/// Rows → lane cells.
///
/// Pure, and it takes the document's line numbers rather than reading them itself: the
/// gutter's numbers (`RowOrigin.newLineNumber`) are the real row → source-line mapping, and
/// deriving it any other way is the mistake that painted rows with unrelated lines.
enum BlameLane {

    static func shade(commitTime: Date, now: Date) -> BlameShade {
        switch max(0, now.timeIntervalSince(commitTime)) {
        case ..<86400:          return .fresh    // today
        case ..<(7 * 86400):    return .recent   // this week
        case ..<(90 * 86400):   return .stale    // this quarter
        default:                return .old
        }
    }

    /// - Parameters:
    ///   - lineNumbers: per stitched row, its 1-based new-side line number, or nil for a row
    ///     that has none — a deletion band's rows, or anything the blame does not cover.
    /// - Returns: one optional cell per row, index-aligned with `lineNumbers`.
    static func rows(lineNumbers: [Int?], blame: BlameResult, now: Date) -> [BlameRow?] {
        var out: [BlameRow?] = []
        out.reserveCapacity(lineNumbers.count)
        var previousSha: String?

        for number in lineNumbers {
            guard let number, let sha = blame.shaByLine[number] else {
                // No cell, and the run is broken: a band between two stretches of one commit
                // must not join them into a single unbroken bar.
                out.append(nil)
                previousSha = nil
                continue
            }
            let shade: BlameShade
            if blame.isUncommitted(sha) {
                shade = .uncommitted
            } else if let meta = blame.meta[sha] {
                shade = self.shade(commitTime: meta.timestamp, now: now)
            } else {
                // A sha with no metadata still gets a cell — abstaining would read as "not
                // committed", which is a different and wrong claim.
                shade = .old
            }
            out.append(BlameRow(sha: sha, shade: shade, isRunStart: sha != previousSha))
            previousSha = sha
        }
        return out
    }
}
