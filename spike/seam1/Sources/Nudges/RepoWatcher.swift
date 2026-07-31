import Foundation

/// Keeps `RepoSignals` current for every pane whose cwd is a git work tree.
///
/// One vnode watch per **git dir**, refcounted across panes — several panes normally sit in
/// one repo, and one watch per pane would open the same directory a dozen times. Reads are
/// debounced because a single `git merge` writes the dir many times.
@MainActor
final class RepoWatcher {

    private struct Watch {
        let source: DispatchSourceFileSystemObject
        var paneIDs: Set<String>
    }

    /// Keyed by git dir.
    private var watches: [String: Watch] = [:]
    /// paneID → (cwd, git dir), so `unwatch` finds its watch without another git call.
    private var panes: [String: (cwd: String, gitDir: String)] = [:]
    private var signalsByPane: [String: RepoSignals] = [:]
    private var pending: [String: DispatchWorkItem] = [:]
    /// Panes whose git dir is still being resolved, so a second `watch` can't race a first.
    private var resolving: Set<String> = []

    /// Carries the fresh signals rather than expecting the owner to read them back — an
    /// owner that has to call into the watcher from the watcher's own initializer is a
    /// circular reference.
    private let onChange: (String, RepoSignals?) -> Void

    init(onChange: @escaping (String, RepoSignals?) -> Void) {
        self.onChange = onChange
    }

    /// Begin tracking `paneID` at `cwd`. Idempotent for an unchanged cwd; a changed cwd
    /// (the pane was told to `cd`) rebinds it.
    func watch(paneID: String, cwd: String) {
        if let existing = panes[paneID], existing.cwd == cwd { return }
        if resolving.contains(paneID) { return }
        unwatch(paneID: paneID)
        guard !cwd.isEmpty else { return }

        resolving.insert(paneID)
        Task.detached(priority: .utility) {
            let gitDir = Git.gitDir(cwd)
            await MainActor.run { [weak self] in
                guard let self else { return }
                self.resolving.remove(paneID)
                guard let gitDir else { return }   // not a repo — nothing to watch
                self.panes[paneID] = (cwd: cwd, gitDir: gitDir)
                self.attach(gitDir: gitDir, paneID: paneID)
                self.refresh(paneID: paneID)
            }
        }
    }

    func unwatch(paneID: String) {
        pending.removeValue(forKey: paneID)?.cancel()
        signalsByPane.removeValue(forKey: paneID)
        guard let entry = panes.removeValue(forKey: paneID),
              var watch = watches[entry.gitDir] else { return }
        watch.paneIDs.remove(paneID)
        if watch.paneIDs.isEmpty {
            watch.source.cancel()          // its cancel handler closes the descriptor
            watches.removeValue(forKey: entry.gitDir)
        } else {
            watches[entry.gitDir] = watch
        }
    }

    /// Re-read one pane, debounced.
    func refresh(paneID: String) {
        guard let entry = panes[paneID] else { return }
        pending.removeValue(forKey: paneID)?.cancel()
        let item = DispatchWorkItem { [weak self] in
            let fresh = RepoSignalsReader.read(cwd: entry.cwd)
            Task { @MainActor [weak self] in
                guard let self, self.panes[paneID]?.cwd == entry.cwd else { return }
                guard self.signalsByPane[paneID] != fresh else { return }
                self.signalsByPane[paneID] = fresh
                self.onChange(paneID, fresh)
            }
        }
        pending[paneID] = item
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 0.2, execute: item)
    }

    // MARK: - private

    private func attach(gitDir: String, paneID: String) {
        if var existing = watches[gitDir] {
            existing.paneIDs.insert(paneID)
            watches[gitDir] = existing
            return
        }
        let fd = open(gitDir, O_EVTONLY)
        guard fd >= 0 else { return }
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .rename, .delete],
            queue: .main)
        source.setEventHandler { [weak self] in
            guard let self, let watch = self.watches[gitDir] else { return }
            for pane in watch.paneIDs { self.refresh(paneID: pane) }
        }
        source.setCancelHandler { close(fd) }
        watches[gitDir] = Watch(source: source, paneIDs: [paneID])
        source.resume()
    }
}
