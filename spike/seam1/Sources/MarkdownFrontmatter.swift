import Foundation

/// Pure YAML-frontmatter handling ([ADR 0019]). CommonMark has no concept of
/// frontmatter (it would render `---\nkey: val\n---` as a thematic break + a setext
/// heading of the YAML), so we split it off before parsing the body and render it
/// natively as a key/value metadata block — diffed field by field, no code-block proxy.
enum MarkdownFrontmatter {
    struct Field: Equatable { let key: String; let value: String }

    /// Split a document into its optional leading frontmatter fields and the markdown
    /// body. Frontmatter is a dash run (`---`) on the very first line closed by the next
    /// dash run or `...`; otherwise there is none and the whole source is the body.
    static func split(_ source: String) -> (fields: [Field]?, body: String) {
        let lines = source.components(separatedBy: "\n")
        guard isFence(lines.first, allowEllipsis: false),
              let close = lines.indices.dropFirst().first(where: { isFence(lines[$0], allowEllipsis: true) })
        else { return (nil, source) }
        let inner = close > 1 ? lines[1..<close].joined(separator: "\n") : ""
        let bodyLines = close + 1 <= lines.count - 1 ? Array(lines[(close + 1)...]) : []
        let body = bodyLines.drop(while: { $0.trimmingCharacters(in: .whitespaces).isEmpty })
            .joined(separator: "\n")
        return (parse(inner), body)
    }

    /// Parse frontmatter inner text into ordered fields. `key: value` splits on the first
    /// colon; a line without a colon becomes a valueless field; blank lines are dropped.
    static func parse(_ inner: String) -> [Field] {
        inner.components(separatedBy: "\n").compactMap { line in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { return nil }
            guard let colon = trimmed.firstIndex(of: ":") else { return Field(key: trimmed, value: "") }
            let key = String(trimmed[..<colon]).trimmingCharacters(in: .whitespaces)
            let value = String(trimmed[trimmed.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
            return Field(key: key, value: value)
        }
    }

    private static func isFence(_ line: String?, allowEllipsis: Bool) -> Bool {
        guard let line else { return false }
        let t = line.trimmingCharacters(in: .whitespaces)
        if allowEllipsis && t == "..." { return true }
        return t.count >= 3 && t.allSatisfy { $0 == "-" }
    }
}
