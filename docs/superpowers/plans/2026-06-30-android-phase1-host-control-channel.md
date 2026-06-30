# Android Phase 1 — Host Control-Channel Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a client-agnostic control-channel server to the macOS Shepherd app that, over a Tailscale-only TCP socket, pairs a remote device (token + in-app approve) and projects the live agent fleet (a `Snapshot` + per-pane `State`/`Pane*` updates) to it.

**Architecture:** A pure-model wire protocol (`RemoteProtocol.swift`, unit-tested) + an AppKit-shell BSD-socket server (`RemoteServer.swift`) that binds the Tailscale interface, runs the pairing handshake, and broadcasts agent-state transitions tapped from `AgentStore.apply`. The server is **decoupled** from `AgentStore` (a `snapshotProvider` closure + a `broadcast` method + an injected approval callback) so it can be loopback-tested without the GUI. **No FCM push, no per-pane data/PTY channels** — those are separate plans.

**Tech Stack:** Swift 5, BSD sockets (matching `SocketServer.swift`), `Codable`/JSON over a length-prefixed frame, XCTest (pure + a sockets integration target).

## Global Constraints

- Deployment target **macOS 13.0**; `SWIFT_VERSION` **5.0** (per `project.yml`). Build from `spike/seam1`.
- **Don't launch/kill the user's running Shepherd.** Verify by compile + unit tests + loopback integration tests only; defer any GUI/device runtime check to a user-run checklist. (Memory: the user runs Shepherd live.)
- **`xcodegen generate` after any file/target add** before building. "SourceKit lies in this repo" — trust `xcodebuild`.
- Test command (works on this machine): `xcodebuild test -project Shepherd.xcodeproj -scheme <SCHEME> -destination 'platform=macOS' -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache`. (`xcodebuild build` with a bare `platform=macOS` destination is broken here; the app builds with `-scheme Shepherd build` and NO destination.)
- Pure-model files go in `Sources/` and are added to a test target's explicit `sources:` list; helper/integration test files live OUTSIDE the `Tests/` glob (own dir + own target), to keep `ShepherdModelTests` pure.
- **Bind to the Tailscale interface only**; never `0.0.0.0`. Server takes an injectable bind address so tests use `127.0.0.1`.
- Wire framing: `[u32 big-endian length][JSON bytes]`, one `ControlMessage` per frame. The Kotlin client (separate plan) must match this exactly — keep messages additive and versioned.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Work on branch `android-remote-client` (already checked out); never commit to `master`.
- Commit hygiene: `git add` only this task's files; never `-A`/`.`.

---

## File Structure

- **Create `spike/seam1/Sources/RemoteProtocol.swift`** — pure model: `PaneInfo`, `ControlMessage`, `FrameCodec`/`FrameDecoder`, `PairedDevice`, `PairingDecision` + `pairingDecision(...)`, and the Tailscale-CGNAT address helpers. No AppKit. Added to the app target (Sources glob) and to `ShepherdModelTests`.
- **Create `spike/seam1/Tests/RemoteProtocolTests.swift`** — pure unit tests (globbed by `ShepherdModelTests`).
- **Create `spike/seam1/Sources/RemoteServer.swift`** — AppKit-shell BSD-socket server: listener bound to a given address, accept loop, per-connection frame read loop, pairing wiring (injected approver), client registry, `broadcast`. Decoupled from `AgentStore` via init closures.
- **Create `spike/seam1/RemoteTests/RemoteServerTests.swift`** + **`spike/seam1/RemoteTests/` test target** — loopback (`127.0.0.1`) integration tests (a raw TCP client doing the handshake). Separate target so `ShepherdModelTests` stays pure.
- **Modify `spike/seam1/Sources/AgentStore.swift`** — own a `RemoteServer?` started by the existing serve toggle; provide the `snapshotProvider`; `broadcast(.state(...))` in `apply`; post `Pane*` on structural mutations; expose a `@Published` pending-approval for the UI.
- **Create `spike/seam1/Sources/PairingApprovalView.swift`** + **modify a Settings/host surface** — a minimal SwiftUI approve sheet + the pairing code display. (Build-verified; runtime check deferred to user.)
- **Modify `spike/seam1/project.yml`** — add `RemoteProtocol.swift` to `ShepherdModelTests`; add the `ShepherdRemoteTests` target.

---

