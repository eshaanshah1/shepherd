import Foundation

/// A file's text as of a commit, cached per `(sha, path)`.
///
/// **Lazy and off-main, with a redraw callback.** Not an optimization — the recorded lesson:
/// `SourceBuffer.init` eagerly ran `git show` per file and paid 287 main-thread process
/// spawns before the first row drew. It is also the correct shape for the still-open
/// "`git show` from `draw`" defect in the deletion-band path, which can adopt this once it
/// is proven here.
@MainActor
final class BlobCache {
    private struct Key: Hashable {
        let sha: String
        let path: String
    }

    private let cwd: String
    private var blobs: [Key: String] = [:]
    private var inFlight: Set<Key> = []

    /// Fired on the main thread after a blob lands, so the caller can invalidate the
    /// highlighter for that source and redraw. Never called synchronously from `request`.
    var onLoaded: ((String, String) -> Void)?

    init(cwd: String) { self.cwd = cwd }

    /// The text if it is already here. Callers must tolerate nil and ask again after
    /// `onLoaded` — an empty string is "not yet", never "colour from the working copy".
    func cached(sha: String, path: String) -> String? {
        blobs[Key(sha: sha, path: path)]
    }

    /// Start a fetch unless one is already cached or running. Deduplicated: a fragment can
    /// ask for the same blob on every draw pass.
    func request(sha: String, path: String) {
        let key = Key(sha: sha, path: path)
        guard blobs[key] == nil, !inFlight.contains(key) else { return }
        inFlight.insert(key)
        let cwd = self.cwd
        let args = CommitHistory.blobArguments(sha: sha, path: path)
        DispatchQueue.global(qos: .userInitiated).async {
            // A path that did not exist at this commit is an ordinary outcome (a file added
            // later), not an error worth surfacing: it caches as empty so it is asked once.
            let text: String
            if case .ok(let out) = GitStaging.run(args, cwd: cwd) { text = out } else { text = "" }
            DispatchQueue.main.async {
                self.inFlight.remove(key)
                self.blobs[key] = text
                self.onLoaded?(sha, path)
            }
        }
    }

    /// Dropped when the commit selection changes. Blobs are immutable, so nothing else
    /// invalidates them.
    func clear() {
        blobs.removeAll()
        inFlight.removeAll()
    }
}
