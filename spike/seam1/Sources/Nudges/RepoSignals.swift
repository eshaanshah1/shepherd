import Foundation

/// Cheap git facts about one pane's checkout — everything a nudge may need and nothing
/// that costs a blob read.
///
/// `state` is `MergeState` rather than a local operation enum on purpose: two types that
/// both mean "which operation is git part-way through" can disagree, and this one is
/// already read and tested by the merge resolver.
struct RepoSignals: Equatable {
    var state: MergeState = .idle
    /// Conflicted **paths**, not index records.
    var conflicts: Int = 0
    /// Lines of `git status --porcelain` — tracked edits, staged changes and untracked
    /// files alike. A file an agent just created is a change worth reviewing.
    var dirty: Int = 0
    /// Commits on this branch that the base does not have.
    var ahead: Int = 0
    var branch: String?
    var hasUpstream: Bool = false

    static let none = RepoSignals()
}

// MARK: - Pure parsers

extension RepoSignals {

    /// Unique paths in `git ls-files -u -z` output.
    ///
    /// git prints one record per index stage, so an ordinary content conflict arrives three
    /// times and a delete/modify twice. The path is everything after the first tab, and the
    /// record ends at the NUL — so a path containing a space, a tab or a newline is safe.
    static func unmergedCount(lsFilesZ: String) -> Int {
        var paths = Set<String>()
        for record in lsFilesZ.split(separator: "\0", omittingEmptySubsequences: true) {
            guard let tab = record.firstIndex(of: "\t") else { continue }
            paths.insert(String(record[record.index(after: tab)...]))
        }
        return paths.count
    }

    static func dirtyCount(porcelain: String) -> Int {
        porcelain.split(separator: "\n")
            .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            .count
    }

    /// `rev-list --count` output, or 0 for anything unparseable — an empty repo makes the
    /// command fail and print nothing.
    static func revCount(_ out: String) -> Int {
        Int(out.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
    }
}
