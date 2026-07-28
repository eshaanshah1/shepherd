import Foundation

/// Pure diff model — no AppKit. Rendered by the SwiftUI panel, and (future) shipped
/// over the wire to the remote client. Highlighting is layered on at render time; the
/// model itself is plain text.

enum DiffLineKind: Equatable { case context, added, removed }
enum DiffSide: Equatable { case old, new }

struct DiffLine: Equatable {
    let kind: DiffLineKind
    let text: String
    let oldLineNo: Int?
    let newLineNo: Int?
}

struct DiffHunk: Equatable {
    let header: String
    let oldStart: Int
    let oldCount: Int
    let newStart: Int
    let newCount: Int
    let lines: [DiffLine]
}

enum DiffStatus: Equatable { case added, modified, deleted, renamed }

struct DiffFile: Equatable {
    let path: String
    let oldPath: String?
    let status: DiffStatus
    let isBinary: Bool
    let hunks: [DiffHunk]
    let addedCount: Int
    let removedCount: Int
}

enum DiffParser {
    /// Parse `git diff` unified output (with `--git` headers) into files.
    static func parse(_ unified: String) -> [DiffFile] {
        var files: [DiffFile] = []
        var lines = unified.components(separatedBy: "\n")
        // `git diff` output ends with a newline, so the split leaves a trailing "" that is
        // not a diff line at all. Inside the last hunk it read as a blank context line and
        // became a phantom row — one line past the end of the file, with a line number that
        // doesn't exist, and an extra context line in any patch synthesized from that hunk.
        if lines.last?.isEmpty == true { lines.removeLast() }
        var i = 0
        while i < lines.count {
            guard isFileHeader(lines[i]) else { i += 1; continue }
            // Paths from the `diff --git a/X b/Y` line, as the fallback.
            //
            // A **binary** file's diff has no `---`/`+++` lines — git writes `Binary files …
            // differ` instead — so reading paths only from those two left the file with none
            // and the rail listed it as `?`. Seen live as 49 untracked `.pcm` rows, each
            // called `?` and each offering a stage button. The header always carries the path.
            let (headerOld, headerNew) = gitHeaderPaths(lines[i])
            var oldPath: String? = nil
            var newPath: String? = nil
            var status: DiffStatus = .modified
            var isBinary = false
            var hunks: [DiffHunk] = []
            var added = 0, removed = 0
            i += 1
            // File header lines until the first hunk (@@) or the next file.
            while i < lines.count,
                  !lines[i].hasPrefix("@@"),
                  !isFileHeader(lines[i]) {
                let l = lines[i]
                if l.hasPrefix("new file") { status = .added }
                else if l.hasPrefix("deleted file") { status = .deleted }
                else if l.hasPrefix("rename from ") { status = .renamed; oldPath = String(l.dropFirst("rename from ".count)) }
                else if l.hasPrefix("rename to ") { newPath = String(l.dropFirst("rename to ".count)) }
                else if l.hasPrefix("--- ") { oldPath = oldPath ?? headerPath(l.dropFirst(4)) }
                else if l.hasPrefix("+++ ") { newPath = newPath ?? headerPath(l.dropFirst(4)) }
                else if l.hasPrefix("Binary files ") { isBinary = true }
                i += 1
            }
            // Hunks.
            while i < lines.count, lines[i].hasPrefix("@@") {
                let (hunk, a, r, next) = parseHunk(lines, from: i)
                hunks.append(hunk); added += a; removed += r; i = next
            }
            // The `---`/`+++` paths still win where they exist, so text diffs are unaffected.
            let path = newPath ?? oldPath ?? headerNew ?? headerOld ?? "?"
            files.append(DiffFile(
                path: path,
                oldPath: (status == .renamed) ? oldPath : nil,
                status: status,
                isBinary: isBinary,
                hunks: hunks,
                addedCount: added,
                removedCount: removed))
        }
        return files
    }

    /// Whether a line opens a file's diff.
    ///
    /// `--cc` is the **combined** form git emits for an unmerged path mid-merge. Without it
    /// the whole file was skipped, so working-tree and vs-base modes showed nothing at all
    /// during a merge.
    /// The two paths on a `diff --git a/X b/Y` line.
    ///
    /// A path can contain spaces, so the split point cannot be found by scanning for one.
    /// git writes both sides with the same name whenever it is not a rename, and for a rename
    /// the `rename from`/`rename to` lines carry the truth — so splitting on the **` b/`** that
    /// begins the second half is enough, and taking the *last* occurrence keeps a path that
    /// itself contains ` b/` intact.
    private static func gitHeaderPaths(_ line: String) -> (old: String?, new: String?) {
        guard let range = line.range(of: "diff --git ") else { return (nil, nil) }
        let body = line[range.upperBound...]
        guard let split = body.range(of: " b/", options: .backwards) else { return (nil, nil) }
        let old = body[body.startIndex..<split.lowerBound]
        let new = body[split.upperBound...]
        return (old.hasPrefix("a/") ? String(old.dropFirst(2)) : String(old),
                new.isEmpty ? nil : String(new))
    }

    private static func isFileHeader(_ line: String) -> Bool {
        line.hasPrefix("diff --git ") || line.hasPrefix("diff --cc ")
            || line.hasPrefix("diff --combined ")
    }

    /// How many marker columns a hunk body carries: one per parent.
    ///
    /// An ordinary diff opens `@@` and has one column; a two-parent combined diff opens
    /// `@@@` and has two. Read from the header rather than assumed, since an octopus merge
    /// can have more.
    private static func markerColumns(_ header: String) -> Int {
        max(1, header.prefix(while: { $0 == "@" }).count - 1)
    }

