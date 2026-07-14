import Foundation

// MARK: - Pure core (unit-tested)

/// A worktree that was archived: its directory reclaimed from disk, its uncommitted
/// work preserved as two detached commits kept alive by `protectionRef`. Restorable
/// until it expires (see `expireArchives`). Persisted as JSON under
/// `shepherd.archived-worktrees.v1`.
struct ArchivedWorktree: Codable, Identifiable, Equatable {
    var id: String
    var workspaceID: String   // the folder it was archived from (where Restore reopens it)
    var workspaceName: String? = nil  // its display name at archive time — recreated if the workspace is gone
    var repoDir: String       // the MAIN worktree / repo the git refs live in
    var branch: String        // the worktree's branch ("" if it was detached)
    var name: String          // display name (the tab title at archive time)
    var dest: String          // the original worktree path (Restore recreates it here)
    var headCommit: String    // branch tip at archive time
    var archivedAt: Date
    var sessionID: String?    // live Claude session id, replayed as `claude --resume` on Restore

    /// GC-protection ref that keeps the WIP commit chain reachable against `git gc`.
    var protectionRef: String { WorktreeArchive.protectionRefName(id: id) }
}

enum WorktreeArchive {
    /// Retention before an archive is auto-deleted on launch. Literal days.
    static let retentionDays = 90

    static func protectionRefName(id: String) -> String {
        "refs/shepherd/archived-worktrees/\(id)"
    }

    /// Partition archives into keep vs expired by **literal elapsed time** —
    /// `now - archivedAt >= retentionDays * 86400`, no calendar-day rounding.
    static func expireArchives(_ archives: [ArchivedWorktree], now: Date,
                               retentionDays: Int = retentionDays) -> (keep: [ArchivedWorktree], expired: [ArchivedWorktree]) {
        let cutoff = Double(retentionDays) * 86_400
        var keep: [ArchivedWorktree] = [], expired: [ArchivedWorktree] = []
        for a in archives {
            if now.timeIntervalSince(a.archivedAt) >= cutoff { expired.append(a) }
            else { keep.append(a) }
        }
        return (keep, expired)
    }

    /// A compact age label using literal durations: "just now" / "<n>h" under a
    /// day, then whole days ("7d", "30d", "89d") — never rounded up to weeks/months.
    static func archiveAgeString(_ archivedAt: Date, now: Date) -> String {
        let secs = max(0, now.timeIntervalSince(archivedAt))
        if secs < 3_600 { return "just now" }
        if secs < 86_400 { return "\(Int(secs / 3_600))h" }
        return "\(Int(secs / 86_400))d"
    }
}
