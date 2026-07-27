import Foundation

/// Which lines of a hunk are being staged. `lineIndices` indexes `DiffHunk.lines`;
/// nil means the whole hunk.
struct HunkSelection: Equatable {
    let hunkIndex: Int
    let lineIndices: Set<Int>?

    init(hunkIndex: Int, lineIndices: Set<Int>? = nil) {
        self.hunkIndex = hunkIndex
        self.lineIndices = lineIndices
    }
}

/// Synthesizes a unified patch for `git apply --cached` from a hunk or an arbitrary
/// line selection. Unstaging applies the same patch with `--reverse`.
///
/// The two rules that make partial staging correct, and that are easy to get wrong:
/// an **unselected addition is dropped** (it stays only in the worktree), while an
/// **unselected removal becomes context** (the line must survive in the index —
/// dropping it would silently delete it). Counts are recomputed accordingly.
enum PatchSynth {
    /// A patch for the selected hunks/lines of one file, or nil when the selection
    /// contains no actual change (git rejects a no-op patch).
    static func patch(path: String,
                      oldPath: String?,
                      hunks: [DiffHunk],
                      selections: [HunkSelection]) -> String? {
        let from = oldPath ?? path
        var body = ""
        // Within one patch, each hunk's new-side start shifts by the net line delta of
        // the hunks staged before it.
        var delta = 0

        for selection in selections.sorted(by: { $0.hunkIndex < $1.hunkIndex }) {
            guard hunks.indices.contains(selection.hunkIndex) else { continue }
            let hunk = hunks[selection.hunkIndex]
            guard let rendered = render(hunk, selecting: selection.lineIndices, newDelta: delta)
            else { continue }
            body += rendered.text
            delta += rendered.newCount - rendered.oldCount
        }

        guard !body.isEmpty else { return nil }
        return """
        diff --git a/\(from) b/\(path)
        --- a/\(from)
        +++ b/\(path)
        \(body)
        """
    }

    private struct RenderedHunk {
        let text: String
        let oldCount: Int
        let newCount: Int
    }

    /// Emit one hunk under a selection, or nil if the result carries no +/- line.
    private static func render(_ hunk: DiffHunk,
                              selecting lineIndices: Set<Int>?,
                              newDelta: Int) -> RenderedHunk? {
        var lines: [String] = []
        var oldCount = 0, newCount = 0
        var hasChange = false

        for (idx, line) in hunk.lines.enumerated() {
            let selected = lineIndices?.contains(idx) ?? true
            switch line.kind {
            case .context:
                lines.append(" " + line.text)
                oldCount += 1; newCount += 1
            case .added:
                // Unselected additions exist only in the worktree — drop them.
                guard selected else { continue }
                lines.append("+" + line.text)
                newCount += 1
                hasChange = true
            case .removed:
                if selected {
                    lines.append("-" + line.text)
                    oldCount += 1
                    hasChange = true
                } else {
                    // The line stays in the index, so it must appear as context.
                    lines.append(" " + line.text)
                    oldCount += 1; newCount += 1
                }
            }
        }

        guard hasChange else { return nil }
        let header = "@@ -\(hunk.oldStart),\(oldCount) +\(hunk.oldStart + newDelta),\(newCount) @@"
        return RenderedHunk(text: ([header] + lines).joined(separator: "\n") + "\n",
                            oldCount: oldCount,
                            newCount: newCount)
    }
}
