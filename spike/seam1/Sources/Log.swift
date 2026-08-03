import Foundation
import os

/// Shepherd's log. One file, one line per event, timestamped and categorised.
///
/// This exists because its absence cost a whole debugging session: LAN pairing failed
/// silently, and the only record was untimestamped bare strings, so there was no way to
/// tell whether "no tailnet address" happened before or during the phone's connection
/// attempt. Every branch that ends in "and then nothing happens" must say so here — a
/// silent early return is the thing this file is for.
///
/// The **file is the authoritative channel** — `tail -f /tmp/shepherd-events.log`. Lines are
/// also mirrored to `os_log`, but mind what that does and does not retain: Apple keeps
/// `info` in memory only and persists `error`/`fault`, so
/// `log show --predicate 'subsystem == "com.shepherd"'` will surface errors and little else.
/// For everything, stream it live:
/// `log stream --level info --predicate 'subsystem == "com.shepherd"'`.
enum LogLevel: Int, Comparable, CustomStringConvertible {
    case debug = 0, info = 1, warn = 2, error = 3

    static func < (a: LogLevel, b: LogLevel) -> Bool { a.rawValue < b.rawValue }

    var description: String {
        switch self {
        case .debug: return "DEBUG"
        case .info:  return "INFO"
        case .warn:  return "WARN"
        case .error: return "ERROR"
        }
    }

    /// Parsed from `# shepherd: log-level = …`. Unknown text is `.info` rather than an
    /// error: a typo in a config file must not decide whether the app logs.
    static func parse(_ raw: String?) -> LogLevel {
        switch raw?.trimmingCharacters(in: .whitespaces).lowercased() {
        case "debug": return .debug
        case "warn", "warning": return .warn
        case "error": return .error
        default: return .info
        }
    }
}

/// The first thing you grep for. Keep these short and stable — they end up in muscle memory.
enum LogCategory: String {
    case agent      // hook lifecycle, pane state transitions
    case remote     // tailnet control server
    case lan        // TLS listener, socketpair bridge
    case pairing    // approval, codes, SAS
    case notify     // where an attention alert went: banner / chime / phone push
    case control    // the `shepherd` CLI socket
    case pty        // pty broker / data channels
    case worktree
    case update
    case app        // launch, config, everything else
}

final class ShepherdLog {
    static let shared = ShepherdLog()

    /// Lines above this are dropped. Read once at launch from the shepherd config, and
    /// re-read on ⌘⇧R via `reloadLevel()`.
    private(set) var level: LogLevel = .info

    private let path: String
    private let queue = DispatchQueue(label: "shepherd.log", qos: .utility)
    private var handle: FileHandle?
    private let osLog = os.Logger(subsystem: "com.shepherd", category: "shepherd")

    /// Rotate at 8 MB, keeping one generation. Small enough to open in an editor, big
    /// enough to hold a long session at `.debug`.
    static let sizeCap = 8 * 1024 * 1024

    /// Deliberately does not reach for `AppMode` or the config parser: this file is compiled
    /// into every test target that touches the server, and a dependency here would drag the
    /// whole app in behind it. The dev/daily split is the same bundle-id suffix `AppMode`
    /// uses, inlined.
    init(path: String? = nil) {
        let isDev = Bundle.main.bundleIdentifier?.hasSuffix(".dev") ?? false
        self.path = path ?? (isDev ? "/tmp/shepherd-dev-events.log" : "/tmp/shepherd-events.log")
    }

    // MARK: pure bits (unit-tested)