### Task 1: `RemoteProtocol.swift` — wire protocol (pure)

**Files:**
- Create: `spike/seam1/Sources/RemoteProtocol.swift`
- Create: `spike/seam1/Tests/RemoteProtocolTests.swift`
- Modify: `spike/seam1/project.yml` (add `- path: Sources/RemoteProtocol.swift` to `ShepherdModelTests.sources`)

**Interfaces produced:**
- `struct PaneInfo: Codable, Equatable { let paneID, title, workspace, state: String; let reason: String? }`
- `enum ControlMessage: Codable, Equatable` with cases: `hello(deviceID:deviceName:pairingCode:secret:)`, `accepted(sessionNonce:)`, `rejected(reason:)`, `pendingApproval`, `snapshot(panes:)`, `state(paneID:state:reason:)`, `paneAdded(PaneInfo)`, `paneRemoved(paneID:)`, `paneRenamed(paneID:title:)`, `detach`, `ping`, `pong`.
- `enum FrameCodec { static func encode(_:) throws -> Data }`; `final class FrameDecoder { func feed(_ data: Data) throws -> [ControlMessage] }`.
- `struct PairedDevice: Codable, Equatable { let deviceID, secret, name: String }`
- `enum PairingDecision: Equatable { case accept(persistSecret: String?); case reject(reason: String); case needsApproval(deviceID: String, name: String, proposedSecret: String) }`
- `func pairingDecision(deviceID:name:code:secret:known:currentCode:newSecret:) -> PairingDecision`
- `func isTailscaleCGNAT(_ ip: String) -> Bool`; `func tailscaleIPv4(from addrs: [(name: String, ipv4: String)]) -> String?`

- [ ] **Step 1: Write the failing tests**

Create `spike/seam1/Tests/RemoteProtocolTests.swift`:

```swift
import XCTest

final class RemoteProtocolTests: XCTestCase {

    func testFrameRoundTripSingleMessage() throws {
        let msg = ControlMessage.state(paneID: "p1", state: "blocked", reason: "approve Bash")
        let data = try FrameCodec.encode(msg)
        let dec = FrameDecoder()
        XCTAssertEqual(try dec.feed(data), [msg])
    }

    func testFrameDecoderReassemblesAcrossChunks() throws {
        let a = try FrameCodec.encode(.ping)
        let b = try FrameCodec.encode(.snapshot(panes: [
            PaneInfo(paneID: "p1", title: "claude", workspace: "Home", state: "working", reason: nil)
        ]))
        let stream = a + b
        let dec = FrameDecoder()
        // Feed byte-by-byte: nothing emitted until each frame completes.
        var out: [ControlMessage] = []
        for byte in stream { out += try dec.feed(Data([byte])) }
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(out.first, .ping)
    }

    func testHelloCodecRoundTrip() throws {
        let hello = ControlMessage.hello(deviceID: "d1", deviceName: "Pixel", pairingCode: "8421", secret: nil)
        XCTAssertEqual(try FrameDecoder().feed(try FrameCodec.encode(hello)), [hello])
    }

    func testPairingKnownDeviceGoodSecretAccepts() {
        let known = [PairedDevice(deviceID: "d1", secret: "s", name: "Pixel")]
        let d = pairingDecision(deviceID: "d1", name: "Pixel", code: nil, secret: "s",
                                known: known, currentCode: "8421", newSecret: "NEW")
        XCTAssertEqual(d, .accept(persistSecret: nil))
    }

    func testPairingKnownDeviceBadSecretRejects() {
        let known = [PairedDevice(deviceID: "d1", secret: "s", name: "Pixel")]
        let d = pairingDecision(deviceID: "d1", name: "Pixel", code: nil, secret: "WRONG",
                                known: known, currentCode: "8421", newSecret: "NEW")
        XCTAssertEqual(d, .reject(reason: "bad secret"))
    }

    func testPairingNewDeviceWithGoodCodeNeedsApproval() {
        let d = pairingDecision(deviceID: "d2", name: "Pixel", code: "8421", secret: nil,
                                known: [], currentCode: "8421", newSecret: "NEW")
        XCTAssertEqual(d, .needsApproval(deviceID: "d2", name: "Pixel", proposedSecret: "NEW"))
    }

    func testPairingNewDeviceWrongCodeRejects() {
        let d = pairingDecision(deviceID: "d2", name: "Pixel", code: "0000", secret: nil,
                                known: [], currentCode: "8421", newSecret: "NEW")
        XCTAssertEqual(d, .reject(reason: "pairing required"))
    }

    func testTailscaleCGNATDetection() {
        XCTAssertTrue(isTailscaleCGNAT("100.101.102.103"))
        XCTAssertTrue(isTailscaleCGNAT("100.64.0.1"))
        XCTAssertFalse(isTailscaleCGNAT("192.168.1.5"))
        XCTAssertFalse(isTailscaleCGNAT("100.200.0.1"))   // .200 > 127, outside /10
        XCTAssertEqual(tailscaleIPv4(from: [("en0","192.168.1.5"), ("utun3","100.101.102.103")]),
                       "100.101.102.103")
    }
}
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd spike/seam1 && xcodegen generate
xcodebuild test -project Shepherd.xcodeproj -scheme ShepherdModelTests -destination 'platform=macOS' -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache -only-testing:ShepherdModelTests/RemoteProtocolTests 2>&1 | tail -15
```
Expected: FAIL to compile (`cannot find 'ControlMessage'/'FrameCodec'/… in scope`). (Do Step 3 + the project.yml add in Step 4 together, then this turns green.)

