import Foundation

/// Wire protocol version, pinned in the `hello` handshake. Bump on a breaking change;
/// keep messages additive otherwise. The Kotlin client sends the version it implements.
let kRemoteProtocolVersion = 2

/// Link health of a mirror pane / client connection to its host (M2). Local panes never
/// carry one. Lives here (not SplitTree) so the client role can use it without pulling in
/// the split-tree model.
enum RemoteConnState: String { case live, reconnecting, dead }

// MARK: - DTOs

/// One pane's status as projected to a remote client. `state` is AgentState.rawValue.
struct PaneInfo: Codable, Equatable {
    let paneID: String
    let title: String
    let workspace: String
    let state: String
    let reason: String?
}

/// One question in an AskUserQuestion prompt, projected to a remote client so it can render
/// tappable answers. Byte-pinned to the Kotlin PromptQuestion.
struct PromptQuestion: Codable, Equatable {
    let prompt: String; let header: String; let options: [String]; let multiSelect: Bool
}

// MARK: - Structural tree DTOs (protocol v2)

/// One leaf pane projected to a client, carrying the LIVE fields the mirror needs
/// (paneID / title / cwd / state / reason). Distinct from the persistence `Pane`
/// codec, which deliberately drops paneID/title/state (ids regenerate on restore).
struct RemotePane: Codable, Equatable {
    let paneID: String; let title: String; let cwd: String?
    let state: String; let reason: String?
}

/// A tab's split tree, projected to a client. Mirrors `SplitNode`'s shape (same
/// coding keys) but with live-field `RemotePane` leaves so a Kotlin/Swift client
/// can walk it with one decoder.
indirect enum RemoteNode: Codable, Equatable {
    case leaf(RemotePane)
    case split(axis: String, ratio: Double, first: RemoteNode, second: RemoteNode)

    enum CodingKeys: String, CodingKey { case kind, pane, axis, ratio, first, second }
    private enum Kind: String, Codable { case leaf, split }

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        switch try c.decode(Kind.self, forKey: .kind) {
        case .leaf: self = .leaf(try c.decode(RemotePane.self, forKey: .pane))
        case .split: self = .split(axis: try c.decode(String.self, forKey: .axis),
                                   ratio: try c.decode(Double.self, forKey: .ratio),
                                   first: try c.decode(RemoteNode.self, forKey: .first),
                                   second: try c.decode(RemoteNode.self, forKey: .second))
        }
    }
    func encode(to e: Encoder) throws {
        var c = e.container(keyedBy: CodingKeys.self)
        switch self {
        case .leaf(let p): try c.encode(Kind.leaf, forKey: .kind); try c.encode(p, forKey: .pane)
        case .split(let a, let r, let f, let s):
            try c.encode(Kind.split, forKey: .kind); try c.encode(a, forKey: .axis)
            try c.encode(r, forKey: .ratio); try c.encode(f, forKey: .first); try c.encode(s, forKey: .second)
        }
    }
}

/// One tab projected to a client: its split tree + focus/zoom hints.
struct RemoteTab: Codable, Equatable {
    let tabID: String; let root: RemoteNode
    let focusedPaneID: String?; let zoomedPaneID: String?
}

/// Reserved workspace id for the synthetic "Temp Tabs" folder that mirrors
/// ephemeral panes. Real workspace ids are UUIDs, so this never collides.
let ephemeralWorkspaceID = "ephemeral"

