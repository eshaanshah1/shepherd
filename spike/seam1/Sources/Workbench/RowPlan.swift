import Foundation

/// One removed line, addressed the way `PatchSynth` addresses it.
///
/// Removals are not text rows — a removed line exists in no file on disk, so there is no
/// position to write an edit back to — so they are drawn as a band and referenced from
/// the row the band abuts.
struct DeletedRef: Equatable {
    let hunkIndex: Int
    /// Index into the hunk's `lines`.
    let lineIndex: Int
    /// 1-based old-side line number, for the gutter and for anchoring review threads.
    let oldLineNumber: Int
}

/// Where one text row came from: which file, which hunk, which line inside it, and the
/// numbers the gutter shows for it.
///
/// Every row is a **real line of the new side** — added, context, or unchanged context
/// revealed out of a gap. That invariant is what makes an edit mappable back to a
/// `SourceBuffer`; it is why removals became bands.
struct RowOrigin: Equatable {
    let path: String
    let hunkIndex: Int
    /// Index into the hunk's `lines`, or -1 for a gap-context row the diff never listed.
    let lineIndex: Int
    let kind: DiffLineKind
    let oldLineNumber: Int?
    let newLineNumber: Int?
    /// Removed lines drawn as a band adjacent to this row. The row owns them for
    /// selection, so staging a hunk still stages its deletions.
    var deletedRefs: [DeletedRef]
    /// The merge conflict this row is inside, for a conflicted file. Lets the chrome act on
    /// "the conflict the cursor is in" and tells the tint which rows are undecided.
    let conflictID: String?
    /// Which side of that conflict the row came from, so the two read differently.
    let conflictSide: MergeSide?
    /// Whether this row came from the **staged** diff (index vs HEAD) rather than the
    /// unstaged one. Decides which diff a patch for it is synthesized from — the whole
    /// point of reading the two separately.
    let isStaged: Bool

    init(path: String, hunkIndex: Int, lineIndex: Int, kind: DiffLineKind,
         oldLineNumber: Int? = nil, newLineNumber: Int? = nil,
         deletedRefs: [DeletedRef] = [], conflictID: String? = nil,
         conflictSide: MergeSide? = nil, isStaged: Bool = false) {
        self.path = path
        self.hunkIndex = hunkIndex
        self.lineIndex = lineIndex
        self.kind = kind
        self.oldLineNumber = oldLineNumber
        self.newLineNumber = newLineNumber
        self.deletedRefs = deletedRefs
        self.conflictID = conflictID
        self.conflictSide = conflictSide
        self.isStaged = isStaged
    }

    /// Whether this row's own line can go into a patch. Context lines carry no change, so
    /// they only ride along as context in whatever patch their neighbours produce (a context
    /// row carrying `deletedRefs` still contributes those, handled separately). A
    /// `lineIndex` of -1 means the row belongs to no hunk at all — a gap-revealed line, or
    /// one the user just typed — and feeding -1 to `PatchSynth` as a line index would
    /// synthesize nonsense.
    var isStageable: Bool { kind != .context && lineIndex >= 0 }
}

/// A file opened whole through `⌘P`, rather than because it changed.
struct OpenedFile: Equatable {
    let path: String
    let lineCount: Int
}

/// A non-text band, positioned but not yet measured — height is an AppKit concern.
enum PlannedBand: Equatable {
    case fileHeader(path: String)
    /// A full-width divider naming a group of files — "STAGED" between the two halves of
    /// the working tree.
    case sectionHeader(title: String)
    /// Unchanged lines still hidden between two hunks. 0-based new-side file lines.
    case hunkGap(path: String, collapsed: Range<Int>)
    /// A run of removed lines, contiguous in both the hunk and the old file.
    case deletedLines(path: String, hunkIndex: Int, lineIndices: [Int], startingOldLine: Int)
    /// The accept ours / theirs / both strip above a merge conflict.
    case conflictControls(path: String, conflictID: String, index: Int, total: Int)
    /// A `=======` or `>>>>>>> branch` rule between or after the sides of a conflict.
    ///
    /// Drawn, never typed: the document is what gets written on Resolve, so a marker that
    /// was a real text row could end up in a file. As a band it physically cannot.
    case conflictMarker(path: String, conflictID: String, label: String,
                        side: MergeSide?, isEnd: Bool)
}

/// A band and the text row it sits immediately above. `beforeRow == rows.count` means it
/// trails the whole document, which the trailing empty line hosts.
struct PlannedBlock: Equatable, Identifiable {
    let band: PlannedBand
    let beforeRow: Int

