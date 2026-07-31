import Foundation

/// Keeps `RepoSignals` current for every pane whose cwd is a git work tree.
///
/// One vnode watch per **git dir**, refcounted across panes — several panes normally sit in
/// one repo, and one watch per pane would open the same directory a dozen times.
///
/// The **unit of work is the checkout, not the pane**, and there is at most one read of it in
/// flight, at most one queued, and at most one per `floor` seconds. Every part of that is
/// load-bearing: this fires on each write to a directory that an agent working in the repo
/// touches constantly, and the read is a `git status` over the whole work tree. Without the
/// ceiling the reads pile up concurrently and the app burns a third of a core sitting idle,
/// which is what it did.
@MainActor
final class RepoWatcher {

    private struct Watch {
        let source: DispatchSourceFileSystemObject
        var paneIDs: Set<String>
    }

    /// One read in flight per **checkout**, and whether more events landed while it ran.
    private struct Job {
        var running = false
        /// An event arrived mid-read ⇒ read once more afterwards, not once per event.
        var queued = false
        var lastFinished: Date = .distantPast
    }

    /// Keyed by git dir.
    private var watches: [String: Watch] = [:]
    /// paneID → (cwd, git dir), so `unwatch` finds its watch without another git call.
    private var panes: [String: (cwd: String, gitDir: String)] = [:]
    private var signalsByPane: [String: RepoSignals] = [:]
    /// Keyed by cwd — the unit of work is the checkout, not the pane.
    private var jobs: [String: Job] = [:]
    /// The one read queued per checkout, cancellable so an `immediate` request can pull it in.
    private var pending: [String: DispatchWorkItem] = [:]
    /// Panes whose git dir is still being resolved, so a second `watch` can't race a first.
    private var resolving: Set<String> = []
    /// cwds git has already said are not work trees, so the converging timer stops re-asking
    /// once per pane per tick, forever.
    private var notRepos: Set<String> = []

    /// A burst of git writes is one condition changing, so reads are floored and not merely
    /// debounced: `git rebase` writes its dir dozens of times, and a debounce that restarts on
    /// each write buys a full read per write once the burst is longer than the delay. A nudge
    /// reports a *condition*, so arriving a second or two later is invisible.
    private static let debounce: TimeInterval = 0.2
    private static let floor: TimeInterval = 5.0

    /// While the app is inactive nobody can see a nudge, so events are remembered rather than
    /// read — one read per changed checkout on return instead of one per write while away.
    private var paused = false
    private var staleWhileAway: Set<String> = []

    /// Carries the fresh signals rather than expecting the owner to read them back — an
    /// owner that has to call into the watcher from the watcher's own initializer is a
    /// circular reference.
    private let onChange: (String, RepoSignals?) -> Void

    init(onChange: @escaping (String, RepoSignals?) -> Void) {
        self.onChange = onChange
    }

    /// Begin tracking `paneID` at `cwd`. Idempotent for an unchanged cwd; a changed cwd
    /// (the pane was told to `cd`) rebinds it.
    /// `recheck` re-asks git about a cwd already known not to be a repo — for the paths the
    /// user drives (focus, an explicit refresh), where `git init` since the last look is worth
    /// a subprocess. The converging timer does not.
    func watch(paneID: String, cwd: String, recheck: Bool = false) {
        if let existing = panes[paneID], existing.cwd == cwd { return }
        if resolving.contains(paneID) { return }
        unwatch(paneID: paneID)
        guard !cwd.isEmpty else { return }
        if recheck { notRepos.remove(cwd) } else if notRepos.contains(cwd) { return }

        resolving.insert(paneID)
        Task.detached(priority: .utility) {
            let gitDir = Git.gitDir(cwd)
            await MainActor.run { [weak self] in
                guard let self else { return }
                self.resolving.remove(paneID)
                guard let gitDir else {            // not a repo — nothing to watch
                    self.notRepos.insert(cwd)
                    return
                }
                self.panes[paneID] = (cwd: cwd, gitDir: gitDir)
                self.attach(gitDir: gitDir, paneID: paneID)
                self.refresh(paneID: paneID, immediate: true)
            }
        }
    }

