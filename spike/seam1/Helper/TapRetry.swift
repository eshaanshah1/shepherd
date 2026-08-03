import Foundation

/// When the helper should re-dial the app's pty hub. PURE, so the pacing is testable without
/// running the binary.
///
/// The tap has to be retried at all because the hub binds asynchronously after the app launches,
/// so every pane restored at startup dials before it exists. But retrying *forever at a fixed
/// interval* is its own bug: `SHEPHERD_PTY_SOCK` is injected into every pane whether or not the
/// app is serving, so with serving off — the default — a flat 2s retry means every pane on the
/// machine dials into nothing, twice a minute each, for as long as it lives, and the pump has to
/// wake up to do it. This repo has already paid for that mistake once, in the nudge watcher.
enum TapRetry {
    static let start: TimeInterval = 2
    static let cap: TimeInterval = 30

    /// Doubling with a ceiling. A hub that is coming up arrives within the first few attempts; a
    /// hub that does not exist costs one wakeup per `cap` thereafter.
    static func next(after interval: TimeInterval) -> TimeInterval {
        min(cap, max(start, interval * 2))
    }

    /// How long the pump may block. Nil means "block indefinitely" — the right answer whenever the
    /// tap is healthy, so a working tap costs no timer wakeups at all.
    static func pollTimeoutMs(retrying: Bool, interval: TimeInterval) -> Int32 {
        guard retrying else { return -1 }
        return Int32(max(start, min(cap, interval)) * 1000)
    }

    /// Whether a dial is worth attempting: the interval has elapsed AND something is listening at
    /// that path. The existence check is the cheap half of the pair — `socket()` + `connect()` per
    /// pane against a path that isn't there is pure waste, and when serving is off it is the
    /// permanent state rather than a transient one.
    static func shouldDial(now: Date, lastAttempt: Date, interval: TimeInterval,
                           socketExists: Bool) -> Bool {
        guard socketExists else { return false }
        return now.timeIntervalSince(lastAttempt) >= interval
    }
}
