import Foundation

/// A local branch, as a cherry-pick source.
struct Ref: Equatable, Identifiable {
    let name: String
    /// The worktree this branch is checked out in, or nil.
    ///
    /// Non-empty exactly when git has it checked out somewhere — the main checkout included.
    /// In Shepherd that reads as "an agent is working here", because worktrees are how panes
    /// get their own branch.
    let worktreePath: String?
    let subject: String
    let timestamp: Date

    var id: String { name }
    var isCheckedOut: Bool { worktreePath != nil }
}

/// Local branches for the cherry-pick source picker.
///
/// Pure: argument builder plus parse. `GitStaging.listBranches` stays as it is — it feeds the
/// existing checkout menu and only needs names.
enum RefList {

    private static let fieldSeparator = "\u{0}"
    private static let recordSeparator = "\u{1e}"
    /// Format **escapes**, never the literal separators — see `CommitHistory`'s note: a Swift
    /// argument containing a NUL cannot become a C string and kills the process.
    private static let fieldEscape = "%x00"
    private static let recordEscape = "%x1e"

    /// Newest first. Sorting is git's job; the parse must not reorder.
    static func arguments() -> [String] {
        ["for-each-ref", "--sort=-committerdate",
         "--format=%(refname:short)\(fieldEscape)%(worktreepath)\(fieldEscape)"
         + "%(committerdate:unix)\(fieldEscape)%(subject)\(recordEscape)",
         "refs/heads"]
    }

    /// `currentBranch` is excluded: cherry-picking from yourself is not a thing, and it is the
    /// one branch whose `worktreepath` is always set.
    static func parse(_ output: String, currentBranch: String?) -> [Ref] {
        output.components(separatedBy: recordSeparator).compactMap { record in
            let trimmed = record.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return nil }
            let fields = trimmed.components(separatedBy: fieldSeparator)
            guard fields.count >= 4, let epoch = Double(fields[2]) else { return nil }
            let name = fields[0]
            guard !name.isEmpty, name != currentBranch else { return nil }
            return Ref(name: name,
                       worktreePath: fields[1].isEmpty ? nil : fields[1],
                       subject: fields[3],
                       timestamp: Date(timeIntervalSince1970: epoch))
        }
    }
}