- [ ] **Step 3: Write `RemoteProtocol.swift`**

Create `spike/seam1/Sources/RemoteProtocol.swift`:

```swift
import Foundation

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
    case hello(deviceID: String, deviceName: String, pairingCode: String?, secret: String?)
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
        return .needsApproval(deviceID: deviceID, name: name, proposedSecret: newSecret)
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
```

- [ ] **Step 4: Add to the test target, regenerate, run green**

In `project.yml` append to `ShepherdModelTests.sources`: `- path: Sources/RemoteProtocol.swift`. Then:
```bash
cd spike/seam1 && xcodegen generate
xcodebuild test -project Shepherd.xcodeproj -scheme ShepherdModelTests -destination 'platform=macOS' -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache -only-testing:ShepherdModelTests/RemoteProtocolTests 2>&1 | tail -15
```
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**
```bash
git add spike/seam1/Sources/RemoteProtocol.swift spike/seam1/Tests/RemoteProtocolTests.swift spike/seam1/project.yml
git commit -m "feat(remote): control-channel wire protocol + pairing decision (pure)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `RemoteServer.swift` — Tailscale-bound TCP control server (loopback-tested)

**Files:**
- Create: `spike/seam1/Sources/RemoteServer.swift`
- Create: `spike/seam1/RemoteTests/RemoteServerTests.swift`
- Modify: `spike/seam1/project.yml` (add `ShepherdRemoteTests` target)

**Interfaces:**
- Consumes (Task 1): `ControlMessage`, `FrameCodec`, `FrameDecoder`, `PaneInfo`, `PairedDevice`, `pairingDecision`, `tailscaleIPv4`.
- Produces:
  - `final class RemoteServer` with
    `init(bindAddress: String, port: UInt16, currentCode: @escaping () -> String, knownDevices: @escaping () -> [PairedDevice], persist: @escaping (PairedDevice) -> Void, requestApproval: @escaping (_ deviceID: String, _ name: String, _ decide: @escaping (Bool) -> Void) -> Void, snapshot: @escaping () -> [PaneInfo], makeSecret: @escaping () -> String, makeNonce: @escaping () -> String)`,
    `func start() -> Bool` (false if bind fails), `func stop()`, `func broadcast(_ msg: ControlMessage)`.
  - `static func currentTailscaleIPv4() -> String?` (impure `getifaddrs` wrapper using Task 1's `tailscaleIPv4`).

- [ ] **Step 1: Write the failing loopback test**

Create `spike/seam1/RemoteTests/RemoteServerTests.swift`:

```swift
import XCTest
import Darwin

/// Drives RemoteServer over loopback with a raw TCP client speaking the frame protocol.
final class RemoteServerTests: XCTestCase {

