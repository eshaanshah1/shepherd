import Foundation

/// The files `⌘P` can open.
///
/// Git first, because `git ls-files` is one process and already honours `.gitignore` — but
/// **not git only**. The Files scope is a plain editor; a directory that happens not to be a
/// repo is still full of files worth editing, and gating the editor on git made it a diff
/// view wearing an editor's hat.
enum FileLister {

    /// Directory names never worth walking into. A hand-written list rather than a
    /// `.gitignore` parser: outside a repo there is no `.gitignore` to read, and these are
    /// the directories that make a naive walk take minutes.
    static let skippedDirectories: Set<String> = [
        ".git", ".svn", ".hg", "node_modules", ".build", "build", "DerivedData",
        "Pods", "Carthage", "vendor", ".venv", "venv", "__pycache__", ".mypy_cache",
        ".pytest_cache", "dist", "target", ".next", ".nuxt", ".gradle", ".idea",
        ".tox", ".terraform", "bower_components",
    ]

    /// Stops a runaway walk from hanging the finder on a home directory or a mounted volume.
    static let maxFiles = 20_000

    /// Every file under `cwd`.
    ///
    /// The **union** of git's list and a directory walk, not one or the other. Git alone
    /// hides every ignored file, and an editor that cannot open `.env` or a generated file
    /// because git was told not to track it is not a general editor. The walk alone can hit
    /// `maxFiles` on a large repo and silently drop tracked files, which are the ones you
    /// most want; taking git's list first guarantees those survive the cap.
    ///
    /// `skippedDirectories` is what keeps the walk's half honest — the ignored files worth
    /// opening are config and generated source, not the contents of `node_modules`.
    static func list(cwd: String) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for path in GitStaging.listFiles(cwd: cwd) where seen.insert(path).inserted {
            out.append(path)
        }
        for path in walk(cwd: cwd) where seen.insert(path).inserted {
            out.append(path)
        }
        return out
    }

    /// Directory walk for anywhere git can't help, returning `cwd`-relative paths.
    ///
    /// Skips hidden entries and the directories above, and stops at `maxFiles` — a finder
    /// that never finishes reading is worse than one that admits it truncated.
    static func walk(cwd: String, fileManager: FileManager = .default) -> [String] {
        let root = URL(fileURLWithPath: cwd, isDirectory: true)
        guard let enumerator = fileManager.enumerator(
            at: root,
            includingPropertiesForKeys: [.isDirectoryKey, .isRegularFileKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else { return [] }

        var out: [String] = []
        for case let url as URL in enumerator {
            let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey])
            if values?.isDirectory == true {
                if skippedDirectories.contains(url.lastPathComponent) {
                    enumerator.skipDescendants()
                }
                continue
            }
            guard values?.isRegularFile == true else { continue }
            out.append(relative(url.path, to: cwd))
            if out.count >= maxFiles { break }
        }
        return out.sorted()
    }

    /// A path expressed against `cwd`, or left absolute when it lives outside it — an
    /// opened file need not be anywhere near the pane's directory.
    ///
    /// **Both** sides are symlink-normalized before comparing. `FileManager` hands back
    /// resolved paths while the pane's `cwd` is whatever the shell had, and on macOS `/tmp`
    /// and `/var` are symlinks into `/private` — so a raw prefix test fails for an entire
    /// directory's worth of files and every one comes back absolute. Note the direction:
    /// `resolvingSymlinksInPath` normalizes `/private/var` *down* to `/var`, not the other
    /// way, so resolving only one side does not help.
    static func relative(_ path: String, to cwd: String) -> String {
        let base = URL(fileURLWithPath: cwd).resolvingSymlinksInPath().path
        let target = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
        let prefix = base.hasSuffix("/") ? base : base + "/"
        if target.hasPrefix(prefix) { return String(target.dropFirst(prefix.count)) }
        // Raw comparison as a fallback, for a path that doesn't exist on disk yet and so
        // has nothing to resolve.
        let rawPrefix = cwd.hasSuffix("/") ? cwd : cwd + "/"
        if path.hasPrefix(rawPrefix) { return String(path.dropFirst(rawPrefix.count)) }
        return path
    }
}