    /// Stable across rebuilds, so caches keyed by it survive a reveal or a restage.
    var id: String {
        switch band {
        case .fileHeader(let path):
            return "hdr-\(path)"
        case .sectionHeader(let title):
            return "section-\(title)"
        case .hunkGap(let path, let collapsed):
            return "gap-\(path)-\(collapsed.lowerBound)"
        case .deletedLines(let path, let hunkIndex, let lineIndices, _):
            return "del-\(path)-\(hunkIndex)-\(lineIndices.first ?? 0)"
        case .conflictControls(_, let conflictID, _, _):
            return "cc-\(conflictID)"
        case .conflictMarker(_, let conflictID, _, _, let isEnd):
            return "mark-\(conflictID)-\(isEnd ? "end" : "sep")"
        }
    }
}

/// One contiguous slice of one file's **new side**, and the rows showing it.
///
/// Excerpts **tile the document**: they are ordered, contiguous, and together cover every
/// row, and each one's `rows` and `sourceLines` have the same length. That holds only
/// because rows are new-side only — while removals were rows, a hunk interleaved both sides
/// and was a contiguous range in neither file, which is why `StitchMap` was being fed row
/// spans and every lookup on it silently drifted.
struct PlannedExcerpt: Equatable {
    let path: String
    /// nil for a stretch revealed out of a hunk gap, which belongs to no hunk.
    let hunkIndex: Int?
    /// The hunk header, for the excerpt id. nil for revealed context.
    let header: String?
    let kind: ExcerptKind
    let rows: Range<Int>
    /// 0-based new-side file lines. Same count as `rows`.
    let sourceLines: Range<Int>

    var id: String {
        header.map { "\(path)#\($0)" } ?? "\(path)#context-\(sourceLines.lowerBound)"
    }
}

/// The whole document layout, decided without touching a byte of text.
struct RowPlan: Equatable {
    var origins: [RowOrigin] = []
    /// In document order, and within a position in the order they must be drawn: a file's
    /// header before its first band.
    var blocks: [PlannedBlock] = []
    var excerpts: [PlannedExcerpt] = []
}

/// Decides which text rows the stitched document has and where every band goes.
///
/// Pure, and the **single** authority on that mapping. It used to be an inline walk in
/// `WorkbenchSession.rebuild`, duplicated by a second walk in `StageSelection` that only
/// tests ever called — so the tested walk and the real one could disagree about what a
/// row index means, which is precisely the class of bug that mangled syntax highlighting.
enum RowPlanner {

    /// - Parameters:
    ///   - files: the files to show, in presentation order. Binary files contribute a
    ///     header band and no rows.
    ///   - revealed: per path, the 0-based new-side lines expanded out of hunk gaps.
    ///   - opened: files opened whole through `⌘P`, appended after the diff. Every line is
    ///     a row, so these are the first excerpts that aren't about a change at all.
    static func plan(files: [DiffFile], staged: [DiffFile] = [],
                     revealed: [String: Set<Int>] = [:],
                     opened: [OpenedFile] = []) -> RowPlan {
        var plan = RowPlan()
        appendDiff(files, staged: false, revealed: revealed, into: &plan)
        if !staged.isEmpty {
            plan.blocks.append(PlannedBlock(band: .sectionHeader(title: "STAGED"),
                                            beforeRow: plan.origins.count))
            appendDiff(staged, staged: true, revealed: revealed, into: &plan)
        }
        appendOpened(opened, into: &plan)
        return plan
    }

