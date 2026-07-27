import Foundation

/// One stretch of the unchanged lines between two hunks.
enum GapSegment: Equatable {
    /// Still hidden — drawn as a band saying how many lines are here.
    case collapsed(Range<Int>)
    /// Revealed — emitted as real context rows read from the file.
    case revealed(Range<Int>)

    var range: Range<Int> {
        switch self {
        case .collapsed(let r), .revealed(let r): return r
        }
    }
}

/// The unchanged lines a diff skips between hunks, and how much of them the user has
/// asked to see.
///
/// Line indices are **0-based new-side** file lines throughout — the working copy is the
/// only side a gap can be read from, since unchanged lines are identical on both.
///
/// Revealed lines are tracked as a set rather than a list of ranges: expanding twice in
/// the same place then has to merge nothing, and two expansions meeting in the middle
/// become one run for free.
enum HunkGaps {
    /// How many lines one expand click reveals.
    static let step = 10

    /// Split a gap into revealed and collapsed stretches, in document order.
    static func segments(gap: Range<Int>, revealed: Set<Int>) -> [GapSegment] {
        guard !gap.isEmpty else { return [] }
        var segments: [GapSegment] = []
        var runStart = gap.lowerBound
        var runRevealed = revealed.contains(gap.lowerBound)

        for line in gap.dropFirst() {
            let isRevealed = revealed.contains(line)
            guard isRevealed != runRevealed else { continue }
            segments.append(runRevealed ? .revealed(runStart..<line) : .collapsed(runStart..<line))
            runStart = line
            runRevealed = isRevealed
        }
        segments.append(runRevealed ? .revealed(runStart..<gap.upperBound)
                                    : .collapsed(runStart..<gap.upperBound))
        return segments
    }

    /// The lines a "reveal from the top" click adds — the ones directly below the hunk
    /// above, so the band eats downward into the gap.
    static func expandingDown(_ collapsed: Range<Int>, step: Int = step) -> Set<Int> {
        Set(collapsed.prefix(step))
    }

    /// The lines a "reveal from the bottom" click adds — the ones directly above the hunk
    /// below.
    static func expandingUp(_ collapsed: Range<Int>, step: Int = step) -> Set<Int> {
        Set(collapsed.suffix(step))
    }

    /// A gap small enough that splitting the reveal in two directions is pointless; the
    /// band offers a single "show all" instead.
    static func isFullyExpandable(_ collapsed: Range<Int>, step: Int = step) -> Bool {
        collapsed.count <= step
    }
}
