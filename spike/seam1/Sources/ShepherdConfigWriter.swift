import Foundation

// MARK: - Pure core (unit-tested)

/// A native ghostty key (`font-size = 13`) vs. a Shepherd key that rides a ghostty
/// comment line (`# shepherd: theme = dark`, ignored by libghostty).
enum ConfigKeyKind { case native, shepherd }

/// A single key to set in `~/.config/shepherd/config`.
struct ConfigEdit {
    let key: String
    let kind: ConfigKeyKind
    let value: String
}

/// Surgically updates specific keys in the ghostty-syntax config while preserving
/// every other line, comment, blank line, and ordering. Never clobbers a hand-written
/// file: an unknown key is appended, an existing one is rewritten in place.
enum ShepherdConfigWriter {
    static func apply(contents: String, sets edits: [ConfigEdit]) -> String {
        var lines = contents.components(separatedBy: "\n")
        // A trailing newline yields a final "" element; drop it so appends land on a
        // real line and the single trailing newline is re-added on join.
        if lines.last == "" { lines.removeLast() }
        for edit in edits {
            let rendered = render(edit)
            if let idx = lines.firstIndex(where: { matches($0, edit) }) {
                lines[idx] = rendered
            } else {
                lines.append(rendered)
            }
        }
        return lines.isEmpty ? "" : lines.joined(separator: "\n") + "\n"
    }

    private static func render(_ e: ConfigEdit) -> String {
        switch e.kind {
        case .native:   return "\(e.key) = \(e.value)"
        case .shepherd: return "# shepherd: \(e.key) = \(e.value)"
        }
    }

    private static func matches(_ line: String, _ edit: ConfigEdit) -> Bool {
        let t = line.trimmingCharacters(in: .whitespaces)
        switch edit.kind {
        case .native:
            guard !t.hasPrefix("#") else { return false }
            return keyOf(t) == edit.key
        case .shepherd:
            guard t.hasPrefix("#") else { return false }
            let afterHash = String(t.dropFirst()).trimmingCharacters(in: .whitespaces)
            guard afterHash.hasPrefix("shepherd:") else { return false }
            let body = afterHash.dropFirst("shepherd:".count).trimmingCharacters(in: .whitespaces)
            return keyOf(body) == edit.key
        }
    }

    private static func keyOf(_ s: String) -> String? {
        guard let eq = s.firstIndex(of: "=") else { return nil }
        return s[..<eq].trimmingCharacters(in: .whitespaces)
    }

    // MARK: - Reads (control CLI: `config get` / `config list`)

    /// Keys that ride a `# shepherd:` comment line rather than being native ghostty keys.
    static let shepherdKeys: Set<String> = ["theme", "worktree-base"]
    static func kind(for key: String) -> ConfigKeyKind { shepherdKeys.contains(key) ? .shepherd : .native }

    /// Read a single key's value from the config text (nil if absent).
    static func get(_ key: String, from contents: String) -> String? {
        let edit = ConfigEdit(key: key, kind: kind(for: key), value: "")
        for line in contents.components(separatedBy: "\n") where matches(line, edit) {
            return valueOf(line, kind: edit.kind)
        }
        return nil
    }

    private static func valueOf(_ line: String, kind: ConfigKeyKind) -> String? {
        var t = line.trimmingCharacters(in: .whitespaces)
        if kind == .shepherd {
            t = String(t.dropFirst()).trimmingCharacters(in: .whitespaces)   // drop leading '#'
            guard t.hasPrefix("shepherd:") else { return nil }
            t = String(t.dropFirst("shepherd:".count)).trimmingCharacters(in: .whitespaces)
        }
        guard let eq = t.firstIndex(of: "=") else { return nil }
        return t[t.index(after: eq)...].trimmingCharacters(in: .whitespaces)
    }

    // MARK: - File IO shell (Foundation only)

    /// Read `~/.config/shepherd/config` (creating its dir if needed), apply the edits,
    /// and write it back atomically. Caller triggers `reloadConfig()` afterward.
    static func set(_ edits: [ConfigEdit]) throws {
        let path = (NSHomeDirectory() as NSString).appendingPathComponent(".config/shepherd/config")
        let dir = (path as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let existing = (try? String(contentsOfFile: path, encoding: .utf8)) ?? ""
        let updated = apply(contents: existing, sets: edits)
        try updated.write(toFile: path, atomically: true, encoding: .utf8)
    }
}