    // A tiny blocking TCP client + frame reader for tests.
    final class TestClient {
        let fd: Int32
        let dec = FrameDecoder()
        init(port: UInt16) {
            fd = socket(AF_INET, SOCK_STREAM, 0)
            var addr = sockaddr_in()
            addr.sin_family = sa_family_t(AF_INET)
            addr.sin_port = port.bigEndian
            inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr)
            _ = withUnsafePointer(to: &addr) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
        }
        func send(_ msg: ControlMessage) { let d = try! FrameCodec.encode(msg); _ = d.withUnsafeBytes { write(fd, $0.baseAddress, d.count) } }
        /// Read until `predicate` matches a received message or timeout.
        func waitFor(_ timeout: TimeInterval = 3, _ predicate: (ControlMessage) -> Bool) -> ControlMessage? {
            let deadline = Date().addingTimeInterval(timeout)
            var buf = [UInt8](repeating: 0, count: 4096)
            while Date() < deadline {
                var tv = timeval(tv_sec: 0, tv_usec: 200_000)
                var set = fd_set(); withUnsafeMutablePointer(to: &set) { fdZero($0) }; fdSet(fd, &set)
                if select(fd + 1, &set, nil, nil, &tv) > 0 {
                    let n = read(fd, &buf, buf.count); if n <= 0 { break }
                    for m in (try? dec.feed(Data(buf[0..<n]))) ?? [] where predicate(m) { return m }
                }
            }
            return nil
        }
        deinit { close(fd) }
    }

    private func makeServer(port: UInt16, approve: Bool, known: [PairedDevice] = []) -> RemoteServer {
        RemoteServer(
            bindAddress: "127.0.0.1", port: port,
            currentCode: { "8421" },
            knownDevices: { known },
            persist: { _ in },
            requestApproval: { _, _, decide in decide(approve) },
            snapshot: { [PaneInfo(paneID: "p1", title: "claude", workspace: "Home", state: "working", reason: nil)] },
            makeSecret: { "SECRET" }, makeNonce: { "NONCE" })
    }

    func testPairWithGoodCodeApprovedReceivesSnapshot() {
        let port: UInt16 = 48721
        let server = makeServer(port: port, approve: true); XCTAssertTrue(server.start()); defer { server.stop() }
        let c = TestClient(port: port)
        c.send(.hello(deviceID: "d1", deviceName: "Pixel", pairingCode: "8421", secret: nil))
        XCTAssertNotNil(c.waitFor { if case .accepted = $0 { return true }; return false }, "expected accepted")
        XCTAssertNotNil(c.waitFor { if case .snapshot(let p) = $0 { return p.first?.paneID == "p1" }; return false }, "expected snapshot")
    }

    func testWrongCodeRejected() {
        let port: UInt16 = 48722
        let server = makeServer(port: port, approve: true); XCTAssertTrue(server.start()); defer { server.stop() }
        let c = TestClient(port: port)
        c.send(.hello(deviceID: "d1", deviceName: "Pixel", pairingCode: "0000", secret: nil))
        XCTAssertNotNil(c.waitFor { if case .rejected = $0 { return true }; return false }, "expected rejected")
    }

    func testBroadcastReachesPairedClient() {
        let port: UInt16 = 48723
        let server = makeServer(port: port, approve: true); XCTAssertTrue(server.start()); defer { server.stop() }
        let c = TestClient(port: port)
        c.send(.hello(deviceID: "d1", deviceName: "Pixel", pairingCode: "8421", secret: nil))
        _ = c.waitFor { if case .snapshot = $0 { return true }; return false }
        server.broadcast(.state(paneID: "p1", state: "blocked", reason: "approve Bash"))
        let got = c.waitFor { if case .state = $0 { return true }; return false }
        XCTAssertEqual(got, .state(paneID: "p1", state: "blocked", reason: "approve Bash"))
    }
}

// fd_set helpers (Swift can't use the FD_* macros directly).
private func fdZero(_ s: UnsafeMutablePointer<fd_set>) { bzero(s, MemoryLayout<fd_set>.size) }
private func fdSet(_ fd: Int32, _ s: inout fd_set) {
    let o = Int(fd) / 32, b = Int(fd) % 32
    withUnsafeMutablePointer(to: &s.fds_bits) {
        $0.withMemoryRebound(to: Int32.self, capacity: 32) { $0[o] |= Int32(1 << b) }
    }
}
```

- [ ] **Step 2: Add the `ShepherdRemoteTests` target + regenerate; run to verify it fails**

In `project.yml`, add under `targets:`:
```yaml
  ShepherdRemoteTests:
    type: bundle.unit-test
    platform: macOS
    sources:
      - path: RemoteTests
      - path: Sources/RemoteProtocol.swift
      - path: Sources/RemoteServer.swift
