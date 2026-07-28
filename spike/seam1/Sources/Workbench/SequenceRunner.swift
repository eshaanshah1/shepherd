import Foundation

/// Runs `<verb> --continue`, and reads the message git is about to commit.
///
/// The hazard this exists to handle: `--continue` opens `$GIT_EDITOR` for the commit message,
/// and a `Process` spawned from an app bundle has no tty — so left alone it hangs forever
/// holding the session's `writing` flag, which is an unkillable spinner rather than an error.
enum SequenceRunner {

    /// The message git parked for the stopped commit, raw (comments included), or nil when
    /// there is no pending commit at all — a rebase stopped on `break`, for instance.
    static func pendingMessage(cwd: String, operation: MergeState.Operation) -> String? {
        guard let name = SequencePolicy.messageFileName(operation),
              case .ok(let resolved) = GitStaging.run(["rev-parse", "--git-path", name],
                                                     cwd: cwd) else { return nil }
        let relative = resolved.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !relative.isEmpty else { return nil }
        // `--git-path` answers relative to the repo root for an ordinary checkout and
        // absolute for a linked worktree, so both shapes have to be handled.
        let path = relative.hasPrefix("/")
            ? relative
            : (cwd as NSString).appendingPathComponent(relative)
        guard let contents = try? String(contentsOfFile: path, encoding: .utf8),
              !contents.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return contents
    }

    /// Continue the operation. `message` nil keeps git's own message verbatim.
    ///
    /// Returns an outcome rather than a `GitResult` because a non-zero exit here does **not**
    /// mean failure: git exits non-zero when it stops at the next commit's conflict, which is
    /// the loop working. `SequencePolicy.outcome` draws that line, off whether HEAD moved.
    static func cont(cwd: String, operation: MergeState.Operation,
                     message: String?) -> ContinueOutcome {
        guard let args = SequencePolicy.continueArguments(operation) else {
            return .failed("nothing in progress")
        }
        let headBefore = head(cwd: cwd)
        let result: GitResult
        if let message, !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            // Reword. `GIT_EDITOR` is a *command string* that git appends the file path to, so
            // `cp <ours>` becomes `cp <ours> <git's message file>` — a substitution needing no
            // tty, and one that does not depend on which file git parked the message in.
            let temp = FileManager.default.temporaryDirectory
                .appendingPathComponent("shepherd-msg-\(UUID().uuidString).txt")
            do {
                try (message + "\n").write(to: temp, atomically: true, encoding: .utf8)
            } catch {
                return .failed("Could not stage the commit message: \(error.localizedDescription)")
            }
            defer { try? FileManager.default.removeItem(at: temp) }
            // Single-quoted because git runs that string through a shell.
            result = GitStaging.run(args, cwd: cwd, env: ["GIT_EDITOR": "cp '\(temp.path)'"])
        } else {
            // Accept the message as-is: `true` exits 0 having written nothing, which git reads
            // as "the user saved it unchanged".
            result = GitStaging.run(args, cwd: cwd, env: ["GIT_EDITOR": "true"])
        }

        return SequencePolicy.outcome(succeeded: result.isOK,
                                      errorText: result.errorText,
                                      headMoved: head(cwd: cwd) != headBefore,
                                      stillActive: isActive(cwd: cwd),
                                      unmergedAfter: unmergedCount(cwd: cwd))
    }

    private static func head(cwd: String) -> String? {
        guard case .ok(let sha) = GitStaging.run(["rev-parse", "HEAD"], cwd: cwd) else {
            return nil
        }
        return sha.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Whether git is still part-way through something. Read from git's own files, never
    /// cached — the same rule `ConflictReader.readState` follows.
    private static func isActive(cwd: String) -> Bool {
        for name in ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD"] {
            guard case .ok(let resolved) = GitStaging.run(["rev-parse", "--git-path", name],
                                                         cwd: cwd) else { continue }
            let relative = resolved.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !relative.isEmpty else { continue }
            let path = relative.hasPrefix("/")
                ? relative
                : (cwd as NSString).appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: path) { return true }
        }
        return false
    }

    private static func unmergedCount(cwd: String) -> Int {
        guard case .ok(let out) = GitStaging.run(["ls-files", "-u"], cwd: cwd) else { return 0 }
        return out.split(separator: "\n").filter { !$0.isEmpty }.count
    }
}