/// One workspace projected to a client: its tabs (each a tree) + selection.
struct WorkspaceTree: Codable, Equatable {
    let workspaceID: String; let name: String
    let tabs: [RemoteTab]; let selectedTabID: String?
    var defaultPath: String? = nil   // host's per-workspace default dir (new tabs open here)
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
    case state(paneID: String, state: String, reason: String?)
    case paneAdded(PaneInfo)
    case paneRemoved(paneID: String)
    case paneRenamed(paneID: String, title: String)
    case resize(paneID: String, cols: Int, rows: Int)
    case prompt(paneID: String, kind: String, detail: String?, questions: [PromptQuestion]?)
    case detach
    case ping
    case pong
    // v2 structural snapshot (host→client): one tree per workspace + the ordered id list.
    case workspaceTree(WorkspaceTree)
    case workspaceList(ids: [String])
    case workspaceRemoved(workspaceID: String)
    // v2 structural commands (client→host): the host applies each to its real store.
    case cmdNewTab(workspaceID: String)
    case cmdSplit(paneID: String, axis: String)
    case cmdClosePane(paneID: String)
    case cmdFocusPane(paneID: String)
    case cmdZoom(paneID: String)
    case cmdRenamePane(paneID: String, title: String)
    case cmdReorderTab(workspaceID: String, fromIndex: Int, toIndex: Int)
    case cmdSwitchTab(workspaceID: String, tabID: String)
    case cmdSetWorkspaceDirectory(workspaceID: String, path: String?)
    case cmdNewWorktreeTab(workspaceID: String, name: String)
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
            if len > maxFrame { throw RemoteProtocolError.frameTooLarge }
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

/// A connecting peer's Tailscale-verified identity, resolved host-side from the
/// connection's source IP (never from the self-reported `hello` name).
struct VerifiedPeer: Equatable { let userID: String; let name: String }

/// Decide how to handle a `hello`. Pure. The pairing code is gone: a NEW device is
/// admitted for approval only if its source IP resolves to a Tailscale peer owned by
/// the same user as this host (`peer.userID == selfUserID`); the approval name is the
/// VERIFIED name. `newSecret` is passed in so randomness stays out of the model.
func pairingDecision(deviceID: String, secret: String?,
                     known: [PairedDevice], newSecret: String,
                     peer: VerifiedPeer?, selfUserID: String?) -> PairingDecision {
    if let dev = known.first(where: { $0.deviceID == deviceID }) {
        return secret == dev.secret ? .accept(persistSecret: nil) : .reject(reason: "bad secret")
    }
    if let peer, let selfUserID, peer.userID == selfUserID {
        return .needsApproval(deviceID: deviceID, name: peer.name, proposedSecret: secret ?? newSecret)
    }
    return .reject(reason: "unverified peer")
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

// MARK: - Data-channel protocol (Phase 2)

/// Data-channel handshake messages. After the hello exchange the connection carries
/// RAW PTY bytes (no more DataMessage frames). Same wire codec as ControlMessage but a
/// distinct enum so control and data protocols evolve independently. Keep additive.
enum DataMessage: Codable, Equatable {
    case dataHello(sessionNonce: String, paneID: String, cols: Int, rows: Int)   // phone → app
    case dataReady(cols: Int, rows: Int)                   // app → phone
    case dataRejected(reason: String)                      // app → phone, then close
    case ptyHello(paneID: String, cols: Int, rows: Int)    // helper → app
}

enum DataFrameCodec {
    static func encode(_ m: DataMessage) throws -> Data {
        let json = try JSONEncoder().encode(m)
        var len = UInt32(json.count).bigEndian
        var out = Data(bytes: &len, count: 4)
        out.append(json)
        return out
    }
}

final class DataFrameDecoder {
    private var buf = Data()
    private let maxFrame = 8 * 1024 * 1024

    func feed(_ data: Data) throws -> [DataMessage] {
        buf.append(data)
        var msgs: [DataMessage] = []
        while buf.count >= 4 {
            let len = buf.prefix(4).withUnsafeBytes { Int(UInt32(bigEndian: $0.load(as: UInt32.self))) }
            if len > maxFrame { throw RemoteProtocolError.frameTooLarge }
            guard buf.count >= 4 + len else { break }
            let json = buf.subdata(in: (buf.startIndex + 4)..<(buf.startIndex + 4 + len))
            buf.removeSubrange(buf.startIndex..<(buf.startIndex + 4 + len))
            msgs.append(try JSONDecoder().decode(DataMessage.self, from: json))
        }
        return msgs
    }
}

// MARK: - App→helper frame (Phase 2 resize)
// [u32 BE len][1-byte type][payload]. type 0x00 = input (raw bytes); 0x01 = resize [u16 BE cols][u16 BE rows];
// 0x02 = releaseSize (no payload) — the pane's last remote viewer left, so the helper resumes sizing
// from its own outer (desktop) PTY. helper→app output stays raw; only this low-volume direction is framed.
enum HelperFrame: Equatable { case input([UInt8]); case resize(cols: Int, rows: Int); case releaseSize }

enum HelperFrameCodec {
    static func encode(_ f: HelperFrame) -> Data {
        var body: [UInt8]
        switch f {
        case .input(let b): body = [0x00] + b
        case .resize(let c, let r):
            body = [0x01, UInt8((c >> 8) & 0xff), UInt8(c & 0xff), UInt8((r >> 8) & 0xff), UInt8(r & 0xff)]
        case .releaseSize: body = [0x02]
        }
        var len = UInt32(body.count).bigEndian
        var out = Data(bytes: &len, count: 4); out.append(contentsOf: body); return out
    }
}

final class HelperFrameDecoder {
    private var buf = [UInt8]()
    func feed(_ d: Data) -> [HelperFrame] {
        buf.append(contentsOf: d)
        var out = [HelperFrame]()
        while buf.count >= 4 {
            let len = (Int(buf[0]) << 24) | (Int(buf[1]) << 16) | (Int(buf[2]) << 8) | Int(buf[3])
            if len <= 0 || buf.count < 4 + len { break }
            let body = Array(buf[4..<4+len]); buf.removeFirst(4 + len)
            switch body[0] {
            case 0x00: out.append(.input(Array(body[1...])))
            case 0x01 where body.count == 5:
                out.append(.resize(cols: (Int(body[1]) << 8) | Int(body[2]),
                                   rows: (Int(body[3]) << 8) | Int(body[4])))
            case 0x02 where body.count == 1: out.append(.releaseSize)
            default: break
            }
        }
        return out
    }
}