```
Then:
```bash
cd spike/seam1 && xcodegen generate
xcodebuild test -project Shepherd.xcodeproj -scheme ShepherdRemoteTests -destination 'platform=macOS' -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache 2>&1 | tail -20
```
Expected: FAIL to compile (`cannot find 'RemoteServer'`). Then implement Step 3 and re-run.

- [ ] **Step 3: Write `RemoteServer.swift`**

Create `spike/seam1/Sources/RemoteServer.swift`:

```swift
import Foundation
#if canImport(Darwin)
import Darwin
#endif

/// TCP control-channel server. Binds `bindAddress:port` (the Tailscale interface in
/// production, 127.0.0.1 in tests), accepts connections on a background queue, runs
/// the pairing handshake, and broadcasts ControlMessages to paired clients. Decoupled
/// from AgentStore via closures so it is loopback-testable.
final class RemoteServer {
    private let bindAddress: String
    private let port: UInt16
    private let currentCode: () -> String
    private let knownDevices: () -> [PairedDevice]
    private let persist: (PairedDevice) -> Void
    private let requestApproval: (String, String, @escaping (Bool) -> Void) -> Void
    private let snapshot: () -> [PaneInfo]
    private let makeSecret: () -> String
    private let makeNonce: () -> String

    private var listenFD: Int32 = -1
    private let queue = DispatchQueue(label: "shepherd.remote", qos: .utility)
    private let clientsLock = NSLock()
    private var clients: [Int32] = []          // paired, writable connections

    init(bindAddress: String, port: UInt16,
         currentCode: @escaping () -> String,
         knownDevices: @escaping () -> [PairedDevice],
         persist: @escaping (PairedDevice) -> Void,
         requestApproval: @escaping (String, String, @escaping (Bool) -> Void) -> Void,
         snapshot: @escaping () -> [PaneInfo],
         makeSecret: @escaping () -> String,
         makeNonce: @escaping () -> String) {
        self.bindAddress = bindAddress; self.port = port
        self.currentCode = currentCode; self.knownDevices = knownDevices
        self.persist = persist; self.requestApproval = requestApproval
        self.snapshot = snapshot; self.makeSecret = makeSecret; self.makeNonce = makeNonce
    }

