import Foundation

/// Wire protocol version, pinned in the `hello` handshake. Bump on a breaking change;
/// keep messages additive otherwise. The Kotlin client sends the version it implements.
let kRemoteProtocolVersion = 1

// MARK: - DTOs

/// One pane's status as projected to a remote client. `state` is AgentState.rawValue.
struct PaneInfo: Codable, Equatable {
    let paneID: String
    let title: String
    let workspace: String
    let state: String
    let reason: String?
}

/// Control-channel messages. Codable (synthesized) → JSON, one per length-prefixed
/// frame. Wire shape per case, e.g. {"ping":{}} or {"state":{"paneID":"…","state":"…","reason":null}}.
/// The Kotlin client must match this shape; keep cases additive + versioned.
enum ControlMessage: Codable, Equatable {
    case hello(deviceID: String, deviceName: String, pairingCode: String?, secret: String?,
               fcmToken: String?, protocolVersion: Int)
    case refreshFCMToken(token: String)
    case accepted(sessionNonce: String)
    case rejected(reason: String)
    case pendingApproval
    case snapshot(panes: [PaneInfo])
    case state(paneID: String, state: String, reason: String?)
    case paneAdded(PaneInfo)
    case paneRemoved(paneID: String)
    case paneRenamed(paneID: String, title: String)
    case detach
    case ping
    case pong
}

/// Build the projected fleet from (workspaceName, paneID, title, state, reason) rows.
/// Pure so AgentStore's @MainActor/AppKit fleetSnapshot stays testable here.
func buildSnapshot(_ rows: [(workspace: String, paneID: String, title: String, state: String, reason: String?)]) -> [PaneInfo] {
    rows.map { PaneInfo(paneID: $0.paneID, title: $0.title, workspace: $0.workspace, state: $0.state, reason: $0.reason) }
}

// MARK: - Framing

enum FrameCodec {
    /// `[u32 big-endian length][json]`.
    static func encode(_ msg: ControlMessage) throws -> Data {
        let json = try JSONEncoder().encode(msg)
        var len = UInt32(json.count).bigEndian
        var out = Data(bytes: &len, count: 4)
        out.append(json)
        return out
    }
}

/// Accumulates stream bytes and yields complete messages as frames arrive.
final class FrameDecoder {
    private var buf = Data()
    private let maxFrame = 8 * 1024 * 1024   // guard against a bad length

    func feed(_ data: Data) throws -> [ControlMessage] {
        buf.append(data)
        var msgs: [ControlMessage] = []
        while buf.count >= 4 {
            let len = buf.prefix(4).withUnsafeBytes { Int(UInt32(bigEndian: $0.load(as: UInt32.self))) }
            if len < 0 || len > maxFrame { throw RemoteProtocolError.frameTooLarge }
            guard buf.count >= 4 + len else { break }
            let json = buf.subdata(in: (buf.startIndex + 4)..<(buf.startIndex + 4 + len))
            buf.removeSubrange(buf.startIndex..<(buf.startIndex + 4 + len))
            msgs.append(try JSONDecoder().decode(ControlMessage.self, from: json))
        }
        return msgs
    }
}

enum RemoteProtocolError: Error { case frameTooLarge }

// MARK: - Pairing (pure decision)

struct PairedDevice: Codable, Equatable {
    let deviceID: String
    let secret: String
    let name: String
    var fcmToken: String?
}

enum PairingDecision: Equatable {
    case accept(persistSecret: String?)   // nil = already known; non-nil = persist this new device
    case reject(reason: String)
    case needsApproval(deviceID: String, name: String, proposedSecret: String)
}

/// Decide how to handle a `hello`. Pure: callers pass the freshly generated
/// `newSecret` (so randomness stays out of the model).
func pairingDecision(deviceID: String, name: String, code: String?, secret: String?,
                     known: [PairedDevice], currentCode: String, newSecret: String) -> PairingDecision {
    if let dev = known.first(where: { $0.deviceID == deviceID }) {
        return secret == dev.secret ? .accept(persistSecret: nil) : .reject(reason: "bad secret")
    }
    if let code, code == currentCode {
        return .needsApproval(deviceID: deviceID, name: name, proposedSecret: secret ?? newSecret)
    }
    return .reject(reason: "pairing required")
}

// MARK: - Tailscale interface selection

/// Tailscale assigns addresses in the 100.64.0.0/10 CGNAT range (100.64–100.127.x.x).
func isTailscaleCGNAT(_ ip: String) -> Bool {
    let p = ip.split(separator: ".").compactMap { Int($0) }
    return p.count == 4 && p[0] == 100 && (64...127).contains(p[1])
}

func tailscaleIPv4(from addrs: [(name: String, ipv4: String)]) -> String? {
    addrs.first { isTailscaleCGNAT($0.ipv4) }?.ipv4
}
