import Foundation

/// Notices a client reconnecting far more often than any healthy client would, and says so.
///
/// PURE — `now` is passed in, so this is unit-tested like the other policies.
///
/// This exists because of how a real storm was found: a phone re-dialled the host roughly once a
/// second for minutes, and the only reason anyone noticed was the user reporting that pairing was
/// "broken again". The host had every connection in its log and no opinion about the rate. A
/// component that accepts connections should recognise abuse of itself.
///
/// Detection only — it deliberately does not throttle or refuse. A misbehaving client is usually
/// OUR client (both halves ship together), so the useful response is a log line naming it, not a
/// defence that hides the bug and creates a second failure mode to debug.
struct StormDetector {
    /// More than this many connections from one peer inside `window` is a storm.
    let threshold: Int
    /// The sliding window.
    let window: TimeInterval
    /// Report at most once per peer per this interval, so the warning does not become the storm.
    let reportEvery: TimeInterval

    /// Defaults chosen against the two rates that matter. A client obeying exponential backoff
    /// manages at most ~4 attempts in 10s (1+2+4s), and a lossy link reconnecting every 2s reaches
    /// 5 — both must pass. The real storm ran at ~1/s, which is 10 or 11 in the window, so the line
    /// sits at 6. Note a steady 1/s cannot EXCEED a threshold of 10 in a 10s window: it lands
    /// exactly on it, which is how the first version of this let the measured failure through.
    init(threshold: Int = 6, window: TimeInterval = 10, reportEvery: TimeInterval = 30) {
        self.threshold = threshold
        self.window = window
        self.reportEvery = reportEvery
    }

    private(set) var recent: [String: [Date]] = [:]
    private var lastReported: [String: Date] = [:]

    /// Record a connection from `peer`. Returns the rate to report, or nil when there is nothing
    /// worth saying — either the peer is behaving, or we already said so recently.
    mutating func record(peer: String, at now: Date) -> (count: Int, window: TimeInterval)? {
        var times = (recent[peer] ?? []).filter { now.timeIntervalSince($0) < window }
        times.append(now)
        recent[peer] = times
        guard times.count > threshold else { return nil }
        if let last = lastReported[peer], now.timeIntervalSince(last) < reportEvery { return nil }
        lastReported[peer] = now
        return (times.count, window)
    }

    /// Forget peers that have gone quiet, so the map cannot grow without bound on a busy network.
    mutating func prune(before cutoff: Date) {
        recent = recent.filter { _, times in (times.last ?? .distantPast) >= cutoff }
        lastReported = lastReported.filter { $0.value >= cutoff }
    }
}
