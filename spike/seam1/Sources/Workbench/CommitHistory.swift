import Foundation

/// One commit on the branch. `id` is the full sha so a list selection survives a reload.
struct Commit: Equatable, Identifiable {
    let sha: String
    let shortSha: String
    let subject: String
    let author: String
    let timestamp: Date

    var id: String { sha }
}

/// The branch's commits, and the git argument lists that read history.
///
/// Pure: the argument builders and the parse are the parts that can be wrong in a way a
/// test can see. The `Process` work lives in the session, like `WorktreeService`.
enum CommitHistory {

    /// NUL between fields, RS ending each record — **in git's output**.
    ///
    /// A subject can contain any byte a terminal can print — `|`, brackets, quotes — so a
    /// human-readable delimiter would eventually split one. These two are the only characters
    /// git will not emit from `%s` or `%an`.
    private static let fieldSeparator = "\u{0}"
    private static let recordSeparator = "\u{1e}"

    /// The same two separators as git **format escapes**, for the argument.
    ///
    /// These must not be the literal characters above. `Process` turns every argument into a C
    /// string via `fileSystemRepresentation`, and a Swift string holding a NUL has none — so
    /// `run()` throws `NSInvalidArgumentException`, an **ObjC** exception that `GitStaging.run`'s
    /// `try`/`catch` cannot see, and the app dies. That crashed the workbench on ⌘G.
    ///
    /// `%x00` is four ASCII characters that *git* expands in its output, so the bytes the parser
    /// splits on are identical while the argument stays printable. Passing `%x00` in a shell and
    /// writing `"\u{0}"` in Swift look the same downstream and are not the same thing at all.
    private static let fieldEscape = "%x00"
    private static let recordEscape = "%x1e"

    /// `<base>..HEAD` — what this branch has done, which is the question the Commits scope
    /// answers. `%at` is the author date as a UNIX timestamp, so nothing has to parse a
    /// locale-dependent date string.
    static func logArguments(base: String) -> [String] {
        ["log",
         "--format=%H\(fieldEscape)%h\(fieldEscape)%an\(fieldEscape)%at\(fieldEscape)%s\(recordEscape)",
         "\(base)..HEAD"]
    }

    /// A file's whole text as of a commit. `<sha>:<path>` takes a **repo-relative** path.
    static func blobArguments(sha: String, path: String) -> [String] {
        ["show", "\(sha):\(path)"]
    }

    static func parse(_ output: String) -> [Commit] {
        output.components(separatedBy: recordSeparator).compactMap { record in
            let trimmed = record.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return nil }
            let fields = trimmed.components(separatedBy: fieldSeparator)
            // A short record is dropped rather than filled with blanks: a half-parsed sha
            // would drive `git show` at nothing.
            guard fields.count >= 5, let epoch = Double(fields[3]) else { return nil }
            return Commit(sha: fields[0], shortSha: fields[1], subject: fields[4],
                          author: fields[2],
                          timestamp: Date(timeIntervalSince1970: epoch))
        }
    }

    /// Compact age for a one-line row: `now` / `10m` / `2h` / `2d` / `2w`.
    static func relativeAge(_ date: Date, now: Date) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        switch seconds {
        case ..<60:     return "now"
        case ..<3600:   return "\(Int(seconds / 60))m"
        case ..<86400:  return "\(Int(seconds / 3600))h"
        case ..<604800: return "\(Int(seconds / 86400))d"
        default:        return "\(Int(seconds / 604800))w"
        }
    }
}