    /// `a/foo.txt` / `b/foo.txt` / `/dev/null` → `foo.txt` / nil.
    private static func headerPath<S: StringProtocol>(_ s: S) -> String? {
        let t = s.trimmingCharacters(in: .whitespaces)
        if t == "/dev/null" { return nil }
        if t.hasPrefix("a/") || t.hasPrefix("b/") { return String(t.dropFirst(2)) }
        return t
    }

    /// Parse one hunk beginning at `start` (an `@@` line). Returns the hunk, its
    /// added/removed counts, and the index of the next unconsumed line.
    private static func parseHunk(_ lines: [String], from start: Int)
        -> (DiffHunk, Int, Int, Int) {
        let header = lines[start]
        let (os, oc, ns, nc) = parseHunkRanges(header)
        // A combined diff carries one marker column per parent. Reduced to the **first**
        // parent's column, which turns it into an ordinary two-way diff against HEAD —
        // which is what working-tree mode means. The conflict markers git wrote into the
        // file show up as added lines, correctly: they really are in the file.
        let columns = markerColumns(header)
        var body: [DiffLine] = []
        var oldNo = os, newNo = ns, added = 0, removed = 0
        var i = start + 1
        while i < lines.count,
              !lines[i].hasPrefix("@@"),
              !isFileHeader(lines[i]) {
            let raw = lines[i]
            if raw.hasPrefix("\\") { i += 1; continue }   // "\ No newline at end of file"
            let l = columns == 1 ? raw : String(raw.prefix(1)) + String(raw.dropFirst(columns))
            let text = l.isEmpty ? "" : String(l.dropFirst())
            if l.hasPrefix("+") {
                body.append(DiffLine(kind: .added, text: text, oldLineNo: nil, newLineNo: newNo))
                newNo += 1; added += 1
            } else if l.hasPrefix("-") {
                body.append(DiffLine(kind: .removed, text: text, oldLineNo: oldNo, newLineNo: nil))
                oldNo += 1; removed += 1
            } else {
                // Context (leading space) or a stray blank line inside the hunk.
                body.append(DiffLine(kind: .context, text: text, oldLineNo: oldNo, newLineNo: newNo))
                oldNo += 1; newNo += 1
            }
            i += 1
        }
        return (DiffHunk(header: header, oldStart: os, oldCount: oc,
                         newStart: ns, newCount: nc, lines: body), added, removed, i)
    }

    /// `@@ -1,3 +1,3 @@ optional section` → (1,3,1,3).
    private static func parseHunkRanges(_ header: String) -> (Int, Int, Int, Int) {
        // **Only** between the two "@@" markers. Scanning the whole header let the section
        // heading git appends re-parse the ranges — `->` in a Swift signature starts with
        // "-", so `oldStart` silently became 0 and every synthesized patch for that hunk
        // was rejected by `git apply`.
        var body = Substring(header)
        if let open = header.range(of: "@@"),
           let close = header.range(of: "@@", range: open.upperBound..<header.endIndex) {
            body = header[open.upperBound..<close.lowerBound]
        }
        var os = 0, oc = 1, ns = 0, nc = 1
        var haveOld = false
        for p in body.split(separator: " ") {
            // A combined header lists one `-` range per parent. Only the first is kept:
            // the rest describe the other parents, and taking the last (which is what
            // overwriting did) silently reported parent N's numbers as HEAD's.
            if p.hasPrefix("-"), !haveOld { (os, oc) = parseRange(p.dropFirst()); haveOld = true }
            else if p.hasPrefix("+") { (ns, nc) = parseRange(p.dropFirst()) }
        }
        return (os, oc, ns, nc)
    }

    /// "1,3" → (1,3); "5" → (5,1).
    private static func parseRange<S: StringProtocol>(_ s: S) -> (Int, Int) {
        let c = s.components(separatedBy: ",")
        let start = Int(c[0]) ?? 0
        let count = c.count > 1 ? (Int(c[1]) ?? 1) : 1
        return (start, count)
    }
}

struct ReviewComment: Equatable, Identifiable {
    let id: UUID
    let file: String
    let line: Int
    let side: DiffSide
    let text: String
    var githubAuthor: String? = nil   // set = sourced from a GitHub review thread; nil = local
}

enum ReviewPrompt {
    /// Compose accumulated comments into one prompt for the agent. Empty → "".
    /// GitHub-sourced entries are framed as review comments to address.
    static func compose(_ comments: [ReviewComment]) -> String {
        guard !comments.isEmpty else { return "" }
        let body = comments.enumerated().map { idx, c in
            if let author = c.githubAuthor {
                return "\(idx + 1). Address this PR review comment from @\(author) on \(c.file):\(c.line): \(c.text)"
            }
            return "\(idx + 1). \(c.file):\(c.line) — \(c.text)"
        }.joined(separator: "\n")
        return "Review feedback on your changes:\n\n\(body)\n\nPlease address these."
    }
}

enum HighlightMap {
    /// Which source-file side + line number a diff line pulls its syntax highlight
    /// from. Added/context use the new side; removed uses the old side. Nil never
    /// happens for real diff lines (all carry a number on at least one side) but
    /// keeps the call site total.
    static func sourceLine(for line: DiffLine) -> (side: DiffSide, lineNo: Int)? {
        switch line.kind {
        case .added:   return line.newLineNo.map { (.new, $0) }
        case .removed: return line.oldLineNo.map { (.old, $0) }
        case .context: return line.newLineNo.map { (.new, $0) }
        }
    }
}
