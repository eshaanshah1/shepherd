import Foundation

/// One stash entry.
///
/// `id` is the **sha**, not the ref: dropping `stash@{0}` renumbers every entry below it, so
/// a ref-keyed selection would quietly come to mean a different stash.
struct Stash: Equatable, Identifiable {
    /// `stash@{0}` — git's own handle, and what every stash command takes.
    let ref: String
    let sha: String
    /// git's message, e.g. `On main: wip: auth`.
    let message: String
    let timestamp: Date

    var id: String { sha }
}

/// What a `git stash push` should take. Mutually exclusive by construction — git rejects
/// `--staged --include-untracked`, and an enum cannot express it.
enum StashScope: Equatable {
    /// Staged and unstaged tracked changes.
    case all
    /// Only what is staged.
    case stagedOnly
    /// Tracked changes plus untracked files.
    case includingUntracked
}

/// The stash list, and the git argument lists that read and write stashes.
///
/// Pure: the argument builders and the parse are the parts a test can catch being wrong. The
/// `Process` work lives in `StashRunner`, like `WorktreeService`.
enum StashList {

    /// Separators **in git's output**.
    private static let fieldSeparator = "\u{0}"
    private static let recordSeparator = "\u{1e}"

    /// The same separators as git **format escapes**, for the argument.
    ///
    /// These must not be the literal characters above. `Process` turns every argument into a
    /// C string, a Swift string holding a NUL has none, and `run()` throws
    /// `NSInvalidArgumentException` — an **ObjC** exception `try`/`catch` cannot see, so the
    /// app dies. That crashed the workbench on ⌘G once; `CommitHistory` carries the same note.
    private static let fieldEscape = "%x00"
    private static let recordEscape = "%x1e"

    /// `%gd` is the ref (`stash@{0}`), `%gs` the reflog subject git shows in `stash list`.
    ///
    /// Records are RS-delimited rather than newline-delimited because `git stash push -m`
    /// accepts a message containing a newline.
    static func listArguments() -> [String] {
        ["stash", "list",
         "--format=%gd\(fieldEscape)%H\(fieldEscape)%at\(fieldEscape)%gs\(recordEscape)"]
    }

    static func parse(_ output: String) -> [Stash] {
        output.components(separatedBy: recordSeparator).compactMap { record in
            // Only the newline between records is noise; a newline *inside* the message is
            // content, and trimming just the ends preserves it.
            let trimmed = record.trimmingCharacters(in: .newlines)
            guard !trimmed.isEmpty else { return nil }
            let fields = trimmed.components(separatedBy: fieldSeparator)
            // A short record is dropped rather than filled with blanks: a half-parsed ref
            // would drive `git stash drop` at the wrong entry, which nothing undoes.
            guard fields.count >= 4, let epoch = Double(fields[2]) else { return nil }
            return Stash(ref: fields[0], sha: fields[1], message: fields[3],
                         timestamp: Date(timeIntervalSince1970: epoch))
        }
    }

    /// An empty message is omitted entirely so git names the stash itself — `-m ""` would set
    /// a blank one.
    static func pushArguments(message: String, scope: StashScope) -> [String] {
        var args = ["stash", "push"]
        switch scope {
        case .all:                break
        case .stagedOnly:         args.append("--staged")
        case .includingUntracked: args.append("--include-untracked")
        }
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { args += ["-m", trimmed] }
        return args
    }

    static func applyArguments(ref: String, pop: Bool) -> [String] {
        ["stash", pop ? "pop" : "apply", ref]
    }

    static func dropArguments(ref: String) -> [String] {
        ["stash", "drop", ref]
    }

    /// Paths of the files stashed with `-u`.
    ///
    /// They live in the stash's **third parent** and appear nowhere in the first-parent diff
    /// (measured). A stash pushed without `-u` has no third parent, so this read fails for
    /// most stashes — an ordinary outcome, not an error.
    static func untrackedArguments(ref: String) -> [String] {
        ["ls-tree", "-r", "--name-only", "\(ref)^3"]
    }
}