    /// Resolve this machine's Tailscale IPv4 (100.64.0.0/10), or nil if Tailscale is down.
    static func currentTailscaleIPv4() -> String? {
        var addrs: [(name: String, ipv4: String)] = []
        var ifap: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifap) == 0, let first = ifap else { return nil }
        defer { freeifaddrs(ifap) }
        var ptr: UnsafeMutablePointer<ifaddrs>? = first
        while let cur = ptr {
            if let sa = cur.pointee.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET) {
                var buf = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
                var sin = UnsafeRawPointer(sa).assumingMemoryBound(to: sockaddr_in.self).pointee
                inet_ntop(AF_INET, &sin.sin_addr, &buf, socklen_t(INET_ADDRSTRLEN))
                let name = String(cString: cur.pointee.ifa_name)
                addrs.append((name, String(cString: buf)))
            }
            ptr = cur.pointee.ifa_next
        }
        return tailscaleIPv4(from: addrs)
    }

    @discardableResult
    func start() -> Bool {
        listenFD = socket(AF_INET, SOCK_STREAM, 0)
        guard listenFD >= 0 else { return false }
        var yes: Int32 = 1
        setsockopt(listenFD, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        inet_pton(AF_INET, bindAddress, &addr.sin_addr)
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(listenFD, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0, listen(listenFD, 8) == 0 else { close(listenFD); listenFD = -1; return false }
        queue.async { [weak self] in self?.acceptLoop() }
        return true
    }

    func stop() {
        if listenFD >= 0 { close(listenFD); listenFD = -1 }
        clientsLock.lock(); clients.forEach { close($0) }; clients.removeAll(); clientsLock.unlock()
    }

    private func acceptLoop() {
        while listenFD >= 0 {
            let fd = accept(listenFD, nil, nil)
            if fd < 0 { if errno == EINTR { continue } else { break } }
            queue.async { [weak self] in self?.handleConnection(fd) }
        }
    }

    private func handleConnection(_ fd: Int32) {
        let dec = FrameDecoder()
        var buf = [UInt8](repeating: 0, count: 8192)
        var paired = false
        while true {
            let n = read(fd, &buf, buf.count)
            if n <= 0 { break }
            let msgs = (try? dec.feed(Data(buf[0..<n]))) ?? []
            for m in msgs {
                switch m {
                case let .hello(deviceID, name, code, secret) where !paired:
                    let decision = pairingDecision(deviceID: deviceID, name: name, code: code, secret: secret,
                                                   known: knownDevices(), currentCode: currentCode(),
                                                   newSecret: makeSecret())
                    switch decision {
                    case .accept:
                        paired = true; admit(fd)
                    case .reject(let reason):
                        write(fd, encode(.rejected(reason: reason))); close(fd); return
                    case let .needsApproval(deviceID, name, proposedSecret):
                        write(fd, encode(.pendingApproval))
                        requestApproval(deviceID, name) { [weak self] ok in
                            guard let self else { return }
                            self.queue.async {
                                if ok {
                                    self.persist(PairedDevice(deviceID: deviceID, secret: proposedSecret, name: name))
                                    self.admit(fd)
                                } else {
                                    self.write(fd, self.encode(.rejected(reason: "denied"))); close(fd)
                                }
                            }
                        }
                        // After pending, keep reading is unnecessary; admit() (on approval) marks paired.
                        // We return from the read loop; admit installs the client for broadcasts.
                        return
                    }
                case .ping: write(fd, encode(.pong))
                case .detach: close(fd); removeClient(fd); return
                default: break
                }
            }
        }
        removeClient(fd); close(fd)
    }

    /// Mark a connection paired: register it for broadcasts and send accepted + snapshot.
    private func admit(_ fd: Int32) {
        clientsLock.lock(); clients.append(fd); clientsLock.unlock()
        write(fd, encode(.accepted(sessionNonce: makeNonce())))
        write(fd, encode(.snapshot(panes: snapshot())))
        // Keep reading this fd for ping/detach.
        queue.async { [weak self] in self?.readLoopAfterAdmit(fd) }
    }

    private func readLoopAfterAdmit(_ fd: Int32) {
        let dec = FrameDecoder()
        var buf = [UInt8](repeating: 0, count: 8192)
        while true {
            let n = read(fd, &buf, buf.count)
            if n <= 0 { break }
            for m in (try? dec.feed(Data(buf[0..<n]))) ?? [] {
                if case .ping = m { write(fd, encode(.pong)) }
                if case .detach = m { break }
            }
        }
        removeClient(fd); close(fd)
    }

    func broadcast(_ msg: ControlMessage) {
        let data = (try? FrameCodec.encode(msg)) ?? Data()
        clientsLock.lock(); let fds = clients; clientsLock.unlock()
        for fd in fds { _ = data.withUnsafeBytes { write(fd, $0.baseAddress, data.count) } }
    }

    private func removeClient(_ fd: Int32) {
        clientsLock.lock(); clients.removeAll { $0 == fd }; clientsLock.unlock()
    }

    private func encode(_ m: ControlMessage) -> Data { (try? FrameCodec.encode(m)) ?? Data() }
    @discardableResult private func write(_ fd: Int32, _ data: Data) -> Int {
        data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, data.count) }
    }
}
```

> **Implementer note:** the `handleConnection` pre-admit read loop hands off to
> `admit` → `readLoopAfterAdmit` once paired (directly, or after async approval),
> so a paired connection has exactly one active reader. If you find the two-loop
> handoff races under the tests, simplify to a single loop with a `paired` flag and
> a `pendingApproval` gate — keep the observable behavior (accepted+snapshot on
> pairing, pong on ping, broadcasts delivered) identical.

- [ ] **Step 4: Run the loopback tests green**
```bash
cd spike/seam1 && xcodegen generate
xcodebuild test -project Shepherd.xcodeproj -scheme ShepherdRemoteTests -destination 'platform=macOS' -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache 2>&1 | grep -E "Test Case|Executed|TEST (SUCCEEDED|FAILED)" | tail -12
```
Expected: 3/3 pass (`testPairWithGoodCodeApprovedReceivesSnapshot`, `testWrongCodeRejected`, `testBroadcastReachesPairedClient`).

- [ ] **Step 5: Commit**
```bash
git add spike/seam1/Sources/RemoteServer.swift spike/seam1/RemoteTests spike/seam1/project.yml
git commit -m "feat(remote): Tailscale-bound TCP control server with pairing + broadcast

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Wire the server into `AgentStore` + approve UI

