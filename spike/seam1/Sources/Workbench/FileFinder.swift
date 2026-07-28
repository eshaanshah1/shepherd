import Foundation

/// One ranked path, with the characters the query matched so the row can highlight them.
struct FileMatch: Equatable {
    let path: String
    let score: Int
    /// Character offsets into `path` that the query matched, ascending.
    let matched: [Int]
}

/// Subsequence matching for the workbench's `⌘P`.
///
/// Pure and scored by properties rather than a single number pulled out of the air: the
/// tests assert the *ordering* a file finder has to get right (basename over directory,
/// consecutive over scattered, shorter over longer), not the weights.
/// A repo's paths, pre-chewed into the form `FileFinder.match` actually scans.
///
/// Built once when the file list arrives, not per keystroke. `match` needs each path as two
/// `[Character]` arrays — lowercased for comparison, original for camelCase boundaries — and
/// building those inside the scan meant **two array allocations per file per keystroke**.
/// On a repo of any size that is the whole cost of typing.
struct FileIndex {
    struct Entry {
        let path: String
        let lower: [Character]
        let original: [Character]
        let basenameStart: Int
    }

    let entries: [Entry]

    init(_ paths: [String] = []) {
        entries = paths.map { path in
            let original = Array(path)
            let lower = Array(path.lowercased())
            return Entry(path: path, lower: lower, original: original,
                         basenameStart: (lower.lastIndex(of: "/").map { $0 + 1 }) ?? 0)
        }
    }

    var isEmpty: Bool { entries.isEmpty }
    var count: Int { entries.count }
}

enum FileFinder {

    /// Rank paths against a query, best first. An empty query keeps the input order.
    ///
    /// Convenience over the indexed form, for callers holding a bare list — it pays the
    /// index cost on every call, so it is not the one the UI uses.
    static func rank(_ paths: [String], query: String, limit: Int = 50) -> [FileMatch] {
        rank(FileIndex(paths), query: query, limit: limit)
    }

    static func rank(_ index: FileIndex, query: String, limit: Int = 50) -> [FileMatch] {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else {
            return index.entries.prefix(limit).map {
                FileMatch(path: $0.path, score: 0, matched: [])
            }
        }
        let needle = Array(trimmed.lowercased())
        return index.entries.compactMap { match($0, needle: needle) }
            // Ties broken by path so the list doesn't reshuffle between identical scores.
            .sorted { $0.score != $1.score ? $0.score > $1.score : $0.path < $1.path }
            .prefix(limit)
            .map { $0 }
    }

    /// Score one path, or nil when the query is not a subsequence of it.
    ///
    /// Greedy earliest match, run twice: once over the whole path and once from the file's
    /// name. Scanning only from the left spends the query's first letter on a directory —
    /// `src/` eats the `s` of `session` — and the result then scores *below* a path that
    /// merely contains the word in a folder name. Greedy always finds a subsequence when
    /// one exists, and it is predictable; a smarter optimum that reorders results as you
    /// type reads as jitter.
    static func match(path: String, query: String) -> FileMatch? {
        let needle = Array(query.lowercased())
        guard !needle.isEmpty else { return FileMatch(path: path, score: 0, matched: []) }
        return match(FileIndex([path]).entries[0], needle: needle)
    }

    private static func match(_ entry: FileIndex.Entry, needle: [Character]) -> FileMatch? {
        let haystack = entry.lower
        let original = entry.original
        let basenameStart = entry.basenameStart
        let path = entry.path
        guard !needle.isEmpty else { return FileMatch(path: path, score: 0, matched: []) }
        let starts = basenameStart > 0 ? [0, basenameStart] : [0]
        let candidates = starts.compactMap {
            greedy(haystack, needle: needle, original: original,
                   from: $0, basenameStart: basenameStart)
        }
        guard let best = candidates.max(by: { $0.score < $1.score }) else { return nil }
        // Prefer the shorter of two otherwise-equal paths, gently enough that a strong
        // match in a deep path still beats a weak one at the root.
        return FileMatch(path: path, score: best.score - original.count / 8,
                         matched: best.matched)
    }

    private static func greedy(_ haystack: [Character], needle: [Character],
                               original: [Character], from start: Int,
                               basenameStart: Int) -> (score: Int, matched: [Int])? {
        var matched: [Int] = []
        var cursor = 0
        var previous = -2
        var score = 0

        for index in start..<haystack.count {
            guard cursor < needle.count, haystack[index] == needle[cursor] else { continue }
            if index == previous + 1 { score += 8 }
            // Boundaries are read off the *original* casing, so a camelCase hump counts —
            // typing "rp" for RowPlan.swift is the idiom this exists to serve.
            if isBoundary(original, at: index) { score += 6 }
            matched.append(index)
            previous = index
            cursor += 1
        }
        guard cursor == needle.count else { return nil }
        // What you type is almost always part of the file's name, not its directory.
        if let first = matched.first, first >= basenameStart { score += 12 }
        return (score, matched)
    }

    /// Whether a character starts a "word": the path start, after a separator, or the
    /// upper-case half of a camelCase hump.
    private static func isBoundary(_ characters: [Character], at index: Int) -> Bool {
        guard index > 0 else { return true }
        let previous = characters[index - 1]
        if previous == "/" || previous == "_" || previous == "-" || previous == "." {
            return true
        }
        return previous.isLowercase && characters[index].isUppercase
    }
}