    func unwatch(paneID: String) {
        signalsByPane.removeValue(forKey: paneID)
        guard let entry = panes.removeValue(forKey: paneID) else { return }
        // Drop the checkout's job once no pane sits in it.
        if !panes.values.contains(where: { $0.cwd == entry.cwd }) {
            jobs.removeValue(forKey: entry.cwd)
            pending.removeValue(forKey: entry.cwd)?.cancel()
            staleWhileAway.remove(entry.cwd)
        }
        guard var watch = watches[entry.gitDir] else { return }
        watch.paneIDs.remove(paneID)
        if watch.paneIDs.isEmpty {
            watch.source.cancel()          // its cancel handler closes the descriptor
            watches.removeValue(forKey: entry.gitDir)
        } else {
            watches[entry.gitDir] = watch
        }
    }

    /// Re-read the checkout this pane sits in.
    ///
    /// Coalesced per checkout rather than per pane: ten panes in one repo are one read whose
    /// answer is identical for all of them, and one git write used to buy ten of them.
    /// `immediate` skips the floor for the human-driven paths (focus, an explicit refresh).
    func refresh(paneID: String, immediate: Bool = false) {
        guard let entry = panes[paneID] else { return }
        schedule(cwd: entry.cwd, gitDir: entry.gitDir, immediate: immediate)
    }

    /// Stop reading while the app is inactive, and catch up on what changed on return.
    func setPaused(_ paused: Bool) {
        self.paused = paused
        guard !paused else { return }
        let stale = staleWhileAway
        staleWhileAway.removeAll()
        for cwd in stale {
            guard let entry = panes.values.first(where: { $0.cwd == cwd }) else { continue }
            schedule(cwd: cwd, gitDir: entry.gitDir, immediate: true)
        }
    }

    // MARK: - private

    private func schedule(cwd: String, gitDir: String, immediate: Bool) {
        if paused && !immediate {
            staleWhileAway.insert(cwd)
            return
        }
        var job = jobs[cwd] ?? Job()
        if job.running {
            job.queued = true          // collapse the whole burst into one trailing read
            jobs[cwd] = job
            return
        }
        // A read already scheduled covers every event until it runs — it reads the state as
        // of then, not as of now. Re-arming the timer per write is what let a long burst
        // postpone the read indefinitely, so a queued read is only ever pulled *earlier*.
        if let waiting = pending[cwd] {
            guard immediate else { return }
            waiting.cancel()
        }

        let delay = immediate
            ? Self.debounce
            : max(Self.debounce, Self.floor - Date().timeIntervalSince(job.lastFinished))
        jobs[cwd] = job
        let item = DispatchWorkItem { [weak self] in
            self?.pending.removeValue(forKey: cwd)
            self?.run(cwd: cwd, gitDir: gitDir)
        }
        pending[cwd] = item
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
    }

    private func run(cwd: String, gitDir: String) {
        var job = jobs[cwd] ?? Job()
        guard panes.values.contains(where: { $0.cwd == cwd }) else {
            jobs.removeValue(forKey: cwd)   // every pane left this checkout while we waited
            return
        }
        job.queued = false
        job.running = true
        jobs[cwd] = job

        DispatchQueue.global(qos: .utility).async { [weak self] in
            let fresh = RepoSignalsReader.read(cwd: cwd, gitDir: gitDir)
            Task { @MainActor [weak self] in
                guard let self else { return }
                var job = self.jobs[cwd] ?? Job()
                job.running = false
                job.lastFinished = Date()
                let again = job.queued
                job.queued = false
                self.jobs[cwd] = job
                self.deliver(fresh, cwd: cwd)
                if again { self.schedule(cwd: cwd, gitDir: gitDir, immediate: false) }
            }
        }
    }

    /// One read, fanned out to every pane in that checkout.
    private func deliver(_ fresh: RepoSignals?, cwd: String) {
        for (paneID, entry) in panes where entry.cwd == cwd {
            guard signalsByPane[paneID] != fresh else { continue }
            signalsByPane[paneID] = fresh
            onChange(paneID, fresh)
        }
    }

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
            var scheduled = Set<String>()
            for pane in watch.paneIDs {
                guard let entry = self.panes[pane],
                      scheduled.insert(entry.cwd).inserted else { continue }
                self.schedule(cwd: entry.cwd, gitDir: entry.gitDir, immediate: false)
            }
        }
        source.setCancelHandler { close(fd) }
        watches[gitDir] = Watch(source: source, paneIDs: [paneID])
        source.resume()
    }
}
