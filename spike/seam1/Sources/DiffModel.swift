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
        let lines = unified.components(separatedBy: "\n")
        var i = 0
        while i < lines.count {
            guard lines[i].hasPrefix("diff --git ") else { i += 1; continue }
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
                  !lines[i].hasPrefix("diff --git ") {
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
            let path = newPath ?? oldPath ?? "?"
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
        var body: [DiffLine] = []
        var oldNo = os, newNo = ns, added = 0, removed = 0
        var i = start + 1
        while i < lines.count,
              !lines[i].hasPrefix("@@"),
              !lines[i].hasPrefix("diff --git ") {
            let l = lines[i]
            if l.hasPrefix("\\") { i += 1; continue }   // "\ No newline at end of file"
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
        // Between the two "@@" markers: "-oldStart,oldCount +newStart,newCount"
        let parts = header.components(separatedBy: " ")
        var os = 0, oc = 1, ns = 0, nc = 1
        for p in parts {
            if p.hasPrefix("-") { (os, oc) = parseRange(p.dropFirst()) }
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
