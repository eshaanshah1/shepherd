import Foundation
#if canImport(Darwin)
import Darwin
#endif

/// Minimal unix-domain socket server. Binds `path`, accepts connections on a
/// background thread, parses one {"tab_id","event","detail"} JSON message per
/// connection, and invokes `onEvent(tab, event, detail)` on the main queue.
/// The receiving half of seam 2/3.
final class SocketServer {
    private let path: String
    private let onEvent: (String, String, String) -> Void
    private var fd: Int32 = -1
    private let queue = DispatchQueue(label: "shepherd.socket", qos: .utility)

    init(path: String, onEvent: @escaping (String, String, String) -> Void) {
        self.path = path
        self.onEvent = onEvent
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
            DispatchQueue.main.async { [weak self] in self?.onEvent(tab, event, detail) }
        }
    }

    deinit {
        if fd >= 0 { close(fd) }
        unlink(path)
    }
}