    /// `08-03 11:06:01.295 INFO  lan   LAN serving on 0.0.0.0:8723`.
    ///
    /// The timestamp carries milliseconds and a date because these lines get correlated
    /// against `tcpdump` and against a phone's clock; without them the file is a list of
    /// facts in no order. Level and category are padded so the message column lines up.
    static func format(_ level: LogLevel, _ category: LogCategory, _ message: String,
                       at date: Date, calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.month, .day, .hour, .minute, .second, .nanosecond],
                                        from: date)
        // ROUND, don't truncate: `Date` is a Double of seconds, so a whole 295ms round-trips
        // as 294_999_9xx ns and integer division would report 294. Clamped because rounding
        // 999.6ms would otherwise print as "1000".
        let ms = min(999, (((c.nanosecond ?? 0) + 500_000) / 1_000_000))
        let stamp = String(format: "%02d-%02d %02d:%02d:%02d.%03d",
                           c.month ?? 0, c.day ?? 0, c.hour ?? 0, c.minute ?? 0, c.second ?? 0, ms)
        let lvl = level.description.padding(toLength: 5, withPad: " ", startingAt: 0)
        let cat = category.rawValue.padding(toLength: 8, withPad: " ", startingAt: 0)
        return "\(stamp) \(lvl) \(cat) \(message)"
    }

    static func shouldRotate(size: Int, cap: Int = ShepherdLog.sizeCap) -> Bool { size >= cap }

    // MARK: writing

    /// The raw value is passed in rather than read here, so this file needs neither the
    /// config parser nor its types — it is compiled into test targets that have no business
    /// knowing about `~/.config/shepherd/config`.
    func reloadLevel(raw: String?) {
        let new = LogLevel.parse(raw)
        guard new != level else { return }
        level = new
        write(.info, .app, "log level is now \(new)")
    }

    func write(_ level: LogLevel, _ category: LogCategory, _ message: String) {
        guard level >= self.level else { return }
        let line = ShepherdLog.format(level, category, message, at: Date())
        // os_log redacts interpolated values by default; the whole line is ours and
        // contains no user secrets, so mark it public or `log show` prints <private>.
        switch level {
        case .debug: osLog.debug("\(line, privacy: .public)")
        case .info:  osLog.info("\(line, privacy: .public)")
        case .warn:  osLog.warning("\(line, privacy: .public)")
        case .error: osLog.error("\(line, privacy: .public)")
        }
        queue.async { [weak self] in self?.append(line) }
    }

    /// Serialised on `queue`. Holds one handle open rather than reopening per line, and
    /// reopens after a rotation or if someone deletes the file under us.
    private func append(_ line: String) {
        guard let data = (line + "\n").data(using: .utf8) else { return }
        if handle == nil { open() }
        guard let h = handle else { return }
        h.write(data)
        if let size = try? h.offset(), ShepherdLog.shouldRotate(size: Int(size)) { rotate() }
    }

    private func open() {
        let fm = FileManager.default
        if !fm.fileExists(atPath: path) { fm.createFile(atPath: path, contents: nil) }
        handle = FileHandle(forWritingAtPath: path)
        _ = try? handle?.seekToEnd()
    }

    private func rotate() {
        try? handle?.close()
        handle = nil
        let old = path + ".1"
        try? FileManager.default.removeItem(atPath: old)
        try? FileManager.default.moveItem(atPath: path, toPath: old)
        open()
    }
}

// MARK: - call sites

// Free functions, because a log call should be shorter than the thing it describes.
// @autoclosure so an interpolated message costs nothing when its level is off.
func logDebug(_ c: LogCategory, _ m: @autoclosure () -> String) {
    guard LogLevel.debug >= ShepherdLog.shared.level else { return }
    ShepherdLog.shared.write(.debug, c, m())
}
func logInfo(_ c: LogCategory, _ m: @autoclosure () -> String) {
    guard LogLevel.info >= ShepherdLog.shared.level else { return }
    ShepherdLog.shared.write(.info, c, m())
}
func logWarn(_ c: LogCategory, _ m: @autoclosure () -> String) {
    ShepherdLog.shared.write(.warn, c, m())
}
func logError(_ c: LogCategory, _ m: @autoclosure () -> String) {
    ShepherdLog.shared.write(.error, c, m())
}
