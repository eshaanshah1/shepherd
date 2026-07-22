import Foundation

/// The QR bootstrap payload shared with the Android client. Byte-pinned to the
/// Kotlin `PairingPayload.parse`. No secret rides here — admission is Tailscale
/// identity gated host-side.
enum PairingPayload {
    static let scheme = "shepherd"

    static func encode(host: String?, ip: String?, port: UInt16, name: String) -> String {
        var c = URLComponents()
        c.scheme = scheme
        c.host = "pair"
        var q: [URLQueryItem] = []
        if let host, !host.isEmpty { q.append(URLQueryItem(name: "host", value: host)) }
        if let ip, !ip.isEmpty { q.append(URLQueryItem(name: "ip", value: ip)) }
        q.append(URLQueryItem(name: "port", value: String(port)))
        q.append(URLQueryItem(name: "name", value: name))
        c.queryItems = q
        return c.string ?? "\(scheme)://pair?port=\(port)&name=\(name)"
    }
}
