import Foundation

/// One `git ls-files -u` record: a single index stage of a single unmerged path.
struct UnmergedEntry: Equatable {
    let mode: String
    let sha: String
    /// 1 = common ancestor, 2 = ours, 3 = theirs.
    let stage: Int
    let path: String
}

/// Reading git's unmerged-index bookkeeping. Pure; the `Process` half is `ConflictReader`.
enum ConflictParse {

    /// Parse `git ls-files -u -z` output — `<mode> <sha> <stage>\t<path>` per NUL-terminated
    /// record.
    ///
    /// `-z` rather than line-oriented output because git quotes and escapes paths containing
    /// spaces, quotes or non-ASCII in the default format, and un-escaping that correctly is a
    /// job nobody should be doing twice.
    static func entries(_ output: String) -> [UnmergedEntry] {
        output.split(separator: "\0", omittingEmptySubsequences: true).compactMap { record in
            let halves = record.split(separator: "\t", maxSplits: 1,
                                      omittingEmptySubsequences: false)
            guard halves.count == 2, !halves[1].isEmpty else { return nil }
            let meta = halves[0].split(separator: " ", omittingEmptySubsequences: true)
            guard meta.count == 3, let stage = Int(meta[2]), (1...3).contains(stage) else {
                return nil
            }
            return UnmergedEntry(mode: String(meta[0]), sha: String(meta[1]),
                                 stage: stage, path: String(halves[1]))
        }
    }

    /// Group entries by path, preserving git's order, so the rail lists files the way git
    /// does rather than in dictionary order.
    static func byPath(_ entries: [UnmergedEntry]) -> [(path: String, stages: [Int: UnmergedEntry])] {
        var order: [String] = []
        var grouped: [String: [Int: UnmergedEntry]] = [:]
        for entry in entries {
            if grouped[entry.path] == nil { order.append(entry.path) }
            grouped[entry.path, default: [:]][entry.stage] = entry
        }
        return order.map { (path: $0, stages: grouped[$0] ?? [:]) }
    }

    /// What kind of conflict a stage set describes.
    ///
    /// `.binary` is deliberately absent: which stages exist cannot tell you that. The reader
    /// decides it by failing to decode a blob as UTF-8.
    static func kind(stages: Set<Int>) -> ConflictKind {
        switch (stages.contains(1), stages.contains(2), stages.contains(3)) {
        case (true, true, true):   return .content
        case (false, true, true):  return .addAdd
        case (true, true, false):  return .deletedByThem
        case (true, false, true):  return .deletedByUs
        default:                   return .unknown
        }
    }

    /// How many conflict regions git itself wrote into the worktree file.
    ///
    /// The tripwire for the one real risk of computing our own diff3: our region boundaries
    /// could in principle differ from git's, and the dangerous direction is us silently
    /// auto-resolving something git asked about. This is marker **counting** as a sanity
    /// check, not marker scraping as a parse — the file is never the source of truth for
    /// what the conflict is.
    static func markerCount(_ text: String) -> Int {
        text.components(separatedBy: "\n").reduce(0) { count, line in
            line.hasPrefix("<<<<<<<") ? count + 1 : count
        }
    }
}
