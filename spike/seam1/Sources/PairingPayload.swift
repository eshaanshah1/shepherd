import Foundation

/// The QR bootstrap payload shared with the Android client. Byte-pinned to the
/// Kotlin `PairingPayload.parse`. No secret rides here — admission is Tailscale
/// identity gated host-side.
enum PairingPayload {
    static let scheme = "shepherd"

    /// - Parameters:
    ///   - lan: `ip:port` of the LAN (TLS) listener, when serving on the local network.
    ///   - pin: base64 SHA-256 of the LAN certificate. Delivered over the QR — a visual channel
    ///     an attacker on the network is not on — which is a STRONGER binding than the typed-code
    ///     flow's compare-the-digits step, because there is nothing for the user to skip.
    ///   - code: the live pairing code, so scanning needs no typing at all.
    static func encode(host: String?, ip: String?, port: UInt16, name: String,
                       lan: String? = nil, pin: String? = nil, code: String? = nil) -> String {
        var c = URLComponents()
        c.scheme = scheme
        c.host = "pair"
        var q: [URLQueryItem] = []
        if let host, !host.isEmpty { q.append(URLQueryItem(name: "host", value: host)) }
        if let ip, !ip.isEmpty { q.append(URLQueryItem(name: "ip", value: ip)) }
        q.append(URLQueryItem(name: "port", value: String(port)))
        q.append(URLQueryItem(name: "name", value: name))
        if let lan, !lan.isEmpty { q.append(URLQueryItem(name: "lan", value: lan)) }
        if let pin, !pin.isEmpty { q.append(URLQueryItem(name: "pin", value: pin)) }
        if let code, !code.isEmpty { q.append(URLQueryItem(name: "code", value: code)) }
        c.queryItems = q
        return c.string ?? "\(scheme)://pair?port=\(port)&name=\(name)"
    }
}
