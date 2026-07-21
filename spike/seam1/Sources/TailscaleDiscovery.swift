import Foundation
#if canImport(Darwin)
import Darwin
#endif

/// Discovery of the user's own Tailscale devices via the bundled `tailscale` CLI, plus
/// host-side source-IP → identity verification. Pure parse/filter/derive statics (unit-
/// tested) are split from the `Process`/socket shell (compiled, exercised manually / E2E).
enum TailscaleDiscovery {

    // MARK: Pure

    static func parse(_ data: Data) -> TSStatus? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let selfObj = root["Self"] as? [String: Any]
        let selfUserID = (selfObj?["UserID"]).map { "\($0)" }

        var userNames: [String: String] = [:]
        for (uid, v) in (root["User"] as? [String: Any] ?? [:]) {
            if let u = v as? [String: Any] {
                userNames[uid] = (u["DisplayName"] as? String) ?? (u["LoginName"] as? String) ?? uid
            }
        }

        func firstV4(_ ips: Any?) -> String? {
            (ips as? [String])?.first { isTailscaleCGNAT($0) }
        }
        func peer(_ o: [String: Any]) -> TSPeer {
            TSPeer(hostName: o["HostName"] as? String ?? "?",
                   dnsName: (o["DNSName"] as? String ?? "").trimmingCharacters(in: CharacterSet(charactersIn: ".")),
                   os: o["OS"] as? String ?? "",
                   online: o["Online"] as? Bool ?? false,
                   userID: (o["UserID"]).map { "\($0)" } ?? "",
                   ipv4: firstV4(o["TailscaleIPs"]))
        }
        let peers = (root["Peer"] as? [String: Any] ?? [:]).values
            .compactMap { $0 as? [String: Any] }
            .map(peer)
            .sorted { $0.hostName < $1.hostName }
        return TSStatus(selfUserID: selfUserID, peers: peers, userNames: userNames)
    }

    /// Peers owned by the same user as this host (the programmatic "mine").
    static func myPeers(_ s: TSStatus) -> [TSPeer] {
        guard let uid = s.selfUserID else { return [] }
        return s.peers.filter { $0.userID == uid }
    }

    static func row(for p: TSPeer, portOpen: Bool) -> RemoteDeviceRow {
        let pair: RemoteDeviceRow.Pairability = !p.online ? .offline : (portOpen ? .pairable : .notServing)
        return RemoteDeviceRow(id: p.dnsName.isEmpty ? p.hostName : p.dnsName,
                               name: p.hostName, os: p.os, ipv4: p.ipv4, pairability: pair)
    }

    /// Host-side: resolve a connection's source IP to a verified peer identity by matching
    /// it against the tailnet peer list. Name is the peer's HostName (never the hello name).
    static func verifiedPeer(forIP ip: String, in s: TSStatus) -> VerifiedPeer? {
        guard let p = s.peers.first(where: { $0.ipv4 == ip }) else { return nil }
        return VerifiedPeer(userID: p.userID, name: p.hostName)
    }

    /// First existing binary path (injectable `exists` for tests). Never assumes the shim.
    static func resolveBinary(exists: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }) -> String? {
        ["/Applications/Tailscale.app/Contents/MacOS/Tailscale",
         "/usr/local/bin/tailscale",
         "/opt/homebrew/bin/tailscale",
         "/usr/bin/tailscale"].first(where: exists)
    }

    // MARK: Shell

    /// Run `tailscale status --json` and parse it, or nil if the binary is missing / fails.
    static func fetchStatus() -> TSStatus? {
        guard let bin = resolveBinary() else { return nil }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: bin)
        p.arguments = ["status", "--json"]
        let pipe = Pipe(); p.standardOutput = pipe; p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else { return nil }
        return parse(data)
    }

    /// Blocking TCP connect probe with a short timeout. True ⇒ Shepherd is serving there.
    static func probe(host: String, port: UInt16, timeoutMs: Int = 700) -> Bool {
        var hints = addrinfo(ai_flags: 0, ai_family: AF_INET, ai_socktype: SOCK_STREAM,
                             ai_protocol: 0, ai_addrlen: 0, ai_canonname: nil, ai_addr: nil, ai_next: nil)
        var res: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, String(port), &hints, &res) == 0, let head = res else { return false }
        defer { freeaddrinfo(head) }
        let fd = socket(head.pointee.ai_family, head.pointee.ai_socktype, head.pointee.ai_protocol)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        let flags = fcntl(fd, F_GETFL, 0)
        _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
        let rc = connect(fd, head.pointee.ai_addr, head.pointee.ai_addrlen)
        if rc == 0 { return true }
        if errno != EINPROGRESS { return false }
        var pfd = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
        guard poll(&pfd, 1, Int32(timeoutMs)) == 1 else { return false }
        var err: Int32 = 0; var len = socklen_t(MemoryLayout<Int32>.size)
        getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len)
        return err == 0
    }
}

struct TSPeer: Equatable {
    let hostName: String; let dnsName: String; let os: String
    let online: Bool; let userID: String; let ipv4: String?
}
struct TSStatus: Equatable {
    let selfUserID: String?; let peers: [TSPeer]; let userNames: [String: String]
}
struct RemoteDeviceRow: Equatable, Identifiable {
    enum Pairability: Equatable { case pairable, notServing, offline }
    let id: String; let name: String; let os: String; let ipv4: String?
    let pairability: Pairability
}
