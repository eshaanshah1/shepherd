import Foundation

/// Who last touched a line, and when.
struct BlameCommitMeta: Equatable {
    let author: String
    let timestamp: Date
    let summary: String
}

/// A file's blame: every line's commit, and each commit's details once.
struct BlameResult: Equatable {
    /// 1-based final line number → commit sha.
    let shaByLine: [Int: String]
    let meta: [String: BlameCommitMeta]

    static let empty = BlameResult(shaByLine: [:], meta: [:])
    /// git's sha for a line that is not committed yet.
    static let uncommittedSha = String(repeating: "0", count: 40)

    func isUncommitted(_ sha: String) -> Bool { sha == Self.uncommittedSha }
}

/// `git blame --porcelain` → `BlameResult`.
///
/// `--porcelain` rather than `--line-porcelain`: it emits a commit's headers only on that
/// commit's first appearance, so a file where three commits own a thousand lines costs three
/// header blocks instead of a thousand. The price is that the parser must carry the metadata
/// forward in a dictionary, which is what `meta` is.
enum BlameParse {

    /// `--` before the path so a file named like a revision is still read as a file.
    static func arguments(path: String) -> [String] {
        ["blame", "--porcelain", "--", path]
    }

    static func parse(_ porcelain: String) -> BlameResult {
        var shaByLine: [Int: String] = [:]
        var meta: [String: BlameCommitMeta] = [:]
        var currentSha: String?
        var author: String?
        var authorTime: Double?
        var summary: String?

        func flush() {
            guard let sha = currentSha, meta[sha] == nil,
                  let author, let authorTime, let summary else { return }
            meta[sha] = BlameCommitMeta(author: author,
                                        timestamp: Date(timeIntervalSince1970: authorTime),
                                        summary: summary)
        }

        for line in porcelain.components(separatedBy: "\n") {
            // A content line is tab-prefixed. Checking this first is what stops a line of
            // code that happens to read `author Fake` from being parsed as a header.
            if line.hasPrefix("\t") { continue }

            let fields = line.split(separator: " ", maxSplits: 3,
                                    omittingEmptySubsequences: false).map(String.init)
            // Group header: "<40-hex sha> <origLine> <finalLine> [<numLines>]". Only the
            // first group of a commit carries the numLines field.
            if let first = fields.first, isSha(first), fields.count >= 3,
               let finalLine = Int(fields[2]) {
                flush()
                currentSha = first
                author = nil; authorTime = nil; summary = nil
                shaByLine[finalLine] = first
                continue
            }

            guard let key = fields.first else { continue }
            let value = String(line.dropFirst(key.count)).trimmingCharacters(in: .whitespaces)
            switch key {
            case "author":      author = value
            case "author-time": authorTime = Double(value)
            case "summary":     summary = value
            default:            break
            }
        }
        flush()
        return BlameResult(shaByLine: shaByLine, meta: meta)
    }

    private static func isSha(_ text: String) -> Bool {
        text.count == 40 && text.allSatisfy { $0.isHexDigit }
    }
}
