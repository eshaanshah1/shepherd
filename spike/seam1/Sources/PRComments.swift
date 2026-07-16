import Foundation

// MARK: - Pure core (unit-tested)

/// One GitHub PR review comment (thread root or a reply).
struct GHReviewComment: Equatable, Identifiable {
    let id: String            // GraphQL node id
    let databaseId: Int?
    let author: String        // login; "" when unknown
    let body: String
    let createdAt: String     // ISO8601 as returned; formatted at render time
}

/// One GitHub PR review thread anchored to a file:line, with its comments.
struct GHReviewThread: Equatable, Identifiable {
    let id: String            // GraphQL thread node id (reply/resolve target)
    let path: String
    let line: Int?            // nil when outdated / no longer maps to the diff
    let side: DiffSide        // RIGHT -> .new, LEFT -> .old
    let isResolved: Bool
    let isOutdated: Bool
    let comments: [GHReviewComment]   // first is the root, rest are replies
}

/// Pure parsing/reduction for PR review threads. Namespaced (like `PR`/`WorktreeArchive`)
/// so symbols don't clash with the app module under `@testable import`.
enum PRThreads {
    /// Parse `gh api graphql` output for the `repository.pullRequest.reviewThreads.nodes`
    /// query into threads. Defensive: a missing/null field degrades (nil line, "" author)
    /// rather than dropping the thread; a null pullRequest / undecodable data -> [].
    static func parse(_ data: Data) -> [GHReviewThread] {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let dataObj = obj["data"] as? [String: Any],
              let repo = dataObj["repository"] as? [String: Any],
              let pr = repo["pullRequest"] as? [String: Any],
              let rt = pr["reviewThreads"] as? [String: Any],
              let nodes = rt["nodes"] as? [[String: Any]] else { return [] }
        return nodes.map { node in
            let side: DiffSide = (node["diffSide"] as? String)?.uppercased() == "LEFT" ? .old : .new
            let commentNodes = ((node["comments"] as? [String: Any])?["nodes"] as? [[String: Any]]) ?? []
            let comments = commentNodes.map { c in
                GHReviewComment(
                    id: c["id"] as? String ?? "",
                    databaseId: c["databaseId"] as? Int,
                    author: ((c["author"] as? [String: Any])?["login"] as? String) ?? "",
                    body: c["body"] as? String ?? "",
                    createdAt: c["createdAt"] as? String ?? "")
            }
            return GHReviewThread(
                id: node["id"] as? String ?? "",
                path: node["path"] as? String ?? "",
                line: node["line"] as? Int,
                side: side,
                isResolved: node["isResolved"] as? Bool ?? false,
                isOutdated: node["isOutdated"] as? Bool ?? false,
                comments: comments)
        }
    }

    /// "https://github.com/{owner}/{repo}/pull/{n}" (or an enterprise host) -> (owner, repo).
    /// Takes the first two path components; nil if the path is too short.
    static func ownerRepo(fromURL url: String) -> (owner: String, repo: String)? {
        guard let comps = URLComponents(string: url) else { return nil }
        let parts = comps.path.split(separator: "/").map(String.init)
        guard parts.count >= 2 else { return nil }
        return (parts[0], parts[1])
    }

    /// Count of threads not yet resolved — drives the sidebar badge.
    static func unresolvedCount(_ threads: [GHReviewThread]) -> Int {
        threads.filter { !$0.isResolved }.count
    }
}