    /// One diff's files. Called twice in working-tree mode — once for what is staged and
    /// once for what is not — so a row can be traced back to the diff it came from.
    private static func appendDiff(_ files: [DiffFile], staged: Bool,
                                   revealed: [String: Set<Int>],
                                   into plan: inout RowPlan) {
        for file in files {
            plan.blocks.append(PlannedBlock(band: .fileHeader(path: file.path),
                                            beforeRow: plan.origins.count))
            guard !file.isBinary else { continue }
            let revealedLines = revealed[file.path] ?? []

            for (hunkIndex, hunk) in file.hunks.enumerated() {
                if hunkIndex > 0 {
                    appendGap(between: file.hunks[hunkIndex - 1], and: hunk,
                              file: file, hunkIndex: hunkIndex, staged: staged,
                              revealed: revealedLines, into: &plan)
                }

                let start = plan.origins.count
                // Removals accumulate until the next new-side row closes the run, so a
                // band is anchored on the row it sits above — the row a reader's eye
                // pairs it with, and the row selection has to route it through.
                var pending: [DeletedRef] = []

                for (lineIndex, line) in hunk.lines.enumerated() {
                    guard line.kind != .removed else {
                        pending.append(DeletedRef(hunkIndex: hunkIndex, lineIndex: lineIndex,
                                                  oldLineNumber: line.oldLineNo ?? 0))
                        continue
                    }
                    plan.origins.append(RowOrigin(path: file.path, hunkIndex: hunkIndex,
                                                  lineIndex: lineIndex, kind: line.kind,
                                                  oldLineNumber: line.oldLineNo,
                                                  newLineNumber: line.newLineNo,
                                                  deletedRefs: pending, isStaged: staged))
                    if !pending.isEmpty {
                        plan.blocks.append(band(pending, file: file, hunkIndex: hunkIndex,
                                                beforeRow: plan.origins.count - 1))
                        pending = []
                    }
                }

                if !pending.isEmpty {
                    // A run at the end of a hunk has no following row of its own hunk, so
                    // it draws above whatever comes next and is owned by the hunk's last
                    // row — the only row that can carry it back into a patch. A hunk that
                    // is *nothing but* removals (a deleted file) has no such row, and its
                    // deletions are stageable only whole-file; the rail's button does that.
                    plan.blocks.append(band(pending, file: file, hunkIndex: hunkIndex,
                                            beforeRow: plan.origins.count))
                    if plan.origins.count > start {
                        plan.origins[plan.origins.count - 1].deletedRefs += pending
                    }
                }

                if plan.origins.count > start, // swiftlint:disable:this empty_count
                   let first = plan.origins[start].newLineNumber {
                    // Derived from the rows actually emitted, not from the header's
                    // `newCount`: the parser numbers new-side lines sequentially itself, so
                    // the rows are consecutive whatever the header claims.
                    let lower = first - 1
                    plan.excerpts.append(PlannedExcerpt(
                        path: file.path, hunkIndex: hunkIndex, header: hunk.header, kind: .hunk,
                        rows: start..<plan.origins.count,
                        sourceLines: lower..<(lower + plan.origins.count - start)))
                }
            }
        }
    }

    /// Files opened whole through `⌘P`, appended after whatever else the plan holds.
    ///
    /// Shared by the diff plan and the conflict plan: a conflicted repo still wants the files
    /// you opened by hand in the same document, and duplicating this walk is how the tested
    /// one and the real one drift apart.
    private static func appendOpened(_ opened: [OpenedFile], into plan: inout RowPlan) {
        for file in opened {
            plan.blocks.append(PlannedBlock(band: .fileHeader(path: file.path),
                                            beforeRow: plan.origins.count))
            guard file.lineCount > 0 else { continue }
            let start = plan.origins.count
            for line in 0..<file.lineCount {
                // No hunk and no old side: these rows describe no change, they are just the
                // file. `lineIndex` -1 keeps them out of any patch.
                plan.origins.append(RowOrigin(path: file.path, hunkIndex: 0, lineIndex: -1,
                                              kind: .context, oldLineNumber: nil,
                                              newLineNumber: line + 1))
            }
            plan.excerpts.append(PlannedExcerpt(
                path: file.path, hunkIndex: nil, header: nil, kind: .context,
                rows: start..<plan.origins.count, sourceLines: 0..<file.lineCount))
        }
    }

