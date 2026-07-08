import Foundation
#if canImport(Darwin)
import Darwin
#endif

/// Client role (M2): one TCP control connection to a remote Shepherd host. Dials the host,
/// runs the `hello` handshake, and streams inbound control frames to callbacks — the app
/// turns `workspaceTree`/`state` into mirror workspaces + `AgentStore.apply`, and drives the
/// host by `send`ing `cmd*`. Decoupled from AgentStore via closures so it's loopback-testable
/// against a real `RemoteServer`. Counterpart to `RemoteServer`; the data channels are separate
/// `shepherdd attach` connections (one per mirror pane), not owned here.
///
/// M2 is single-connection: a dropped link goes `.dead` (no reconnect). M3 adds backoff reconnect.
final class RemoteClient {
    let host: String
    let port: UInt16
    private let deviceID: String
    private let deviceName: String
    private let code: String?
    private let secret: String?

    private let onAccepted: (String) -> Void            // sessionNonce (also seeds `shepherdd attach`)
    private let onWorkspaceTree: (WorkspaceTree) -> Void
    private let onWorkspaceList: ([String]) -> Void
    private let onWorkspaceRemoved: (String) -> Void
    private let onState: (String, String, String?) -> Void   // paneID, state, reason
    private let onStatus: (RemoteConnState) -> Void

    private let lock = NSLock()
    private var fd: Int32 = -1
    private var nonce: String?
    private var stopped = false
    private let writeLock = NSLock()
    private let queue = DispatchQueue(label: "shepherd.remote.client", qos: .utility)

    init(host: String, port: UInt16, deviceID: String, deviceName: String,
         code: String?, secret: String?,
         onAccepted: @escaping (String) -> Void,
         onWorkspaceTree: @escaping (WorkspaceTree) -> Void,
         onWorkspaceList: @escaping ([String]) -> Void = { _ in },
         onWorkspaceRemoved: @escaping (String) -> Void = { _ in },
         onState: @escaping (String, String, String?) -> Void,
         onStatus: @escaping (RemoteConnState) -> Void) {
        self.host = host; self.port = port
        self.deviceID = deviceID; self.deviceName = deviceName
        self.code = code; self.secret = secret
        self.onAccepted = onAccepted
        self.onWorkspaceTree = onWorkspaceTree
        self.onWorkspaceList = onWorkspaceList
        self.onWorkspaceRemoved = onWorkspaceRemoved
        self.onState = onState
        self.onStatus = onStatus
    }

    /// The session nonce issued at `accepted` — passed to each `shepherdd attach` so its data
    /// channel is admitted against this live control session. Nil until connected.
    var sessionNonce: String? { lock.lock(); defer { lock.unlock() }; return nonce }

    func start() { queue.async { [weak self] in self?.run() } }

    func stop() {
        lock.lock(); stopped = true; let f = fd; fd = -1; nonce = nil; lock.unlock()
        if f >= 0 { shutdown(f, SHUT_RDWR); close(f) }
    }

    /// Frame and send a control message (a `cmd*` or `ping`) to the host. No-op if not connected.
    func send(_ msg: ControlMessage) {
        lock.lock(); let f = fd; lock.unlock()
        guard f >= 0, let data = try? FrameCodec.encode(msg) else { return }
        writeLock.lock(); defer { writeLock.unlock() }
        _ = data.withUnsafeBytes { raw -> Int in
            guard let base = raw.baseAddress else { return 0 }
            var off = 0
            while off < data.count {
                let w = write(f, base + off, data.count - off)
                if w < 0 { if errno == EINTR { continue }; return -1 }
                off += w
            }
            return off
        }
    }

    private func run() {
        onStatus(.reconnecting)   // connecting
        let f = RemoteClient.dial(host, port)
        guard f >= 0 else { onStatus(.dead); return }
        lock.lock()
        if stopped { lock.unlock(); shutdown(f, SHUT_RDWR); close(f); return }
        fd = f
        lock.unlock()

        let hello = ControlMessage.hello(deviceID: deviceID, deviceName: deviceName,
                                         pairingCode: code, secret: secret, fcmToken: nil,
                                         protocolVersion: kRemoteProtocolVersion)
        if let d = try? FrameCodec.encode(hello) {
            _ = d.withUnsafeBytes { write(f, $0.baseAddress, d.count) }
        }

        let dec = FrameDecoder()
        var buf = [UInt8](repeating: 0, count: 8192)
        while true {
            let n = read(f, &buf, buf.count)
            if n <= 0 { break }
            for m in (try? dec.feed(Data(buf[0..<n]))) ?? [] { handle(m) }
        }
        lock.lock(); fd = -1; nonce = nil; lock.unlock()
        shutdown(f, SHUT_RDWR); close(f)
        onStatus(.dead)   // M3: distinguish clean stop vs drop + reconnect
    }

    private func handle(_ m: ControlMessage) {
        switch m {
        case .accepted(let n):
            lock.lock(); nonce = n; lock.unlock()
            onStatus(.live); onAccepted(n)
        case .rejected:
            onStatus(.dead)
        case .pendingApproval:
            onStatus(.reconnecting)   // awaiting the host user's Allow tap
        case .workspaceTree(let t): onWorkspaceTree(t)
        case .workspaceList(let ids): onWorkspaceList(ids)
        case .workspaceRemoved(let id): onWorkspaceRemoved(id)
        case .state(let p, let s, let r): onState(p, s, r)
        case .pong: break
        default: break   // host-only frames (prompt/resize/etc.) not consumed in M2
        }
    }

    /// Connect to `host:port` (IP or MagicDNS name) over TCP; returns a connected fd or -1.
    static func dial(_ host: String, _ port: UInt16) -> Int32 {
        var hints = addrinfo(ai_flags: 0, ai_family: AF_UNSPEC, ai_socktype: SOCK_STREAM,
                             ai_protocol: 0, ai_addrlen: 0, ai_canonname: nil, ai_addr: nil, ai_next: nil)
        var res: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, String(port), &hints, &res) == 0, let head = res else { return -1 }
        defer { freeaddrinfo(res) }
        var ptr: UnsafeMutablePointer<addrinfo>? = head
        while let ai = ptr {
            let fd = socket(ai.pointee.ai_family, ai.pointee.ai_socktype, ai.pointee.ai_protocol)
            if fd >= 0 {
                if Darwin.connect(fd, ai.pointee.ai_addr, ai.pointee.ai_addrlen) == 0 {
                    var on: Int32 = 1
                    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &on, socklen_t(MemoryLayout<Int32>.size))
                    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
                    return fd
                }
                close(fd)
            }
            ptr = ai.pointee.ai_next
        }
        return -1
    }
}
