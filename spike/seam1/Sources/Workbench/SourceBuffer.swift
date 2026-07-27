import Foundation
import Combine

/// One file in the workbench: its current text, its base blob for diffing, and a
/// watcher that drives live-follow. The follow/lock decision is `LockPolicy`'s; this
/// is the filesystem shell around it.
@MainActor
final class SourceBuffer: ObservableObject {
    let source: SourceID
    private let cwd: String
    private let baseLabel: String?

    @Published private(set) var text: String = ""
    @Published private(set) var follow: FollowState = .following

    /// Fired after an external write is absorbed, so the session can re-diff.
    var onExternalWrite: (() -> Void)?

    /// Monotonic access stamp for the session's LRU eviction.
    var lastUsed: UInt64 = 0

    private var watcher: DispatchSourceFileSystemObject?
    private var loadedBaseText: String??

    init(source: SourceID, cwd: String, baseLabel: String?) {
        self.source = source
        self.cwd = cwd
        self.baseLabel = baseLabel
        self.text = (try? String(contentsOfFile: source.path, encoding: .utf8)) ?? ""
    }

    /// The blob this buffer diffs against (HEAD, or the base branch), read on demand.
    ///
    /// Lazy on purpose: this is a `git show` process, and eagerly filling it in `init`
    /// meant one spawn per changed file on the main thread — a 287-file diff paid 287
    /// of them before the first row drew. Cached once read; it changes only when the
    /// diff scope changes, which rebuilds the whole session.
    var baseText: String? {
        if let loadedBaseText { return loadedBaseText }
        let blob = DiffReader.fileBlob(cwd: cwd,
                                      path: Self.relativePath(source.path, cwd: cwd),
                                      side: .old, baseLabel: baseLabel)
        loadedBaseText = blob
        return blob
    }

    /// Route an event through `LockPolicy`, reloading only when it says to.
    func apply(_ event: DiskEvent) {
        if LockPolicy.shouldReloadFromDisk(follow, on: event),
           let fresh = try? String(contentsOfFile: source.path, encoding: .utf8) {
            text = fresh
        }
        follow = LockPolicy.next(follow, on: event)
    }

    /// The user edited the buffer. Locks the file via `LockPolicy`.
    func replaceText(_ new: String) {
        text = new
        follow = LockPolicy.next(follow, on: .userEdit)
    }

    func save() throws {
        try text.write(toFile: source.path, atomically: true, encoding: .utf8)
        follow = LockPolicy.next(follow, on: .userSaved)
    }

    /// Whether this buffer holds edits not yet on disk.
    var isDirty: Bool { follow != .following }

    /// Whether an agent wrote the file while we held unsaved edits.
    var needsReconciliation: Bool { follow == .lockedStale }

    // MARK: - Watching

    /// Watch for writes.
    ///
    /// Editors and git replace files rather than writing in place, so `.delete` /
    /// `.rename` must re-arm the watch on the new inode — a single-shot watch stops
    /// hearing about the file after the first agent edit.
    func startWatching() {
        stopWatching()
        let fd = open(source.path, O_EVTONLY)
        guard fd >= 0 else { return }
        let w = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd, eventMask: [.write, .delete, .rename], queue: .main)
        w.setEventHandler { [weak self] in
            guard let self else { return }
            let replaced = w.data.contains(.delete) || w.data.contains(.rename)
            self.apply(.externalWrite)
            self.onExternalWrite?()
            if replaced { self.startWatching() }   // re-arm on the replacement inode
        }
        w.setCancelHandler { close(fd) }
        w.resume()
        watcher = w
    }

    func stopWatching() {
        watcher?.cancel()   // the cancel handler closes the fd
        watcher = nil
    }

    /// `DiffReader.fileBlob` wants a repo-relative path; we hold absolute ones.
    private static func relativePath(_ absolute: String, cwd: String) -> String {
        guard absolute.hasPrefix(cwd) else { return absolute }
        return String(absolute.dropFirst(cwd.count))
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }
}
