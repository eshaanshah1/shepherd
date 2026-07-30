import Foundation

/// Starts an interactive rebase from a plan.
///
/// The whole trick, and it is the same one `SequenceRunner` already uses for `GIT_EDITOR`:
/// **`GIT_SEQUENCE_EDITOR` is a command string git appends the todo path to**, so
/// `cp '<our todo>'` becomes `cp '<our todo>' <git's todo>` — a substitution needing no tty.
/// Verified against git 2.55, including a path containing a space.
///
/// Left alone this is not a failure but a **hang**: an app-spawned `Process` has no tty, so
/// git's default editor waits forever holding the session's `writing` flag. That is the
/// recorded lesson from `GIT_EDITOR`, and it applies identically here.
enum RebaseRunner {

    /// Apply a plan. Refuses before git runs when the plan is not applyable, so a bad plan
    /// leaves nothing to abort.
    ///
    /// `original` is the commit list the plan was built from — **required, and not derivable
    /// from `rows`**. Deriving it (`rows.map(\.commit)`) makes `isNoOp` compare the plan against
    /// itself, and since a reorder changes neither the verbs nor the set of shas, every
    /// reorder-only plan then reads as "nothing to apply". That rejected the feature's main
    /// case while the no-op test still passed.
    static func apply(cwd: String, base: String, rows: [PlanRow],
                      original: [Commit]) -> GitResult {
        if let reason = RebasePlan.blockedReason(rows: rows, original: original) {
            return .failed(reason)
        }
        let todo = RebasePlan.todo(for: rows)
        guard !todo.isEmpty else { return .failed("every commit is dropped") }

        let temp = FileManager.default.temporaryDirectory
            .appendingPathComponent("shepherd-todo-\(UUID().uuidString).txt")
        do {
            try todo.write(to: temp, atomically: true, encoding: .utf8)
        } catch {
            return .failed("Could not stage the rebase plan: \(error.localizedDescription)")
        }
        defer { try? FileManager.default.removeItem(at: temp) }

        // Single-quoted because git runs the string through a shell.
        var env = ["GIT_SEQUENCE_EDITOR": "cp '\(temp.path)'"]

        // At most one entry opens an editor — `RebasePlan.blockedReason` enforces it, because
        // one `cp` can substitute exactly one message.
        var messageTemp: URL?
        if let entry = RebasePlan.messageEntry(rows: rows) {
            let file = FileManager.default.temporaryDirectory
                .appendingPathComponent("shepherd-msg-\(UUID().uuidString).txt")
            do {
                try (entry.message + "\n").write(to: file, atomically: true, encoding: .utf8)
            } catch {
                return .failed("Could not stage the commit message: \(error.localizedDescription)")
            }
            messageTemp = file
            env["GIT_EDITOR"] = "cp '\(file.path)'"
        } else {
            // Nothing should open an editor, but `true` rather than nothing at all: if git ever
            // asks, it gets an immediate zero exit instead of hanging on a tty that is not there.
            env["GIT_EDITOR"] = "true"
        }
        defer { if let messageTemp { try? FileManager.default.removeItem(at: messageTemp) } }

        return GitStaging.run(["rebase", "-i", base], cwd: cwd, env: env)
    }
}
