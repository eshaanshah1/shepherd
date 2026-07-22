import Foundation

/// Always-on local control socket. One request per connection: read the client's
/// JSON until it half-closes (SHUT_WR), route it on the main actor, write the
/// JSON response, close. Distinct from the fire-and-forget hook SocketServer —
/// this one replies.
@MainActor
final class ControlServer {
    private let path: String
    private let route: ([String: Any]) -> [String: Any]
    private var fd: Int32 = -1
    private let queue = DispatchQueue(label: "shepherd.control", qos: .userInitiated, attributes: .concurrent)

    init(path: String, route: @escaping ([String: Any]) -> [String: Any]) {
        self.path = path
        self.route = route
    }

    func start() {
        unlink(path)
        fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let maxLen = MemoryLayout.size(ofValue: addr.sun_path) - 1
        path.withCString { cstr in
            withUnsafeMutablePointer(to: &addr.sun_path.0) { _ = strncpy($0, cstr, maxLen) }
        }
        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, size) }
        }
        guard bound == 0 else { close(fd); fd = -1; return }
        chmod(path, 0o600)
        guard listen(fd, 16) == 0 else { close(fd); fd = -1; return }
        let listenFD = fd
        queue.async { [weak self] in self?.acceptLoop(listenFD) }
    }

    private nonisolated func acceptLoop(_ listenFD: Int32) {
        while true {
            let client = accept(listenFD, nil, nil)
            if client < 0 { if errno == EINTR { continue } else { break } }
            queue.async { [weak self] in self?.handle(client) }
        }
    }

    private nonisolated func handle(_ client: Int32) {
        defer { close(client) }
        var data = Data()
        var buf = [UInt8](repeating: 0, count: 16 * 1024)
        while true {
            let n = read(client, &buf, buf.count)
            if n > 0 { data.append(contentsOf: buf[0..<n]) }
            else { break }   // client half-closed write, or EOF
        }
        let req = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any]) ?? [:]
        var resp: [String: Any] = ["ok": false, "error": "internal error"]
        let sem = DispatchSemaphore(value: 0)
        DispatchQueue.main.async {
            MainActor.assumeIsolated { resp = self.route(req) }
            sem.signal()
        }
        sem.wait()
        if let out = try? JSONSerialization.data(withJSONObject: resp) {
            out.withUnsafeBytes { _ = write(client, $0.baseAddress, out.count) }
        }
    }

    func stop() { if fd >= 0 { close(fd); unlink(path); fd = -1 } }
    deinit { if fd >= 0 { close(fd); unlink(path) } }
}
