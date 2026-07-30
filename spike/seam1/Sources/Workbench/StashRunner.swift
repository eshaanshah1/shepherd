import Foundation

/// The `Process` half of stashing. Synchronous — callers dispatch it off the main thread,
/// like `GitStaging` and `SequenceRunner`.
enum StashRunner {

    static func list(cwd: String) -> [Stash] {
        guard case .ok(let out) = GitStaging.run(StashList.listArguments(), cwd: cwd) else {
            return []
        }
        return StashList.parse(out)
    }

    /// Paths stashed with `-u`.
    ///
    /// A stash pushed without `-u` has **no third parent**, so this read fails — the ordinary
    /// case, and the reason the failure is swallowed into an empty list rather than surfaced.
    static func untrackedPaths(cwd: String, ref: String) -> [String] {
        guard case .ok(let out) = GitStaging.run(StashList.untrackedArguments(ref: ref),
                                                cwd: cwd) else { return [] }
        return out.split(separator: "\n").map(String.init).filter { !$0.isEmpty }
    }

    static func push(cwd: String, message: String, scope: StashScope) -> GitResult {
        GitStaging.run(StashList.pushArguments(message: message, scope: scope), cwd: cwd)
    }

    /// Apply, or pop. **A conflicted apply is not an error to hide** — git exits non-zero,
    /// leaves unmerged files and no operation, and keeps the stash entry. The caller shows
    /// git's words and then reloads, and `ConflictContext` resolves the state to `.loose`.
    static func apply(cwd: String, ref: String, pop: Bool) -> GitResult {
        GitStaging.run(StashList.applyArguments(ref: ref, pop: pop), cwd: cwd)
    }

    static func drop(cwd: String, ref: String) -> GitResult {
        GitStaging.run(StashList.dropArguments(ref: ref), cwd: cwd)
    }
}
