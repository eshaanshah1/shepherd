import Foundation

/// Where one stitched row came from: which file, which hunk, and which line inside it.
///
/// The stitched document flattens every hunk of every file into one row list, so acting
/// on "this line" needs a way back to the `(file, hunk, line)` triple `PatchSynth` speaks.
struct RowOrigin: Equatable {
    let path: String
    let hunkIndex: Int
    let lineIndex: Int
    let kind: DiffLineKind

    /// Context lines carry no change, so they are never independently stageable — they
    /// only ride along as context in whatever patch their neighbours produce.
    var isStageable: Bool { kind != .context }
}

/// One file's share of a selection, in the shape `PatchSynth.patch` takes.
struct FileStageSelection: Equatable {
    let path: String
    let oldPath: String?
    let hunks: [DiffHunk]
    let selections: [HunkSelection]
}

/// Maps between stitched rows and the diff model: the flattening walk, the reverse
/// grouping, and hunk boundaries for navigation.
///
/// Pure so the mapping — where the bugs live — is testable without a text view.
/// `WorkbenchSession.rebuild` emits its rows through `rowOrigins` so the two walks
/// cannot drift.
enum StageSelection {

    /// One entry per stitched row, in document order. Binary files contribute nothing:
    /// they have no hunks to show, and the header block they get is not a text row.
    static func rowOrigins(files: [DiffFile]) -> [RowOrigin] {
        var origins: [RowOrigin] = []
        for file in files where !file.isBinary {
            for (hunkIndex, hunk) in file.hunks.enumerated() {
                for (lineIndex, line) in hunk.lines.enumerated() {
                    origins.append(RowOrigin(path: file.path, hunkIndex: hunkIndex,
                                             lineIndex: lineIndex, kind: line.kind))
                }
            }
        }
        return origins
    }

    /// Group ticked stitched rows into per-file hunk selections. Files keep `files`
    /// order; hunk and line indices come out ascending. Files with nothing selected are
    /// omitted, as are context rows and rows past the end of `origins`.
    static func selections(forStitchedLines lines: Set<Int>,
                           origins: [RowOrigin],
                           files: [DiffFile]) -> [FileStageSelection] {
        var byPath: [String: [Int: Set<Int>]] = [:]
        for line in lines {
            guard origins.indices.contains(line) else { continue }
            let origin = origins[line]
            guard origin.isStageable else { continue }
            byPath[origin.path, default: [:]][origin.hunkIndex, default: []].insert(origin.lineIndex)
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
