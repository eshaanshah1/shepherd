import Foundation

/// What currently sits at `~/.claude/skills/shepherd`.
enum SkillsEntry: Equatable {
    case absent
    case symlink(destination: String)
    case directory
    case file
}

enum PluginInstallState: Equatable {
    /// This build ships no bundled copy (dev builds don't — see `bundledPlugin`).
    case unavailable
    case notInstalled
    /// Linked at *this* bundle's copy.
    case installed
    /// A symlink to something else — almost always a source checkout. Never touched.
    case linkedElsewhere(String)
    /// A real directory or file. Never touched: it may be a hand-made install.
    case occupied

    var canInstall: Bool { self == .notInstalled }
}

/// Links the bundled `claude-plugin/` into Claude Code's skills dir, so an
/// installed app can enable agent tracking without a source checkout.
///
/// Install is a **symlink into the bundle**, not a copy: the updater replaces
/// Shepherd.app in place, so a link survives updates and always resolves to the
/// plugin shipped with the running build. A copy would silently go stale.
struct ClaudePluginInstaller {
    /// Pure. `bundled` is nil when the running build ships no plugin.
    static func state(entry: SkillsEntry, bundled: String?) -> PluginInstallState {
        guard let bundled = bundled.map(normalize) else { return .unavailable }
        switch entry {
        case .absent:
            return .notInstalled
        case .symlink(let destination):
            return normalize(destination) == bundled ? .installed : .linkedElsewhere(destination)
        case .directory, .file:
            return .occupied
        }
    }

    /// Trailing slashes make an otherwise-identical path compare unequal.
    static func normalize(_ path: String) -> String {
        var p = path
        while p.count > 1 && p.hasSuffix("/") { p.removeLast() }
        return p
    }
}

// MARK: - Filesystem

extension ClaudePluginInstaller {
    static var skillsDir: String {
        (NSHomeDirectory() as NSString).appendingPathComponent(".claude/skills")
    }

    static var linkPath: String {
        (skillsDir as NSString).appendingPathComponent("shepherd")
    }

    static var bundledPlugin: String? {
        guard let res = Bundle.main.resourceURL?.appendingPathComponent("claude-plugin").path,
              FileManager.default.fileExists(atPath: res) else { return nil }
        return res
    }

    static func currentEntry(fm: FileManager = .default) -> SkillsEntry {
        let path = linkPath
        // destinationOfSymbolicLink first: fileExists follows links, so a dangling
        // link would otherwise read as absent and we'd try to create it over itself.
        if let dest = try? fm.destinationOfSymbolicLink(atPath: path) {
            let abs = (dest as NSString).isAbsolutePath
                ? dest
                : ((path as NSString).deletingLastPathComponent as NSString).appendingPathComponent(dest)
            return .symlink(destination: abs)
        }
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: path, isDirectory: &isDir) else { return .absent }
        return isDir.boolValue ? .directory : .file
    }

    static func currentState() -> PluginInstallState {
        state(entry: currentEntry(), bundled: bundledPlugin)
    }

    enum InstallError: LocalizedError {
        case unavailable
        case blocked(PluginInstallState)

        var errorDescription: String? {
            switch self {
            case .unavailable:
                return "This build of Shepherd doesn't ship the Claude Code plugin."
            case .blocked:
                return "Something already exists at ~/.claude/skills/shepherd. Remove it first."
            }
        }
    }

    static func install(fm: FileManager = .default) throws {
        guard let bundled = bundledPlugin else { throw InstallError.unavailable }
        let s = currentState()
        guard s.canInstall else { throw InstallError.blocked(s) }
        try fm.createDirectory(atPath: skillsDir, withIntermediateDirectories: true)
        try fm.createSymbolicLink(atPath: linkPath, withDestinationPath: bundled)
    }

    /// Only ever removes a link we own — `currentState()` gates the caller.
    static func remove(fm: FileManager = .default) throws {
        guard currentState() == .installed else { return }
        try fm.removeItem(atPath: linkPath)
    }
}
