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
        setCloseOnExec(fd)
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

    /// Survives a transient `accept` failure. Breaking out on the first one left the
    /// listening fd open with nobody accepting, so the socket file looked healthy while the
    /// 16-slot backlog filled with abandoned connects and every later client got
    /// ECONNREFUSED — reported by the CLI as "cannot reach Shepherd (is it running?)" for
    /// the rest of the app's life. EMFILE is the realistic trigger.
    private nonisolated func acceptLoop(_ listenFD: Int32) {
        var transient = 0
        while true {
            let client = accept(listenFD, nil, nil)
            if client < 0 {
                switch errno {
                case EINTR, ECONNABORTED:
                    continue
                case EMFILE, ENFILE, ENOMEM, ENOBUFS:
                    // Out of descriptors: yield instead of spinning, and keep the listener.
                    transient += 1
                    logWarn(.control, "accept failed (errno \(errno)) — backing off, listener kept")
                    usleep(100_000)
                    if transient > 600 { logError(.control, "accept failing persistently"); transient = 0 }
                    continue
                default:
                    // The listening fd itself is gone (stop()/deinit closed it). Only then is
                    // ending the loop correct.
                    logInfo(.control, "accept loop ended (errno \(errno))")
                    return
                }
            }
            transient = 0
            setCloseOnExec(client)
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
