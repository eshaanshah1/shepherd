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

    /// Everything `git status --porcelain=v2 --branch` carries, in one pass.
    ///
    /// Branch, upstream, ahead, dirty and conflict counts were five separate `git`
    /// invocations plus a `rev-list`; one status prints all of them, and this runs on every
    /// git write in the repo.
    struct StatusV2: Equatable {
        var dirty = 0
        var conflicts = 0
        var ahead = 0
        var branch: String?
        var hasUpstream = false
    }

    /// `ahead` is only filled when an upstream is set — that is the only case git prints
    /// `branch.ab` for, and there is no honest count without a base.
    static func parseStatusV2(_ out: String) -> StatusV2 {
        var s = StatusV2()
        for line in out.split(separator: "\n", omittingEmptySubsequences: true) {
            if let name = line.dropPrefix("# branch.head ") {
                s.branch = (name == "(detached)" || name.isEmpty) ? nil : String(name)
            } else if line.hasPrefix("# branch.upstream ") {
                s.hasUpstream = true
            } else if let ab = line.dropPrefix("# branch.ab "),
                      let plus = ab.split(separator: " ").first, plus.hasPrefix("+") {
                s.ahead = Int(plus.dropFirst()) ?? 0
            } else if line.hasPrefix("u ") {
                s.conflicts += 1          // one record per unmerged path, unlike `ls-files -u`
                s.dirty += 1
            } else if line.hasPrefix("1 ") || line.hasPrefix("2 ") || line.hasPrefix("? ") {
                s.dirty += 1
            }
        }
        return s
    }

    /// `rev-list --count` output, or 0 for anything unparseable — an empty repo makes the
    /// command fail and print nothing.
    static func revCount(_ out: String) -> Int {
        Int(out.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
    }
}

private extension Substring {
    func dropPrefix(_ prefix: String) -> Substring? {
        hasPrefix(prefix) ? dropFirst(prefix.count) : nil
    }
}
