import Foundation

/// Finds the repo's pull-request template, so the create-PR prompt opens pre-filled with
/// the form a human would have got on GitHub.
enum PRTemplate {

    /// GitHub's documented locations, in GitHub's order.
    static let searchOrder = ["pull_request_template.md",
                              "docs/pull_request_template.md",
                              ".github/pull_request_template.md"]

    /// The template to use, given every path in the repo. nil when there is none — or when
    /// the only candidates sit in a `PULL_REQUEST_TEMPLATE/` directory, which GitHub selects
    /// only through its `?template=` parameter. Guessing one there would silently apply the
    /// wrong convention.
    static func pick(from names: [String]) -> String? {
        for candidate in searchOrder {
            if let hit = names.first(where: { $0.lowercased() == candidate }) { return hit }
        }
        return nil
    }

    /// The template's contents, or nil.
    static func body(inRepo cwd: String) -> String? {
        // `ls-files` rather than a directory walk: it is already the repo's own view of what
        // exists, and it costs one process instead of several stats.
        guard case .ok(let listing) = GitStaging.run(
            ["ls-files", "--", "pull_request_template.md", "PULL_REQUEST_TEMPLATE.md",
             "docs/", ".github/"], cwd: cwd) else { return nil }
        let names = listing.split(separator: "\n").map(String.init)
        guard let pick = pick(from: names) else { return nil }
        let path = (cwd as NSString).appendingPathComponent(pick)
        return try? String(contentsOfFile: path, encoding: .utf8)
    }
}