    /// The document for a set of unmerged files.
    ///
    /// A separate entry point from `plan(files:)` rather than another argument to it: a
    /// merge is three-way and has no hunks, no old/new sides and no staging, so threading it
    /// through the diff walk would mean a second meaning for almost every field.
    ///
    /// **Every row here is synthetic.** Its `newLineNumber` is a line of the merge *preview*,
    /// not of the file on disk — which mid-merge still holds git's markers, so nothing in the
    /// preview sits where the preview would claim. That is why these rows carry
    /// `lineIndex: -1` (never stageable, never reaching `PatchSynth`) and why the session
    /// refuses to write edits through them.
    static func planConflicts(_ files: [MergeFile],
                              resolutions: [String: Resolution],
                              opened: [OpenedFile] = []) -> RowPlan {
        var plan = RowPlan()

        for file in files {
            // A conflict with no line-level answer — a binary blob, or a file one side
            // deleted — contributes **nothing to the document at all**, not even a header.
            //
            // It has no rows, so every band it emitted attached at `origins.count` and the
            // whole set piled up past the end of the last file's text: scroll far enough
            // and you fell off the document into a stack of orphaned controls. The rail
            // already carries these, which is where a decision handed to git belongs.
            guard !file.kind.isWholeFile else { continue }

            plan.blocks.append(PlannedBlock(band: .fileHeader(path: file.path),
                                            beforeRow: plan.origins.count))

            let start = plan.origins.count
            var conflictIndex = 0
            var previewLine = 1

            for region in file.regions {
                switch region {
                case .stable(let lines):
                    for _ in lines {
                        plan.origins.append(RowOrigin(
                            path: file.path, hunkIndex: 0, lineIndex: -1, kind: .context,
                            newLineNumber: previewLine))
                        previewLine += 1
                    }

                case .conflict:
                    guard conflictIndex < file.conflicts.count else { continue }
                    let conflict = file.conflicts[conflictIndex]
                    conflictIndex += 1
                    let resolution = resolutions[conflict.id]
                    let segments = MergeOutput.display(for: conflict, resolution: resolution)
                    let split = MergeOutput.isSplit(resolution: resolution)

                    // The opening marker doubles as the controls strip: `<<<<<<< main`
                    // with the accept buttons on it, which is where a reader already looks.
                    plan.blocks.append(PlannedBlock(
                        band: .conflictControls(path: file.path, conflictID: conflict.id,
                                                index: conflict.index,
                                                total: file.conflicts.count),
                        beforeRow: plan.origins.count))

                    for (offset, segment) in segments.enumerated() {
                        // `=======` between the two sides.
                        if split, offset > 0 {
                            plan.blocks.append(PlannedBlock(
                                band: .conflictMarker(path: file.path, conflictID: conflict.id,
                                                      label: "", side: nil, isEnd: false),
                                beforeRow: plan.origins.count))
                        }
                        for _ in segment.lines {
                            plan.origins.append(RowOrigin(
                                path: file.path, hunkIndex: 0, lineIndex: -1, kind: .context,
                                newLineNumber: previewLine, conflictID: conflict.id,
                                conflictSide: segment.side))
                            previewLine += 1
                        }
                    }

                    // `>>>>>>> feature` closing the region.
                    if split, let last = segments.last {
                        plan.blocks.append(PlannedBlock(
                            band: .conflictMarker(path: file.path, conflictID: conflict.id,
                                                  label: last.side == .ours
                                                      ? file.oursLabel : file.theirsLabel,
                                                  side: last.side, isEnd: true),
                            beforeRow: plan.origins.count))
                    }
                }
            }

            if plan.origins.count > start {
                plan.excerpts.append(PlannedExcerpt(
                    path: file.path, hunkIndex: nil, header: nil, kind: .conflict,
                    rows: start..<plan.origins.count,
                    sourceLines: 0..<(plan.origins.count - start)))
            }
        }
        appendOpened(opened, into: &plan)
        return plan
    }

    private static func band(_ refs: [DeletedRef], file: DiffFile, hunkIndex: Int,
                             beforeRow: Int) -> PlannedBlock {
        PlannedBlock(band: .deletedLines(path: file.path, hunkIndex: hunkIndex,
                                         lineIndices: refs.map(\.lineIndex),
                                         startingOldLine: refs[0].oldLineNumber),
                     beforeRow: beforeRow)
    }

    /// The unchanged lines the diff skipped since the previous hunk: a band for what is
    /// still hidden, real rows for whatever the user expanded.
    private static func appendGap(between previous: DiffHunk, and hunk: DiffHunk,
                                 file: DiffFile, hunkIndex: Int, staged: Bool,
                                 revealed: Set<Int>, into plan: inout RowPlan) {
        // Clamped: `Range` traps on an inverted bound, and while git emits hunks in
        // ascending order, nothing in the model enforces it — a zero-count hunk or a diff
        // read from anywhere but `git diff` would have taken the whole app down here.
        let start = previous.newStart - 1 + previous.newCount
        let gap = start..<max(start, hunk.newStart - 1)
        for segment in HunkGaps.segments(gap: gap, revealed: revealed) {
            switch segment {
            case .collapsed(let range):
                plan.blocks.append(PlannedBlock(band: .hunkGap(path: file.path, collapsed: range),
                                                beforeRow: plan.origins.count))
            case .revealed(let range):
                let start = plan.origins.count
                for index in range {
                    // Unchanged, so both sides carry a number; the old side is offset by
                    // however much the diff has added above here.
                    plan.origins.append(RowOrigin(
                        path: file.path, hunkIndex: hunkIndex, lineIndex: -1, kind: .context,
                        oldLineNumber: index + 1 - (hunk.newStart - hunk.oldStart),
                        newLineNumber: index + 1, isStaged: staged))
                }
                plan.excerpts.append(PlannedExcerpt(
                    path: file.path, hunkIndex: nil, header: nil, kind: .context,
                    rows: start..<plan.origins.count, sourceLines: range))
            }
        }
    }
}
