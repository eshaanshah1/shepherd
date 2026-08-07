import Foundation
import CryptoKit

/// One Claude Code account, addressed by the config dir it lives in.
///
/// Claude Code keys *everything* off `CLAUDE_CONFIG_DIR` — settings, projects,
/// sessions, MCP servers, skills, and (on macOS, via a hash in the Keychain service
/// name) the login itself. So "a second account" is just "a second config dir", and
/// Shepherd's whole job is deciding which one a pane's PTY gets.
struct ClaudeProfile: Identifiable, Codable, Equatable {
    var id: String
    var name: String
    /// Tilde-allowed path. **nil = Claude Code's own default**, which is not the same
    /// thing as `~/.claude` — see `environment(for:)`.
    var configDir: String?

    var isDefault: Bool { configDir == nil }

    init(id: String = UUID().uuidString, name: String, configDir: String? = nil) {
        self.id = id
        self.name = name
        self.configDir = configDir
    }
}

/// Pure decisions about profiles. The store owns the list; this owns the rules.
enum ClaudeProfiles {
    static let defaultID = "default"
    static let defaultProfile = ClaudeProfile(id: defaultID, name: "Default", configDir: nil)

    /// Pane override beats the workspace's choice beats the default — the same
    /// precedence `defaultPath` has, so there is one mental model for both.
    /// An id naming a profile that no longer exists falls back to default rather than
    /// silently inheriting the workspace's account.
    static func resolve(paneOverride: String?, workspace: String?,
                        profiles: [ClaudeProfile]) -> ClaudeProfile {
        // Note the non-fallthrough: a pane that names a profile decides the answer even
        // when that profile is gone. Falling through to the workspace would run a pane
        // pinned to "Personal" as the workspace's work account — the one confusion this
        // feature exists to prevent.
        if let id = paneOverride, !id.isEmpty { return named(id, in: profiles) }
        if let id = workspace, !id.isEmpty { return named(id, in: profiles) }
        return defaultProfile
    }

    private static func named(_ id: String, in profiles: [ClaudeProfile]) -> ClaudeProfile {
        profiles.first { $0.id == id } ?? defaultProfile
    }

    /// The env a pane's PTY gets. **Empty for the default profile, and that is
    /// load-bearing**: Claude Code appends a hash of `CLAUDE_CONFIG_DIR` to its macOS
    /// Keychain service name *iff the variable is set*, so exporting the default path
    /// explicitly (`CLAUDE_CONFIG_DIR=$HOME/.claude`) names a Keychain item that has
    /// never been written and reads as "Not logged in". Never normalize this to a path.
    static func environment(for profile: ClaudeProfile) -> [String: String] {
        guard let dir = expanded(profile.configDir) else { return [:] }
        return ["CLAUDE_CONFIG_DIR": dir]
    }

    static func expanded(_ path: String?) -> String? {
        guard let path, !path.trimmed.isEmpty else { return nil }
        return (path.trimmed as NSString).expandingTildeInPath
    }

    /// Why this dir can't be used, or nil. Doesn't require it to exist — Claude Code
    /// creates it on first run, and refusing an absent dir would make the field
    /// unfillable before the account has ever been used.
    static func validate(configDir: String) -> String? {
        guard let dir = expanded(configDir) else { return "enter a path" }
        guard (dir as NSString).isAbsolutePath else { return "must be an absolute path" }
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: dir, isDirectory: &isDir), !isDir.boolValue {
            return "that path is a file"
        }
        if dir == (NSHomeDirectory() as NSString).appendingPathComponent(".claude") {
            // Same dir, different Keychain item — see environment(for:).
            return "that's Claude Code's default dir; use the Default profile instead"
        }
        return nil
    }

    // MARK: Paths that move with the config dir

    /// Where this profile's Claude sessions are transcribed (`shepherd view`).
    static func projectsDir(for profile: ClaudeProfile) -> String {
        base(for: profile).appendingPathComponent("projects") as String
    }

    /// Where the Shepherd plugin must be linked for *this* account's hooks to fire.
    static func skillsDir(for profile: ClaudeProfile) -> String {
        base(for: profile).appendingPathComponent("skills") as String
    }

    /// The account record Claude Code writes. Note the asymmetry: under a custom config
    /// dir it lives *inside* it, but the default one sits at `~/.claude.json` — home
    /// root, beside `~/.claude/`, not in it.
    static func accountFile(for profile: ClaudeProfile) -> String {
        if let dir = expanded(profile.configDir) {
            return (dir as NSString).appendingPathComponent(".claude.json")
        }
        return (NSHomeDirectory() as NSString).appendingPathComponent(".claude.json")
    }

    private static func base(for profile: ClaudeProfile) -> NSString {
        (expanded(profile.configDir)
            ?? (NSHomeDirectory() as NSString).appendingPathComponent(".claude")) as NSString
    }

    /// The macOS Keychain item Claude Code stores this profile's login in, for display
    /// only. Derived from the CLI's own construction: `Claude Code-credentials` plus,
    /// when `CLAUDE_CONFIG_DIR` is set, `-<first 8 hex of sha256(NFC(dir))>`.
    static func keychainService(for profile: ClaudeProfile) -> String {
        let stem = "Claude Code-credentials"
        guard let dir = expanded(profile.configDir) else { return stem }
        let hash = SHA256.hash(data: Data(dir.precomposedStringWithCanonicalMapping.utf8))
        return stem + "-" + hash.map { String(format: "%02x", $0) }.joined().prefix(8)
    }
}

// MARK: - Login identity (Foundation IO)

extension ClaudeProfiles {
    /// The account signed in on this profile, or nil. Read out of `.claude.json` rather
    /// than probed from the Keychain: reading another app's Keychain item can raise an
    /// authorization prompt, and a label is not worth one.
    static func signedInEmail(for profile: ClaudeProfile) -> String? {
        guard let data = FileManager.default.contents(atPath: accountFile(for: profile)),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let account = json["oauthAccount"] as? [String: Any],
              let email = account["emailAddress"] as? String, !email.isEmpty
        else { return nil }
        return email
    }
}
