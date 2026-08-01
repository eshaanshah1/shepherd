import Foundation
import Network
#if canImport(Darwin)
import Darwin
#endif

/// One Shepherd host seen advertising itself on the local link. It is a *claim*, not an
/// identity: anything on the network can publish this service, so a browse result only ever
/// means "somewhere to try pairing", never "your Mac".
///
/// `host` is the **resolved** address, never the instance name. Those are different strings and
/// confusing them fails silently: "Eshaan’s MacBook Air" is reachable at `Eshaan.local`, so a
/// dial of `<instance>.local` resolves to nothing and the pairing never even starts.
struct LANHost: Equatable, Identifiable {
    let id: String        // instance name — unique per host on this link
    let name: String      // display name, self-reported
    let host: String      // resolved IPv4 literal, dialable
    let port: UInt16
}

/// Bonjour discovery of `_shepherd._tcp`, resolved to addresses. Runs only while the pairing
/// sheet is open — a browser left running is a wakeup source, and there is nothing to do with
/// results nobody is looking at.
///
/// Uses `NetService` rather than `NWBrowser` because only the former hands back **addresses**.
/// `NWBrowser` yields endpoints that Network.framework resolves internally, which is no use to
/// the socket-based paths downstream: the pin store keys on `host:port` and `shepherdd attach`
/// dials with BSD sockets. This mirrors Android's `NsdManager.resolveService`.
final class LANBrowser: NSObject {
    var onChange: (([LANHost]) -> Void)?

    private var browser: NetServiceBrowser?
    private var resolving: [String: NetService] = [:]
    private var found: [String: LANHost] = [:]

    func start() {
        guard browser == nil else { return }
        let b = NetServiceBrowser()
        b.delegate = self
        b.searchForServices(ofType: "_shepherd._tcp.", inDomain: "local.")
        browser = b
    }

    func stop() {
        browser?.stop(); browser = nil
        for (_, svc) in resolving { svc.stop() }
        resolving.removeAll()
        found.removeAll()
        onChange?([])
    }

    private func publish() {
        onChange?(found.values.sorted { $0.name < $1.name })
    }

    /// This machine's own addresses. A host advertising itself is not a peer, and offering to
    /// pair with yourself is a dead end that only reads as a bug.
    private var ownAddresses: Set<String> {
        Set(RemoteServer.localIPv4Addresses().map(\.ipv4))
    }

    /// First IPv4 literal among a resolved service's addresses.
    private func ipv4(of service: NetService) -> String? {
        for data in service.addresses ?? [] {
            let ip: String? = data.withUnsafeBytes { raw in
                guard let base = raw.baseAddress,
                      raw.count >= MemoryLayout<sockaddr_in>.size else { return nil }
                let sa = base.assumingMemoryBound(to: sockaddr.self)
                guard sa.pointee.sa_family == UInt8(AF_INET) else { return nil }
                var sin = base.assumingMemoryBound(to: sockaddr_in.self).pointee
                var buf = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
                inet_ntop(AF_INET, &sin.sin_addr, &buf, socklen_t(INET_ADDRSTRLEN))
                return String(cString: buf)
            }
            if let ip { return ip }
        }
        return nil
    }
}

extension LANBrowser: NetServiceBrowserDelegate, NetServiceDelegate {
    func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService,
                           moreComing: Bool) {
        // A found service carries only a display name; its address takes a second round trip.
        service.delegate = self
        resolving[service.name] = service
        service.resolve(withTimeout: 5)
    }

    func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService,
                           moreComing: Bool) {
        resolving[service.name]?.stop()
        resolving[service.name] = nil
        found[service.name] = nil
        if !moreComing { publish() }
    }

    func netServiceDidResolveAddress(_ service: NetService) {
        defer { resolving[service.name] = nil }
        guard let ip = ipv4(of: service), !ownAddresses.contains(ip),
              service.port > 0, service.port <= Int(UInt16.max) else { return }
        found[service.name] = LANHost(id: service.name, name: service.name,
                                      host: ip, port: UInt16(service.port))
        publish()
    }

    func netService(_ service: NetService, didNotResolve errorDict: [String: NSNumber]) {
        resolving[service.name] = nil
    }
}
