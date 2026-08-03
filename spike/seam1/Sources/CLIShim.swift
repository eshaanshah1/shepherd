import Foundation

/// Keeps `~/.local/bin/shepherd` pointing at the running bundle's `shepherdd`.
///
/// Two failure modes made this necessary, both silent. A shim left pointing at a build
/// directory that was later deleted is a **dangling** symlink, and a dangling symlink is
/// not executable, so `which shepherd` skips it and falls through to the rest of PATH —
/// where, if `Shepherd.app/Contents/MacOS` is on it, a **case-insensitive** filesystem
/// matches the GUI binary `Shepherd` and typing `shepherd` launches a second copy of the
/// app instead of running the CLI. And an in-place update moves the bundle's `shepherdd`,
/// so a shim into the old location dies exactly when the user is least likely to suspect
/// it.
///
/// Follows the plugin installer's rule (ADR 0005): **create or repair, never replace
/// something valid.** A link that resolves to a different real file is somebody's choice —
/// a dev build, a checkout — and stealing it would be worse than doing nothing.
enum CLIShim {
    /// What sits at the shim path right now.
    enum State: Equatable {
        /// Already ours.
        case current
        /// A symlink whose target does not exist — the case that reads as "no CLI installed".
        case dangling(target: String)
        /// A symlink to some other file that does exist. Left alone.
        case foreign(target: String)
        /// A real file or directory. Left alone.
        case occupied
        /// Nothing there.
        case missing

        /// Only these two are ours to write.
        var shouldInstall: Bool {
            switch self {
            case .missing, .dangling: return true
            case .current, .foreign, .occupied: return false
            }
        }
    }

    /// PURE given its inputs — `linkTarget` is the symlink's destination (nil if not a
    /// symlink), `exists` reports whether a path is present on disk.
    static func state(linkTarget: String?, pathExists: Bool, targetIsPresent: (String) -> Bool,
                      want: String) -> State {
        guard let linkTarget else { return pathExists ? .occupied : .missing }
        if linkTarget == want { return .current }
        return targetIsPresent(linkTarget) ? .foreign(target: linkTarget) : .dangling(target: linkTarget)
    }

    static var defaultPath: String {
        (NSHomeDirectory() as NSString).appendingPathComponent(".local/bin/shepherd")
    }

    /// The `shepherdd` inside the running bundle. nil when it is absent, which is normal for
    /// a bare `swift` test run and must not produce a link to nowhere.
    static var bundledCLI: String? {
        let exe = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/shepherdd").path
        return FileManager.default.fileExists(atPath: exe) ? exe : nil
    }

    static func inspect(path: String = defaultPath, want: String) -> State {
        let fm = FileManager.default
        let target = try? fm.destinationOfSymbolicLink(atPath: path)
        // `fileExists` FOLLOWS symlinks, so a dangling link reports false — ask for the
        // link's own attributes instead or the two cases collapse into one.
        let itemPresent = (try? fm.attributesOfItem(atPath: path)) != nil
        return state(linkTarget: target, pathExists: itemPresent,
                     targetIsPresent: { fm.fileExists(atPath: $0) }, want: want)
    }

    /// Install or repair the shim. Called at every launch, so it also covers updates.
    @discardableResult
    static func reconcile(path: String = defaultPath) -> State {
        // A throwaway dev instance must not own the global `shepherd` command. (The
        // create-never-replace rule already protects a healthy shim, but a missing one would
        // otherwise be claimed by whichever build launched first.)
        guard !AppMode.isDev else { return .foreign(target: "dev build does not install the shim") }
        guard let want = bundledCLI else {
            logDebug(.app, "no bundled shepherdd — leaving the CLI shim alone")
            return .missing
        }
        let state = inspect(path: path, want: want)
        guard state.shouldInstall else {
            if case .foreign(let t) = state { logInfo(.app, "CLI shim points elsewhere, left alone: \(t)") }
            if case .occupied = state { logWarn(.app, "\(path) is a real file — not replacing it") }
            return state
        }
        let fm = FileManager.default
        let dir = (path as NSString).deletingLastPathComponent
        do {
            try fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
            if case .dangling(let old) = state {
                try fm.removeItem(atPath: path)
                logInfo(.app, "CLI shim was dangling (-> \(old)) — repointing at this build")
            }
            try fm.createSymbolicLink(atPath: path, withDestinationPath: want)
            logInfo(.app, "CLI shim installed: \(path) -> \(want)")
            return .current
        } catch {
            logError(.app, "could not install the CLI shim at \(path): \(error.localizedDescription)")
            return state
        }
    }
}
