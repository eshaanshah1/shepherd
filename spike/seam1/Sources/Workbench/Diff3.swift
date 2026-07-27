import Foundation

/// One stretch of a three-way merge.
enum MergeRegion: Equatable {
    /// Agreed by all three, or changed by exactly one side. Auto-resolved regions land
    /// here, which is why they render as ordinary unmarked context rather than being
    /// highlighted and pre-checked — VSCode's known flaw.
    case stable([String])
    case conflict(base: [String], ours: [String], theirs: [String])
}

/// Splitting a blob into lines and back.
///
/// A file ending in a newline splits to a trailing `""` that is not a line. Keeping it
/// emits a phantom row one line past the end of the file — the defect `DiffParser` shipped
/// with until W2.0 — and dropping it without restoring the newline on the way out rewrites
/// every resolved file without its trailing newline, which shows up as a spurious one-line
/// diff forever after.
enum MergeText {
    static func lines(_ blob: String) -> [String] {
        var out = blob.components(separatedBy: "\n")
        if out.last?.isEmpty == true { out.removeLast() }
        return out
    }

    static func blob(_ lines: [String]) -> String {
        lines.isEmpty ? "" : lines.joined(separator: "\n") + "\n"
    }
}

/// Three-way merge of `base`, `ours` and `theirs` over two `SequenceAlign.lcs` runs.
///
/// Deliberately **not** a parse of the worktree file's `<<<<<<<` markers. Marker text
/// depends on `merge.conflictStyle` (plain vs diff3 vs zdiff3 — only two of which carry a
/// base at all), file content can itself contain marker-shaped lines, and a rebase writes
/// markers whose sides are the reverse of what a reader expects. The index's stage blobs
/// are unambiguous, always three-way, and always available.
enum Diff3 {

    static func merge(base: [String], ours: [String], theirs: [String]) -> [MergeRegion] {
        let oursMatch = matchMap(SequenceAlign.lcs(base, ours))
        let theirsMatch = matchMap(SequenceAlign.lcs(base, theirs))

        var out: [MergeRegion] = []
        var stable: [String] = []
        var b = 0, o = 0, t = 0

        func flushStable() {
            guard !stable.isEmpty else { return }
            out.append(.stable(stable))
            stable = []
        }

        while b < base.count || o < ours.count || t < theirs.count {
            // A sync point: this base line survives on both sides, and both sides are
            // already standing on it — nothing of either side is pending in front of it.
            if b < base.count, oursMatch[b] == o, theirsMatch[b] == t {
                stable.append(base[b])
                b += 1; o += 1; t += 1
                continue
            }

            // Otherwise run forward to the next base line both sides kept; everything
            // between here and there is the divergent region.
            var nb = b
            while nb < base.count, oursMatch[nb] == nil || theirsMatch[nb] == nil { nb += 1 }
            let no = nb < base.count ? (oursMatch[nb] ?? ours.count) : ours.count
            let nt = nb < base.count ? (theirsMatch[nb] ?? theirs.count) : theirs.count

            // Every bound here comes from two independent alignment walks that nothing
            // forces to agree, which is exactly the shape that produced the inverted-Range
            // trap in `RowPlanner`'s gap computation. An inverted `Range` **traps** and
            // takes the whole app down, so all three are clamped.
            let bEnd = max(b, min(nb, base.count))
            let oEnd = max(o, min(no, ours.count))
            let tEnd = max(t, min(nt, theirs.count))
            let baseSlice = Array(base[b..<bEnd])
            let oursSlice = Array(ours[o..<oEnd])
            let theirsSlice = Array(theirs[t..<tEnd])

            // Unreachable given the sync test above, but an infinite loop on the main
            // thread is unrecoverable and the guard costs one comparison.
            if bEnd == b, oEnd == o, tEnd == t { break }

            if oursSlice == baseSlice {
                stable.append(contentsOf: theirsSlice)        // only theirs changed
            } else if theirsSlice == baseSlice {
                stable.append(contentsOf: oursSlice)          // only ours changed
            } else if oursSlice == theirsSlice {
                stable.append(contentsOf: oursSlice)          // both made the same change
            } else {
                let trimmed = trim(base: baseSlice, ours: oursSlice, theirs: theirsSlice)
                stable.append(contentsOf: trimmed.leading)
                flushStable()
                out.append(.conflict(base: trimmed.base, ours: trimmed.ours,
                                     theirs: trimmed.theirs))
                stable = trimmed.trailing
            }

            b = bEnd; o = oEnd; t = tEnd
        }

        flushStable()
        return out
    }

    /// Base index → the matching index on the other side, for lines the alignment kept.
    private static func matchMap(_ ops: [AlignOp]) -> [Int: Int] {
        var map: [Int: Int] = [:]
        for op in ops {
            if case .keep(let old, let new) = op { map[old] = new }
        }
        return map
    }

    /// Hoist lines common to **ours and theirs** off both edges of a conflict.
    ///
    /// A line both sides wrote identically is a change they agree on; leaving it inside the
    /// region turns a one-line disagreement into a forty-line decision. This is what
    /// `zdiff3` does. Base is trimmed alongside only where it matches too, so what is left
    /// of it stays the ancestor of what is left of the two sides.
    private static func trim(base: [String], ours: [String], theirs: [String])
        -> (leading: [String], base: [String], ours: [String], theirs: [String],
            trailing: [String]) {
        var b = base, o = ours, t = theirs
        var leading: [String] = []
        var trailing: [String] = []

        while let first = o.first, first == t.first {
            leading.append(first)
            o.removeFirst()
            t.removeFirst()
            if b.first == first { b.removeFirst() }
        }
        while let last = o.last, last == t.last {
            trailing.insert(last, at: 0)
            o.removeLast()
            t.removeLast()
            if b.last == last { b.removeLast() }
        }
        return (leading, b, o, t, trailing)
    }
}
