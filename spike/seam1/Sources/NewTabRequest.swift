import Foundation

/// Where a composed tab is headed and what that destination allows. `isGitRepo` is
/// resolved by the caller (local: the default dir is a work tree; mirror: a path is
/// wired), so this stays pure.
struct NewTabTarget: Equatable {
    let workspaceID: String
    let name: String
    let isRemote: Bool
    let isGitRepo: Bool
}

/// Everything the ⌘T composer collects, and every rule about it. The view draws this
/// and decides nothing itself.
struct NewTabRequest: Equatable {
    var target: NewTabTarget
    var title: String = ""
    var prompt: String = ""
    var worktree: Bool = false
    /// Which Claude account the tab runs as. nil = whatever the workspace uses.
    var claudeProfileID: String? = nil

    private(set) var branchEdited = false
    private(set) var typedBranch = ""

    init(target: NewTabTarget, worktree: Bool = false) {
        self.target = target
        self.worktree = worktree
    }

    /// The branch mirrors a slugged title until the field is touched; after that it is
    /// the user's, even when they clear it.
    var branch: String { branchEdited ? typedBranch.trimmed : Self.slug(title) }

    mutating func setBranch(_ s: String) {
        typedBranch = s
        branchEdited = true
    }

    mutating func retarget(_ t: NewTabTarget) { target = t }

    var worktreeAvailable: Bool { target.isGitRepo }
    var promptAvailable: Bool { !target.isRemote }
    var usesWorktree: Bool { worktree && worktreeAvailable }

    var canCreate: Bool { usesWorktree ? !branch.isEmpty : true }

    var effectiveTitle: String? { title.trimmed.isEmpty ? nil : title.trimmed }
    var effectivePrompt: String { promptAvailable ? prompt.trimmed : "" }

    var worktreeHint: String? {
        worktreeAvailable ? nil : "set a directory for this workspace"
    }
    var promptHint: String? {
        promptAvailable ? nil : "prompts run on the host — not yet supported"
    }
    var createHint: String? { canCreate ? nil : "name the worktree" }

    /// A title turned into something `git check-ref-format` accepts: lowercase, runs of
    /// anything git refuses folded to one `-`, and the cases git rejects outright (`..`,
    /// a `.lock` suffix, leading/trailing punctuation) removed.
    static func slug(_ s: String) -> String {
        let allowed = Set("abcdefghijklmnopqrstuvwxyz0123456789-./_")
        var out = ""
        for ch in s.lowercased() {
            out.append(allowed.contains(ch) ? (ch == "_" ? "-" : ch) : "-")
        }
        while out.contains("..") { out = out.replacingOccurrences(of: "..", with: "-") }
        while out.contains("--") { out = out.replacingOccurrences(of: "--", with: "-") }
        while out.hasSuffix(".lock") { out.removeLast(5) }
        let edges = CharacterSet(charactersIn: "-./")
        return out.trimmingCharacters(in: edges)
    }
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
