import Foundation
#if canImport(Darwin)
import Darwin
#endif

/// Minimal unix-domain socket server. Binds `path`, accepts connections on a
/// background thread, parses one {"tab_id","event","detail","sid"} JSON message per
/// connection, and invokes `onEvent(tab, event, detail, sid)` on the main queue
/// (`sid` = the reporting agent's session_id, used to pin a pane to its owner).
/// The receiving half of seam 2/3.
final class SocketServer {
    private let path: String
    private let onEvent: (String, String, String, String, String?) -> Void
    private var fd: Int32 = -1
    private let queue = DispatchQueue(label: "shepherd.socket", qos: .utility)

    init(path: String, onEvent: @escaping (String, String, String, String, String?) -> Void) {
        self.path = path
        self.onEvent = onEvent
    }

    /// Unlinks any `prefix*.sock` left behind by a Shepherd process that's no longer
    /// running (crash, `killall`, force-quit — anything that skipped this class's own
    /// teardown). Call before binding a new socket so dead launches don't pile up in /tmp.
    static func cleanupStale(directory: String = "/tmp", prefix: String = "shepherd-", suffix: String = ".sock") {
        guard let entries = try? FileManager.default.contentsOfDirectory(atPath: directory) else { return }
        for name in entries {
            guard name.hasPrefix(prefix), name.hasSuffix(suffix) else { continue }
            let pidString = name.dropFirst(prefix.count).dropLast(suffix.count)
            guard let pid = pid_t(pidString), pid > 0 else { continue }
            if kill(pid, 0) != 0 && errno == ESRCH {
                unlink(directory + "/" + name)
            }
        }
    }

    func start() {
        unlink(path)
        fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let maxLen = MemoryLayout.size(ofValue: addr.sun_path) - 1
        path.withCString { cstr in
            withUnsafeMutablePointer(to: &addr.sun_path.0) { dst in
                _ = strncpy(dst, cstr, maxLen)
            }
        }
        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, size) }
        }
        guard bound == 0, listen(fd, 16) == 0 else { close(fd); fd = -1; return }
        queue.async { [weak self] in self?.acceptLoop() }
    }

    private func acceptLoop() {
        while true {
            let client = accept(fd, nil, nil)
            if client < 0 { if errno == EINTR { continue } else { break } }
            var buf = [UInt8](repeating: 0, count: 8192)
            let n = read(client, &buf, buf.count)
            close(client)
            guard n > 0 else { continue }
            let raw = String(decoding: buf[0..<n], as: UTF8.self)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard
                let data = raw.data(using: .utf8),
                let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                let tab = obj["tab_id"] as? String,
                let event = obj["event"] as? String
            else { continue }
            let detail = (obj["detail"] as? String) ?? ""
            let sid = (obj["sid"] as? String) ?? ""
            let payload = obj["payload"] as? String
            DispatchQueue.main.async { [weak self] in self?.onEvent(tab, event, detail, sid, payload) }
        }
    }

    /// Deterministic unlink for the graceful-quit path — don't rely on `deinit`,
    /// which never runs (the accept thread stays parked in `accept()`; closing its fd
    /// from here doesn't reliably wake it on Darwin). Harmless: the process is exiting.
    func stop() {
        let f = fd
        fd = -1
        if f >= 0 { close(f) }
        unlink(path)
    }

    deinit {
        stop()
    }
}
