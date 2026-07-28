import Foundation

/// One row of a two-column diff. Either side may be absent — that absence *is* an
/// insertion or a deletion.
struct SidePair: Equatable {
    /// Index into the hunk's `lines`, or nil when the left column has nothing here.
    let old: Int?
    /// Index into the hunk's `lines`, or nil when the right column has nothing here.
    let new: Int?

    var isPaired: Bool { old != nil && new != nil }
}

/// Aligns a hunk into two columns.
///
/// Pure, because the alignment *is* the feature and everything else is drawing. The rule is
/// deliberately the one `HunkPairing` already settled on: a maximal run of removals
/// immediately followed by a maximal run of additions pairs line-for-line **only when the
/// two runs are the same length**.
///
/// That is not caution for its own sake. Pairing by ordinal across runs of different lengths
/// lines up unrelated lines, which W1's live run proved by tinting words that never changed.
/// Here it would be worse than a wrong tint: two lines sitting opposite each other is a claim
/// that one became the other, and a diff that lies about that is harder to distrust than one
/// that admits it does not know.
enum SideBySidePlan {

    static func pairs(_ hunk: DiffHunk) -> [SidePair] {
        var out: [SidePair] = []
        let kinds = hunk.lines.map(\.kind)
        var i = 0

        while i < kinds.count {
            switch kinds[i] {
            case .context:
                out.append(SidePair(old: i, new: i))
                i += 1

            case .added:
                // Additions with no removals in front of them: pure insertion.
                while i < kinds.count, kinds[i] == .added {
                    out.append(SidePair(old: nil, new: i))
                    i += 1
                }

            case .removed:
                let removedStart = i
                while i < kinds.count, kinds[i] == .removed { i += 1 }
                let addedStart = i
                while i < kinds.count, kinds[i] == .added { i += 1 }

                let removed = addedStart - removedStart
                let added = i - addedStart
                if removed == added {
                    for k in 0..<removed {
                        out.append(SidePair(old: removedStart + k, new: addedStart + k))
                    }
                } else {
                    // Unequal runs: each side stands alone rather than being paired off by
                    // ordinal against a line it has nothing to do with.
                    for k in removedStart..<addedStart { out.append(SidePair(old: k, new: nil)) }
                    for k in addedStart..<i { out.append(SidePair(old: nil, new: k)) }
                }
            }
        }
        return out
    }

    /// How many rows of blank space the **right** column needs opposite a run of left-only
    /// lines, keyed by the row it precedes.
    ///
    /// This is what a Monaco view zone does, and what `BlockKind.spacer(rows:)` has existed
    /// for since W0 without ever being emitted. The right column is the real editor, so its
    /// rows cannot be invented — the space is reserved by a block instead, exactly as a
    /// deletion band reserves space today.
    static func rightGaps(_ pairs: [SidePair]) -> [(beforeNewIndex: Int?, rows: Int)] {
        var out: [(Int?, Int)] = []
        var run = 0
        for pair in pairs {
            if pair.new == nil {
                run += 1
            } else if run > 0 {
                out.append((pair.new, run))
                run = 0
            }
        }
        // A run that ends the hunk has no following row; it trails the whole hunk.
        if run > 0 { out.append((nil, run)) }
        return out
    }
}