**Files:**
- Modify: `spike/seam1/Sources/AgentStore.swift`
- Create: `spike/seam1/Sources/PairingApprovalView.swift`
- Modify: a settings/host surface to show the pairing code + start/stop with the serve toggle (e.g. `WorkspaceSwitcher.swift` "Add remote host…" area or the existing Settings; pick the smallest fit and follow its pattern).

**Interfaces:**
- Consumes: `RemoteServer`, `PaneInfo`, `PairedDevice`, `ControlMessage`, and `RemoteServer.currentTailscaleIPv4()`.
- Produces on `AgentStore`: `@Published var pendingApproval: (deviceID: String, name: String)?`, `func respondToApproval(_ ok: Bool)`, `func startRemoteServingIfEnabled()`, and a `fleetSnapshot() -> [PaneInfo]`.

- [ ] **Step 1: Add `fleetSnapshot()` + a unit-style test of snapshot construction**

`fleetSnapshot()` maps every pane across all workspaces to `PaneInfo`. Because `AgentStore` is `@MainActor`/AppKit (not in the pure target), test the **mapping** as a pure free function in `RemoteProtocol.swift` and call it from `AgentStore`. Add to `RemoteProtocol.swift`:

```swift
/// Build the projected fleet from (workspaceName, paneID, title, state, reason) rows.
func buildSnapshot(_ rows: [(workspace: String, paneID: String, title: String, state: String, reason: String?)]) -> [PaneInfo] {
    rows.map { PaneInfo(paneID: $0.paneID, title: $0.title, workspace: $0.workspace, state: $0.state, reason: $0.reason) }
}
```
Add to `RemoteProtocolTests.swift`:
```swift
func testBuildSnapshotMapsRows() {
    let s = buildSnapshot([("Home","p1","claude","blocked","approve Bash")])
    XCTAssertEqual(s, [PaneInfo(paneID:"p1", title:"claude", workspace:"Home", state:"blocked", reason:"approve Bash")])
}
```
Run `ShepherdModelTests/RemoteProtocolTests` → green.

- [ ] **Step 2: Wire `AgentStore`**

In `AgentStore.swift`, add (near the other properties + `apply`):
```swift
    @Published var pendingApproval: (deviceID: String, name: String)?
    private var approvalDecider: ((Bool) -> Void)?
    private var remoteServer: RemoteServer?
    private let remotePort: UInt16 = 8722
    private var pairingCode = String(format: "%04d", Int.random(in: 0...9999))
    private var pairedDevices: [PairedDevice] = []   // TODO-free: load/save via UserDefaults key "shepherd.remote.devices"

    func fleetSnapshot() -> [PaneInfo] {
        buildSnapshot(workspaces.flatMap { ws in
            ws.tabs.flatMap { $0.root.panes.map {
                (ws.displayName, $0.paneID, $0.displayTitle, $0.state.rawValue, $0.reason)
            } }
        })
    }

    func startRemoteServingIfEnabled() {
        guard isServing, remoteServer == nil, let ip = RemoteServer.currentTailscaleIPv4() else { return }
        let s = RemoteServer(
            bindAddress: ip, port: remotePort,
            currentCode: { [weak self] in self?.pairingCode ?? "" },
            knownDevices: { [weak self] in self?.pairedDevices ?? [] },
            persist: { [weak self] dev in self?.pairedDevices.append(dev) /* + persist to UserDefaults */ },
            requestApproval: { [weak self] deviceID, name, decide in
                DispatchQueue.main.async {
                    self?.approvalDecider = decide
                    self?.pendingApproval = (deviceID, name)
                }
            },
            snapshot: { [weak self] in self?.fleetSnapshot() ?? [] },
            makeSecret: { UUID().uuidString }, makeNonce: { UUID().uuidString })
        if s.start() { remoteServer = s }
    }

    func respondToApproval(_ ok: Bool) {
        approvalDecider?(ok); approvalDecider = nil; pendingApproval = nil
    }
```
At the end of `apply(...)` (after `updateDockBadge()`), forward the transition:
```swift
        remoteServer?.broadcast(.state(paneID: paneID, state: res.state.rawValue, reason: res.reason))
```
In `postPaneClosed(_:)` (reuse the existing close hook), also broadcast removals:
```swift
        for id in ids { remoteServer?.broadcast(.paneRemoved(paneID: id)) }
```
Call `startRemoteServingIfEnabled()` from `init` (after `restore()`), and after any place that flips `isServing` on (for v1, also call it once on launch — the flag is read at startup).

