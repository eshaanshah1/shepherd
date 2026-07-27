import Foundation

/// One file's share of a selection, in the shape `PatchSynth.patch` takes.
struct FileStageSelection: Equatable {
    let path: String
    let oldPath: String?
    let hunks: [DiffHunk]
    let selections: [HunkSelection]
}

/// Maps between stitched rows and the diff model: the reverse grouping of a selection,
/// and hunk boundaries for navigation. `RowPlanner` owns the forward walk.
///
/// Pure so the mapping — where the bugs live — is testable without a text view.
enum StageSelection {

    /// Group selected stitched rows into per-file hunk selections. Files keep `files`
    /// order; hunk and line indices come out ascending. Files with nothing selected are
    /// omitted, as are rows past the end of `origins`.
    ///
    /// A row contributes its **own** line only when it is a change (context lines ride
    /// along as context in whatever patch their neighbours produce) but always contributes
    /// the removals of any band it owns. Without that, removals — which have no rows of
    /// their own — could never be selected, and staging a hunk would build a patch of only
    /// its additions: half a change, silently.
    static func selections(forStitchedLines lines: Set<Int>,
                           origins: [RowOrigin],
                           files: [DiffFile]) -> [FileStageSelection] {
        var byPath: [String: [Int: Set<Int>]] = [:]
        for line in lines {
            guard origins.indices.contains(line) else { continue }
            let origin = origins[line]
            if origin.isStageable {
                byPath[origin.path, default: [:]][origin.hunkIndex, default: []]
                    .insert(origin.lineIndex)
            }
            for ref in origin.deletedRefs {
                byPath[origin.path, default: [:]][ref.hunkIndex, default: []]
                    .insert(ref.lineIndex)
            }
        }
        return files.compactMap { file in
            guard let hunks = byPath[file.path], !hunks.isEmpty else { return nil }
            let selections = hunks.keys.sorted().map {
                HunkSelection(hunkIndex: $0, lineIndices: hunks[$0])
            }
            return FileStageSelection(path: file.path, oldPath: file.oldPath,
                                      hunks: file.hunks, selections: selections)
        }
    }

    /// Every stitched row of the hunk containing `line`, so "stage this hunk" can be
    /// expressed as a row selection and go through the one staging path.
    ///
    /// Walks outward from `line` rather than scanning the document: `rowOrigins` is built
    /// hunk by hunk, so a hunk's rows are contiguous. The old full scan was O(document)
    /// and ran on every SwiftUI body evaluation via `effectiveStagingRows` — 32k
    /// iterations per keystroke.
    static func hunkRows(atStitchedLine line: Int, origins: [RowOrigin]) -> Range<Int> {
        guard origins.indices.contains(line) else { return 0..<0 }
        let target = origins[line]
        func sameHunk(_ other: RowOrigin) -> Bool {
            other.path == target.path && other.hunkIndex == target.hunkIndex
        }
        var lower = line
        while lower > 0, sameHunk(origins[lower - 1]) { lower -= 1 }
        var upper = line + 1
        while upper < origins.count, sameHunk(origins[upper]) { upper += 1 }
        return lower..<upper
    }

    /// The stitched row each hunk starts on, ascending — the stops for ⌥↓ / ⌥↑.
    static func hunkStarts(origins: [RowOrigin]) -> [Int] {
        var starts: [Int] = []
        var previous: (path: String, hunkIndex: Int)?
        for (idx, origin) in origins.enumerated() {
            if previous?.path != origin.path || previous?.hunkIndex != origin.hunkIndex {
                starts.append(idx)
                previous = (origin.path, origin.hunkIndex)
            }
        }
        return starts
    }

    /// The next hunk start strictly after `line` (or the first, wrapping). Nil when
    /// there are no hunks.
    static func hunkStart(after line: Int?, origins: [RowOrigin]) -> Int? {
        let starts = hunkStarts(origins: origins)
        guard !starts.isEmpty else { return nil }
        guard let line else { return starts.first }
        return starts.first { $0 > line } ?? starts.first
    }

    /// The hunk start strictly before `line`'s own hunk start (or the last, wrapping).
    static func hunkStart(before line: Int?, origins: [RowOrigin]) -> Int? {
        let starts = hunkStarts(origins: origins)
        guard !starts.isEmpty else { return nil }
        guard let line else { return starts.last }
        let current = starts.last { $0 <= line } ?? starts[0]
        return starts.last { $0 < current } ?? starts.last
    }
}