> Confirm `Pane.displayTitle`, `Workspace.displayName`, `SplitNode.panes`, and
> `Pane.reason`/`Pane.state` exist (they are used elsewhere: `displayTitle` per ADR
> 0011, `displayName` on `Workspace`, `.panes` in `SplitContainer`). If a name
> differs, use the actual accessor — do not invent one.

- [ ] **Step 3: Approve sheet + pairing code UI**

Create `spike/seam1/Sources/PairingApprovalView.swift`:
```swift
import SwiftUI

/// Sheet shown when a remote device requests pairing.
struct PairingApprovalView: View {
    @ObservedObject var store = AgentStore.shared
    var body: some View {
        if let p = store.pendingApproval {
            VStack(spacing: 16) {
                Text("“\(p.name)” wants to pair").font(.headline)
                Text("Allow this device to control your agents?").font(.subheadline).foregroundColor(Theme.textDim)
                HStack {
                    Button("Deny") { store.respondToApproval(false) }
                    Button("Allow") { store.respondToApproval(true) }.keyboardShortcut(.defaultAction)
                }
            }.padding(24).frame(width: 320)
        }
    }
}
```
Present it from the app's content (e.g. a `.sheet(isPresented:)` bound to `store.pendingApproval != nil` in `ContentView`), and surface `pairingCode` somewhere in Settings/host UI (text + a QR is a later nicety). Match the existing modal/sheet pattern (`NewWorkspaceModal.swift`).

- [ ] **Step 4: Build the app (no launch)**
```bash
cd spike/seam1 && xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | grep -E "BUILD (SUCCEEDED|FAILED)|error:" | tail -8
```
Expected: BUILD SUCCEEDED. Also re-run `ShepherdModelTests` + `ShepherdRemoteTests` green.

- [ ] **Step 5: Commit**
```bash
git add spike/seam1/Sources/AgentStore.swift spike/seam1/Sources/PairingApprovalView.swift spike/seam1/Sources/RemoteProtocol.swift spike/seam1/Sources/ContentView.swift spike/seam1/project.yml
git commit -m "feat(remote): start control server on serve toggle, forward state, approve sheet

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Deferred to user (runtime checklist — needs the live app + a tailnet peer; do NOT run for them)

- With serving on + Tailscale up, confirm the server binds the `100.x` address (not `0.0.0.0`): `lsof -nP -iTCP:8722 -sTCP:LISTEN`.
- Pair a raw client (or the future Android app) and confirm the approve sheet appears, snapshot arrives, and live `State` updates stream as agents change.
- Confirm refusal when Tailscale is down (no `100.x` → server doesn't start).

## Self-Review

**Spec coverage** (vs `2026-06-30-android-client-design.md` §4): control channel (`Snapshot`/`State`/`Pane*`) ✓ (Tasks 1–3); pairing + approve + per-device secret ✓ (Tasks 1–3); Tailscale-only bind ✓ (Task 2 `currentTailscaleIPv4` + bind); `RemoteProtocol.swift` pure + tested ✓ (Task 1). **Deliberately out of scope** (own plans): FCM push (`FCMPusher`), per-pane data channels, `RefreshFCMToken`, `PaneAdded`/`PaneRenamed` broadcasts beyond removal (added when the Android UI needs them), QR rendering. The `sessionNonce` is sent now (used by Phase-2 data-channel gating) but not yet enforced.

**Placeholder scan:** the two `// + persist to UserDefaults` / `load/save` notes in Task 3 Step 2 are real follow-ups — the implementer must wire `pairedDevices` load/save to UserDefaults key `shepherd.remote.devices` (Codable array) as part of Step 2, not leave it in-memory. (Flagged, not silently dropped.)

**Type consistency:** `ControlMessage`, `PaneInfo`, `FrameCodec`/`FrameDecoder`, `PairedDevice`, `pairingDecision`, `tailscaleIPv4`, `buildSnapshot`, `RemoteServer(...)` init signature, `broadcast`, `currentTailscaleIPv4` — names match across Tasks 1–3 and the tests.
