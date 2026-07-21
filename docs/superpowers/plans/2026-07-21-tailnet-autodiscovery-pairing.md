# Tailnet Auto-Discovery Pairing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace manual "host + 4-digit code" remote pairing with auto-discovery of the user's own Tailscale devices, gated by a host-side verified-identity + same-`UserID` check and the existing approval popup.

**Architecture:** A new pure-model core — `VerifiedPeer` + a rewritten `pairingDecision` (identity-gated, no code) in `RemoteProtocol.swift`, and a `TailscaleDiscovery` service (parse `tailscale status --json`, same-`UserID` filter, TCP port-probe, source-IP→identity match). The host (`RemoteServer`) captures each connection's peer IP and resolves it to a verified identity; a new `RemoteDeviceSheet` lists discovered peers and pairs on click. The pairing-code path is deleted end-to-end.

**Tech Stack:** Swift / SwiftUI / AppKit, libghostty app (`spike/seam1`), XCTest (`ShepherdModelTests` pure, `ShepherdRemoteTests` loopback), xcodegen, the bundled `tailscale` CLI (`status --json`).

## Global Constraints

- **`xcodegen generate` after any source file add/remove** (in `spike/seam1`), else the new file isn't compiled.
- **libghostty C API calls happen on the main thread**; `@Published` mutations on main.
- **Sidebar/HUD SwiftUI controls stay `.focusable(false)`** so focus stays on the terminal.
- **No protocol version bump.** `ControlMessage.hello`'s `pairingCode` field stays on the wire (Android still sends it); the host simply ignores it. `kRemoteProtocolVersion` is unchanged.
- **Tailscale binary resolution order (never assume the shim):** `/Applications/Tailscale.app/Contents/MacOS/Tailscale` → `/usr/local/bin/tailscale` → `/opt/homebrew/bin/tailscale` → `/usr/bin/tailscale`. First existing path wins.
- **"Mine" = `peer.UserID == Self.UserID`.** Peers with a different `UserID` (shared nodes / other org users) are never pairable and never verify.
- **Commit messages end with:** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Verify by compile + unit tests; defer runtime/two-Mac checks to the user** (never `killall`/relaunch Shepherd — it's the user's daily terminal).
- Build command (from `spike/seam1`):
  ```sh
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
    -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
    CLANG_MODULE_CACHE_PATH=./build/ModuleCache build
  ```
- Test command (from `spike/seam1`, per-target):
  ```sh
  xcodebuild test -project Shepherd.xcodeproj -scheme Shepherd \
    -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
    CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
    -only-testing:ShepherdModelTests/<Class>/<method>
  ```

---

### Task 1: Identity-gated `pairingDecision` (pure)

Rewrite the pure pairing gate: drop the code, add a verified-peer identity and a same-`UserID` check. This is the security core and is fully unit-testable.

**Files:**
- Modify: `spike/seam1/Sources/RemoteProtocol.swift:169-180` (the `pairingDecision` func + add `VerifiedPeer`)
- Test: `spike/seam1/Tests/RemotePairingTests.swift` (create)

**Interfaces:**
- Produces:
  - `struct VerifiedPeer: Equatable { let userID: String; let name: String }`
  - `func pairingDecision(deviceID: String, secret: String?, known: [PairedDevice], newSecret: String, peer: VerifiedPeer?, selfUserID: String?) -> PairingDecision`
  - (unchanged) `enum PairingDecision { case accept(persistSecret: String?); case reject(reason: String); case needsApproval(deviceID: String, name: String, proposedSecret: String) }`
- Consumes: `PairedDevice` (existing, `RemoteProtocol.swift:156`).

- [ ] **Step 1: Write the failing tests**

Create `spike/seam1/Tests/RemotePairingTests.swift`:

```swift
import XCTest
@testable import Shepherd

final class RemotePairingTests: XCTestCase {
    private let known = [PairedDevice(deviceID: "known", secret: "S", name: "Old Mac", fcmToken: nil)]

    func testKnownDeviceGoodSecretAccepts() {
        let d = pairingDecision(deviceID: "known", secret: "S", known: known, newSecret: "NEW",
                                peer: VerifiedPeer(userID: "u1", name: "Old Mac"), selfUserID: "u1")
        XCTAssertEqual(d, .accept(persistSecret: nil))
    }

    func testKnownDeviceBadSecretRejects() {
        let d = pairingDecision(deviceID: "known", secret: "WRONG", known: known, newSecret: "NEW",
                                peer: VerifiedPeer(userID: "u1", name: "Old Mac"), selfUserID: "u1")
        XCTAssertEqual(d, .reject(reason: "bad secret"))
    }

    func testUnknownVerifiedSameUserNeedsApprovalWithVerifiedName() {
        let d = pairingDecision(deviceID: "new", secret: nil, known: known, newSecret: "NEW",
                                peer: VerifiedPeer(userID: "u1", name: "Verified Mini"), selfUserID: "u1")
        // Name comes from the verified peer, NOT any self-reported hello string.
        XCTAssertEqual(d, .needsApproval(deviceID: "new", name: "Verified Mini", proposedSecret: "NEW"))
    }

    func testUnknownReusesClientSecretWhenProvided() {
        let d = pairingDecision(deviceID: "new", secret: "CLIENTSEC", known: known, newSecret: "NEW",
                                peer: VerifiedPeer(userID: "u1", name: "Mini"), selfUserID: "u1")
        XCTAssertEqual(d, .needsApproval(deviceID: "new", name: "Mini", proposedSecret: "CLIENTSEC"))
    }

    func testUnknownDifferentUserRejected() {
        let d = pairingDecision(deviceID: "new", secret: nil, known: known, newSecret: "NEW",
                                peer: VerifiedPeer(userID: "OTHER", name: "Colleague Mac"), selfUserID: "u1")
        XCTAssertEqual(d, .reject(reason: "unverified peer"))
    }

    func testUnknownUnresolvedIPRejected() {
        let d = pairingDecision(deviceID: "new", secret: nil, known: known, newSecret: "NEW",
                                peer: nil, selfUserID: "u1")
        XCTAssertEqual(d, .reject(reason: "unverified peer"))
    }

    func testUnknownRejectedWhenSelfUserIDMissing() {
        let d = pairingDecision(deviceID: "new", secret: nil, known: known, newSecret: "NEW",
                                peer: VerifiedPeer(userID: "u1", name: "Mini"), selfUserID: nil)
        XCTAssertEqual(d, .reject(reason: "unverified peer"))
    }
}
```

- [ ] **Step 2: Run tests, verify they fail to compile**

Run:
```sh
xcodebuild test -project Shepherd.xcodeproj -scheme Shepherd -derivedDataPath ./build \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  -only-testing:ShepherdModelTests/RemotePairingTests
```
Expected: build failure — `cannot find 'VerifiedPeer' in scope` / `pairingDecision` argument mismatch. (New test file under `Tests/` is auto-globbed; no `xcodegen` needed for a test-only file.)

- [ ] **Step 3: Rewrite `pairingDecision` + add `VerifiedPeer`**

In `spike/seam1/Sources/RemoteProtocol.swift`, replace the existing `pairingDecision` (lines 169-180) with:

```swift
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
```

- [ ] **Step 4: Run tests, verify pass**

Run the Step-2 command. Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```sh
git add spike/seam1/Sources/RemoteProtocol.swift spike/seam1/Tests/RemotePairingTests.swift
git commit -m "feat(remote): identity-gated pairingDecision, drop pairing code

$(printf 'Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: `TailscaleDiscovery` service (pure parse/filter + shell)

Parse `tailscale status --json`, filter to same-`UserID` peers, derive per-row pairability, resolve a source IP → `VerifiedPeer`, and probe a peer's control port. Pure functions are unit-tested; the `Process`/socket bits compile but aren't exercised by unit tests.

**Files:**
- Create: `spike/seam1/Sources/TailscaleDiscovery.swift`
- Modify: `spike/seam1/project.yml` (add the file to the `Shepherd` app target's `Sources` — it's already globbed by `- path: Sources`, so **no change needed there** — and to `ShepherdModelTests` `sources:` explicitly)
- Test: `spike/seam1/Tests/TailscaleDiscoveryTests.swift` (create)

**Interfaces:**
- Consumes: `VerifiedPeer` (Task 1).
- Produces:
  - `struct TSPeer: Equatable { let hostName: String; let dnsName: String; let os: String; let online: Bool; let userID: String; let ipv4: String? }`
  - `struct TSStatus: Equatable { let selfUserID: String?; let peers: [TSPeer]; let userNames: [String: String] }`
  - `struct RemoteDeviceRow: Equatable, Identifiable { enum Pairability { case pairable, notServing, offline }; let id: String; let name: String; let os: String; let ipv4: String?; let pairability: Pairability }`
  - `enum TailscaleDiscovery` with pure statics: `parse(_:) -> TSStatus?`, `myPeers(_:) -> [TSPeer]`, `row(for:portOpen:) -> RemoteDeviceRow`, `verifiedPeer(forIP:in:) -> VerifiedPeer?`, `resolveBinary(exists:) -> String?`; and shell instance/statics `fetchStatus() -> TSStatus?`, `probe(host:port:timeoutMs:) -> Bool`.

- [ ] **Step 1: Write the failing tests**

Create `spike/seam1/Tests/TailscaleDiscoveryTests.swift`:

```swift
import XCTest
@testable import Shepherd

final class TailscaleDiscoveryTests: XCTestCase {
    // Trimmed shape of `tailscale status --json`: Self + two peers (one same-user, one other-user).
    private let json = Data("""
    {
      "Self": { "UserID": 1, "HostName": "my-mac", "DNSName": "my-mac.tail.ts.net.",
                "OS": "macOS", "Online": true, "TailscaleIPs": ["100.78.141.27"] },
      "User": {
        "1": { "ID": 1, "LoginName": "me@example.com", "DisplayName": "Me" },
        "9": { "ID": 9, "LoginName": "co@corp.com", "DisplayName": "Coworker" }
      },
      "Peer": {
        "keyA": { "UserID": 1, "HostName": "mac-mini", "DNSName": "mac-mini.tail.ts.net.",
                  "OS": "macOS", "Online": true, "TailscaleIPs": ["100.115.91.30", "fd7a::1"] },
        "keyB": { "UserID": 9, "HostName": "colleague", "DNSName": "colleague.tail.ts.net.",
                  "OS": "linux", "Online": true, "TailscaleIPs": ["100.9.9.9"] },
        "keyC": { "UserID": 1, "HostName": "phone", "DNSName": "phone.tail.ts.net.",
                  "OS": "android", "Online": false, "TailscaleIPs": ["100.121.36.111"] }
      }
    }
    """.utf8)

    func testParseSelfAndPeersExcludingSelf() {
        let s = TailscaleDiscovery.parse(json)!
        XCTAssertEqual(s.selfUserID, "1")
        XCTAssertEqual(s.peers.count, 3)                       // Self excluded, all 3 Peer entries kept
        XCTAssertEqual(s.userNames["1"], "Me")
        let mini = s.peers.first { $0.hostName == "mac-mini" }!
        XCTAssertEqual(mini.ipv4, "100.115.91.30")             // first 100.x, IPv6 skipped
        XCTAssertEqual(mini.dnsName, "mac-mini.tail.ts.net")   // trailing dot trimmed
    }

    func testMyPeersDropsOtherUser() {
        let s = TailscaleDiscovery.parse(json)!
        let mine = TailscaleDiscovery.myPeers(s)
        XCTAssertEqual(Set(mine.map(\.hostName)), ["mac-mini", "phone"])   // "colleague" (UserID 9) excluded
    }

    func testRowPairability() {
        let s = TailscaleDiscovery.parse(json)!
        let mini = s.peers.first { $0.hostName == "mac-mini" }!
        let phone = s.peers.first { $0.hostName == "phone" }!
        XCTAssertEqual(TailscaleDiscovery.row(for: mini, portOpen: true).pairability, .pairable)
        XCTAssertEqual(TailscaleDiscovery.row(for: mini, portOpen: false).pairability, .notServing)
        XCTAssertEqual(TailscaleDiscovery.row(for: phone, portOpen: false).pairability, .offline)  // offline wins
    }

    func testVerifiedPeerMatchesSameUserIP() {
        let s = TailscaleDiscovery.parse(json)!
        XCTAssertEqual(TailscaleDiscovery.verifiedPeer(forIP: "100.115.91.30", in: s),
                       VerifiedPeer(userID: "1", name: "mac-mini"))   // name = hostName
    }

    func testVerifiedPeerNilForUnknownIP() {
        let s = TailscaleDiscovery.parse(json)!
        XCTAssertNil(TailscaleDiscovery.verifiedPeer(forIP: "10.0.0.1", in: s))
    }

    func testResolveBinaryPrefersAppBundle() {
        // Only the Homebrew path "exists" → it wins (app bundle absent).
        let hb = TailscaleDiscovery.resolveBinary { $0 == "/opt/homebrew/bin/tailscale" }
        XCTAssertEqual(hb, "/opt/homebrew/bin/tailscale")
        // App bundle present → it wins over everything.
        let app = TailscaleDiscovery.resolveBinary { _ in true }
        XCTAssertEqual(app, "/Applications/Tailscale.app/Contents/MacOS/Tailscale")
        XCTAssertNil(TailscaleDiscovery.resolveBinary { _ in false })
    }
}
```

- [ ] **Step 2: Run tests, verify they fail to compile**

Run:
```sh
xcodebuild test -project Shepherd.xcodeproj -scheme Shepherd -derivedDataPath ./build \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  -only-testing:ShepherdModelTests/TailscaleDiscoveryTests
```
Expected: build failure — `cannot find 'TailscaleDiscovery' in scope`. (Requires `xcodegen` after Step 3 because a new **source** file must be added to the test target.)

- [ ] **Step 3: Create `TailscaleDiscovery.swift`**

Create `spike/seam1/Sources/TailscaleDiscovery.swift`:

```swift
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
```

- [ ] **Step 4: Add the file to the `ShepherdModelTests` target and regenerate**

In `spike/seam1/project.yml`, under `ShepherdModelTests:` → `sources:`, add a line after `- path: Sources/RemoteProtocol.swift`:

```yaml
      - path: Sources/TailscaleDiscovery.swift
```

Then regenerate:
```sh
cd spike/seam1 && xcodegen generate
```
Expected: `Loaded project`, no error. (The `Shepherd` app target picks the file up automatically via its `- path: Sources` glob.)

- [ ] **Step 5: Run tests, verify pass**

Run the Step-2 command. Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```sh
git add spike/seam1/Sources/TailscaleDiscovery.swift spike/seam1/Tests/TailscaleDiscoveryTests.swift spike/seam1/project.yml
git commit -m "feat(remote): TailscaleDiscovery — parse/filter/probe tailnet peers

$(printf 'Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 3: `RemoteServer` — capture peer IP, identity-gate, drop code

Wire the host: capture each connection's source IP at `accept`, resolve it to a `VerifiedPeer`, feed the new `pairingDecision`, and remove the `currentCode` dependency. Migrate the loopback tests off code-based pairing.

**Files:**
- Modify: `spike/seam1/Sources/RemoteServer.swift` (`init` params 108-130; `acceptLoop` 196-214; `ConnState` 98-106; `handleConnection` 235-252; `process` `.hello` case 278-314)
- Modify: `spike/seam1/RemoteTests/RemoteServerTests.swift` (`makeServer` 93-106; the two code tests 123-141; three other `RemoteServer(...)` sites at 272, 296, 319)
- Modify: `spike/seam1/RemoteTests/DataChannelTests.swift:273-278` and `spike/seam1/RemoteTests/RemoteClientTests.swift:17-22` (`RemoteServer(...)` construction: drop `currentCode`, add the two new closures)

**Interfaces:**
- Consumes: `pairingDecision(...)` + `VerifiedPeer` (Task 1); `TailscaleDiscovery` (Task 2, only in the production wiring — Task 4).
- Produces: `RemoteServer.init` gains `verifyPeer: @escaping (String) -> VerifiedPeer?` and `selfUserID: @escaping () -> String?`, and **drops** `currentCode`. Everything else on `init` is unchanged.

- [ ] **Step 1: Update the loopback tests (the failing spec)**

In `spike/seam1/RemoteTests/RemoteServerTests.swift`, replace `makeServer` (lines 93-106) with a version that drops `currentCode` and injects identity knobs (default: loopback peer is same-user):

```swift
    private func makeServer(port: UInt16, approve: Bool, known: [PairedDevice] = [],
                            verifiedPeer: VerifiedPeer? = VerifiedPeer(userID: "u1", name: "Pixel"),
                            selfUserID: String? = "u1",
                            workspaceTrees: @escaping () -> [WorkspaceTree] = { RemoteServerTests.oneTree() },
                            onCommand: @escaping (ControlMessage) -> Void = { _ in }) -> RemoteServer {
        RemoteServer(
            bindAddress: "127.0.0.1", port: port,
            knownDevices: { known },
            persist: { _ in },
            requestApproval: { _, _, decide in decide(approve) },
            workspaceTrees: workspaceTrees,
            updateFCMToken: { _, _ in },
            makeSecret: { "SECRET" }, makeNonce: { "NONCE" },
            verifyPeer: { _ in verifiedPeer }, selfUserID: { selfUserID },
            onCommand: onCommand)
    }
```

Replace the two code tests (lines 123-141) with identity-based equivalents:

```swift
    func testVerifiedSameUserPeerApprovedReceivesWorkspaceTrees() {
        let port: UInt16 = 48721
        let server = makeServer(port: port, approve: true); XCTAssertTrue(server.start()); defer { server.stop() }
        let c = TestClient(port: port)
        c.send(.hello(deviceID: "d1", deviceName: "Pixel", pairingCode: nil,
                      secret: nil, fcmToken: "FCMTOK", protocolVersion: kRemoteProtocolVersion))
        XCTAssertNotNil(c.waitFor { if case .accepted = $0 { return true }; return false }, "expected accepted")
        XCTAssertNotNil(c.waitFor { if case .workspaceList(let ids) = $0 { return ids == ["w1"] }; return false }, "expected workspaceList")
        XCTAssertNotNil(c.waitFor { if case .workspaceTree(let t) = $0 { return t.workspaceID == "w1" && t.tabs.first?.tabID == "t1" }; return false }, "expected workspaceTree")
    }

    func testUnverifiedPeerRejected() {
        let port: UInt16 = 48722
        // Source IP does not resolve to any tailnet peer → reject.
        let server = makeServer(port: port, approve: true, verifiedPeer: nil)
        XCTAssertTrue(server.start()); defer { server.stop() }
        let c = TestClient(port: port)
        c.send(.hello(deviceID: "d1", deviceName: "Pixel", pairingCode: nil,
                      secret: nil, fcmToken: "FCMTOK", protocolVersion: kRemoteProtocolVersion))
        XCTAssertNotNil(c.waitFor { if case .rejected = $0 { return true }; return false }, "expected rejected")
    }

    func testDifferentUserPeerRejected() {
        let port: UInt16 = 48729
        let server = makeServer(port: port, approve: true,
                                verifiedPeer: VerifiedPeer(userID: "OTHER", name: "Colleague"))
        XCTAssertTrue(server.start()); defer { server.stop() }
        let c = TestClient(port: port)
        c.send(.hello(deviceID: "d1", deviceName: "Colleague", pairingCode: nil,
                      secret: nil, fcmToken: nil, protocolVersion: kRemoteProtocolVersion))
        XCTAssertNotNil(c.waitFor { if case .rejected = $0 { return true }; return false }, "expected rejected")
    }
```

For the three remaining inline `RemoteServer(...)` constructions in this file (around lines 272, 296, 319) and the ones in `DataChannelTests.swift:273` and `RemoteClientTests.swift:17`: **delete the `currentCode: { "8421" },` line** and **add** `verifyPeer: { _ in VerifiedPeer(userID: "u1", name: "Peer") }, selfUserID: { "u1" },` immediately before `makeSecret:` (or before `onCommand:` if `makeSecret`/`makeNonce` already precede it). The `.hello(...)` sends in those tests keep their `pairingCode:` argument as-is (now ignored on the wire).

- [ ] **Step 2: Run the migrated tests, verify they fail to compile**

Run:
```sh
xcodebuild test -project Shepherd.xcodeproj -scheme Shepherd -derivedDataPath ./build \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  -only-testing:ShepherdRemoteTests/RemoteServerTests
```
Expected: build failure — `RemoteServer` has no parameter `verifyPeer` / extra argument (init not yet changed).

- [ ] **Step 3: Change `RemoteServer` init + `ConnState` + `acceptLoop` + `handleConnection` + `process`**

In `spike/seam1/Sources/RemoteServer.swift`:

(a) Stored props (near line 19): **remove** `private let currentCode: () -> String`; **add**:
```swift
    private let verifyPeer: (String) -> VerifiedPeer?
    private let selfUserID: () -> String?
```

(b) `init` (lines 108-130): remove the `currentCode:` parameter; add two parameters and their assignments. Change the signature line `currentCode: @escaping () -> String,` → delete it; after `makeNonce: @escaping () -> String,` add:
```swift
         verifyPeer: @escaping (String) -> VerifiedPeer? = { _ in nil },
         selfUserID: @escaping () -> String? = { nil },
```
In the body, delete `self.currentCode = currentCode;` and add `self.verifyPeer = verifyPeer; self.selfUserID = selfUserID`.

(c) `ConnState` (after line 103 `var deviceID: String?`): add
```swift
        var peerIP: String?
```

(d) `acceptLoop` (lines 199-213): replace the `accept(lfd, nil, nil)` block with a peer-capturing accept:
```swift
        while true {
            var sa = sockaddr_in()
            var slen = socklen_t(MemoryLayout<sockaddr_in>.size)
            let fd = withUnsafeMutablePointer(to: &sa) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { accept(lfd, $0, &slen) }
            }
            if fd < 0 { if errno == EINTR { continue } else { break } }
            var ipbuf = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
            let peerIP: String? = withUnsafePointer(to: &sa.sin_addr) {
                inet_ntop(AF_INET, $0, &ipbuf, socklen_t(INET_ADDRSTRLEN))
            } != nil ? String(cString: ipbuf) : nil
            var on: Int32 = 1
            setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &on, socklen_t(MemoryLayout<Int32>.size))
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
            var snd = timeval(tv_sec: sendTimeoutSeconds, tv_usec: 0)
            setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &snd, socklen_t(MemoryLayout<timeval>.size))
            connQueue.async { [weak self] in self?.handleConnection(fd, peerIP: peerIP) }
        }
```

(e) `handleConnection` (line 235): change the signature to `private func handleConnection(_ fd: Int32, peerIP: String?) {` and, right after `let conn = ConnState()`, set `conn.peerIP = peerIP`.

(f) `process` `.hello` case (lines 278-282): replace the destructure + `pairingDecision` call. The `code` binding is no longer used; resolve the verified peer from `conn.peerIP`:
```swift
        case let .hello(deviceID, _, _, secret, fcmToken, _) where phase == .unpaired:
            conn.lock.lock(); conn.deviceID = deviceID; let ip = conn.peerIP; conn.lock.unlock()
            let decision = pairingDecision(deviceID: deviceID, secret: secret,
                                           known: knownDevices(), newSecret: makeSecret(),
                                           peer: ip.flatMap { verifyPeer($0) }, selfUserID: selfUserID())
```
The rest of the `switch decision { ... }` block (accept/reject/needsApproval) is unchanged — note the `.accept` branch's `persist(...)` still references `name` from the destructure; since we replaced `name` with `_`, change that one line inside `.accept` to keep compiling: the branch only persists when `persistSecret != nil`, which never happens for `.accept` (always nil), so **replace** `persist(PairedDevice(deviceID: deviceID, secret: persistSecret, name: name, fcmToken: fcmToken))` with `persist(PairedDevice(deviceID: deviceID, secret: persistSecret, name: deviceID, fcmToken: fcmToken))` (name unused on this dead path; `deviceID` is a valid non-optional stand-in). The `.needsApproval` branch already uses the verified `approveName`.

- [ ] **Step 4: Run the migrated tests, verify pass**

Run:
```sh
xcodebuild test -project Shepherd.xcodeproj -scheme Shepherd -derivedDataPath ./build \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  -only-testing:ShepherdRemoteTests
```
Expected: PASS — all `RemoteServerTests` (incl. the new `testVerifiedSameUserPeerApprovedReceivesWorkspaceTrees`, `testUnverifiedPeerRejected`, `testDifferentUserPeerRejected`), `DataChannelTests`, `RemoteClientTests`.

- [ ] **Step 5: Commit**

```sh
git add spike/seam1/Sources/RemoteServer.swift spike/seam1/RemoteTests/
git commit -m "feat(remote): host verifies peer identity from source IP, drop currentCode

$(printf 'Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 4: App wiring — construct the identity-gated server, drop the code end-to-end

Wire `AgentStore` to the new server closures (verify via `TailscaleDiscovery`), remove `pairingCode`, and change the client-side `addRemoteHost` to be code-free. Compile-verified (runtime deferred to the user).

**Files:**
- Modify: `spike/seam1/Sources/AgentStore.swift` (`pairingCode` prop 108; `startRemoteServingIfEnabled` server construction 1353-1408; `addRemoteHost` 1424-1439)
- Modify: `spike/seam1/Sources/RemoteClient.swift` (`code` prop 19; `init`; `run` hello send 92-94)

**Interfaces:**
- Consumes: `RemoteServer.init` (Task 3), `TailscaleDiscovery.fetchStatus/verifiedPeer` (Task 2).
- Produces: `AgentStore.addRemoteHost(host: String, port: UInt16)` (drops `code`); removes `AgentStore.pairingCode`. `RemoteClient.init` drops its `code:` parameter.

- [ ] **Step 1: Cache tailnet status on the store (for cheap per-hello verification)**

In `spike/seam1/Sources/AgentStore.swift`, replace the `pairingCode` property (line 108) with a short-lived status cache + a resolver:

```swift
    // Cached `tailscale status` for host-side pairing verification. Refreshed at most once
    // per few seconds so a burst of hellos doesn't spawn a Process each. Serving-side only.
    private var tsStatusCache: (status: TSStatus, at: Date)?
    private let tsStatusLock = NSLock()
    private func tailnetStatus() -> TSStatus? {
        tsStatusLock.lock()
        if let c = tsStatusCache, Date().timeIntervalSince(c.at) < 5 { tsStatusLock.unlock(); return c.status }
        tsStatusLock.unlock()
        guard let s = TailscaleDiscovery.fetchStatus() else { return nil }
        tsStatusLock.lock(); tsStatusCache = (s, Date()); tsStatusLock.unlock()
        return s
    }
```

- [ ] **Step 2: Rewire the server construction**

In `startRemoteServingIfEnabled` (lines 1353-1404): **delete** the line
```swift
            currentCode: { [weak self] in self?.pairingCode ?? "" },
```
and add, just before `onCommand:` (after the `desktopOwnsSize:` closure):
```swift
            verifyPeer: { [weak self] ip in
                guard let s = self?.tailnetStatus() else { return nil }
                return TailscaleDiscovery.verifiedPeer(forIP: ip, in: s)
            },
            selfUserID: { [weak self] in self?.tailnetStatus()?.selfUserID },
```
Update the success log line (1407) from `— pairing code \(pairingCode)` to:
```swift
            shepherdLog("REMOTE serving on \(ip):\(remotePort)")
```

- [ ] **Step 3: Make `addRemoteHost` code-free**

Replace `addRemoteHost` (lines 1424-1439) — drop the `code` param and the `code:` argument to `RemoteClient`:

```swift
    func addRemoteHost(host: String, port: UInt16) {
        let hostID = "\(host):\(port)"
        guard remoteClients[hostID] == nil else { return }
        let secret = UUID().uuidString
        let client = RemoteClient(
            host: host, port: port, deviceID: clientDeviceID, deviceName: clientDeviceName,
            secret: secret,
            onAccepted: { _ in },
            onWorkspaceTree: { [weak self] tree in DispatchQueue.main.async { self?.upsertMirrorWorkspace(tree, hostID: hostID) } },
            onWorkspaceList: { [weak self] ids in DispatchQueue.main.async { self?.pruneMirrorWorkspaces(hostID: hostID, keep: ids) } },
            onWorkspaceRemoved: { [weak self] id in DispatchQueue.main.async { self?.removeMirrorWorkspace(hostID: hostID, remoteWorkspaceID: id) } },
            onState: { [weak self] p, s, r in DispatchQueue.main.async { self?.applyRemoteState(paneID: p, state: s, reason: r) } },
            onStatus: { [weak self] conn in DispatchQueue.main.async { self?.applyRemoteStatus(hostID: hostID, conn: conn) } })
        remoteClients[hostID] = client
        client.start()
    }
```

- [ ] **Step 4: Drop `code` from `RemoteClient`**

In `spike/seam1/Sources/RemoteClient.swift`: remove `private let code: String?` (line 19) and its `init` parameter + assignment. In `run` (lines 92-94), send a nil code:
```swift
        let hello = ControlMessage.hello(deviceID: deviceID, deviceName: deviceName,
                                         pairingCode: nil, secret: secret, fcmToken: nil,
                                         protocolVersion: kRemoteProtocolVersion)
```

- [ ] **Step 5: Fix the one remaining test caller of `RemoteClient(code:)`**

In `spike/seam1/RemoteTests/RemoteClientTests.swift`, the `RemoteClient(...)` under test passes `code:`; remove that argument so the helper matches the new init. (Grep first: `grep -rn "code:" spike/seam1/RemoteTests` — update every `RemoteClient(` construction that still passes `code:`.)

- [ ] **Step 6: Build + full test run, verify pass**

```sh
cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build \
&& xcodebuild test -project Shepherd.xcodeproj -scheme Shepherd -derivedDataPath ./build \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache
```
Expected: `BUILD SUCCEEDED` and `TEST SUCCEEDED` (all three test targets). If `SidebarView.swift` fails to compile here because it still references `store.pairingCode` / `addRemoteHost(host:port:code:)`, that is fixed in Task 5 — it is acceptable for this step to fail *only* on those `SidebarView` references; proceed to Task 5, then this build must pass at Task 5 Step 5.

- [ ] **Step 7: Commit**

```sh
git add spike/seam1/Sources/AgentStore.swift spike/seam1/Sources/RemoteClient.swift spike/seam1/RemoteTests/RemoteClientTests.swift
git commit -m "feat(remote): wire identity verification, remove pairing code from store+client

$(printf 'Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 5: Discovery sheet UI + sidebar rewire + verified approval copy

Add the `RemoteDeviceSheet`, present it from the ⋯ menu (replacing "Add remote host…" and the pairing-code row), and confirm the approval popup shows the verified name.

**Files:**
- Create: `spike/seam1/Sources/RemoteDeviceSheet.swift`
- Modify: `spike/seam1/Sources/AgentStore.swift` (add `@Published var showingRemoteDevices` + `discoverDevices(_:)`)
- Modify: `spike/seam1/Sources/SidebarView.swift` (`overflowMenu` 75-94; delete `promptAddRemoteHost` 151-178)
- Modify: `spike/seam1/Sources/ContentView.swift` (present the sheet, near the `pendingApproval` overlay at 71-77)
- Modify: `spike/seam1/project.yml` — none needed (app target globs `Sources`), but run `xcodegen generate`.

**Interfaces:**
- Consumes: `RemoteDeviceRow` / `TailscaleDiscovery` (Task 2), `AgentStore.addRemoteHost(host:port:)` (Task 4), `AgentStore.defaultRemotePort`, `Theme`.
- Produces: `AgentStore.showingRemoteDevices: Bool`, `AgentStore.discoverDevices(_ completion: @escaping ([RemoteDeviceRow]) -> Void)`.

- [ ] **Step 1: Add discovery entry points to `AgentStore`**

In `spike/seam1/Sources/AgentStore.swift`, near the other remote `@Published` state (by `pendingApproval`, line 90), add:

```swift
    @Published var showingRemoteDevices = false
```

And add a method (near `addRemoteHost`):

```swift
    /// Discover the user's own tailnet devices off-main, probe each online peer's control
    /// port, and deliver sorted rows on main. Empty if the tailscale binary is missing or
    /// no same-user peers exist (the sheet renders the appropriate empty state).
    func discoverDevices(_ completion: @escaping ([RemoteDeviceRow]) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            guard let status = TailscaleDiscovery.fetchStatus() else {
                DispatchQueue.main.async { completion([]) }; return
            }
            let port = AgentStore.defaultRemotePort
            let rows = TailscaleDiscovery.myPeers(status).map { peer -> RemoteDeviceRow in
                let open = peer.online && peer.ipv4.map { TailscaleDiscovery.probe(host: $0, port: port) } == true
                return TailscaleDiscovery.row(for: peer, portOpen: open)
            }
            DispatchQueue.main.async { completion(rows) }
        }
    }
```

- [ ] **Step 2: Create `RemoteDeviceSheet.swift`**

Create `spike/seam1/Sources/RemoteDeviceSheet.swift`:

```swift
import SwiftUI

/// Self-drawn Theme card listing the user's own tailnet devices (via TailscaleDiscovery).
/// Pairable rows (online + Shepherd serving) are clickable → addRemoteHost; others greyed
/// with a reason. Backdrop click / Esc dismisses. Matches PairingApprovalView styling.
struct RemoteDeviceSheet: View {
    @EnvironmentObject var store: AgentStore
    @State private var rows: [RemoteDeviceRow] = []
    @State private var loading = true
    @State private var pairing: Set<String> = []   // row ids we've clicked to pair

    var body: some View {
        ZStack {
            Color.black.opacity(0.35).ignoresSafeArea().onTapGesture { dismiss() }

            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Add remote device").font(.ui(15, .semibold)).foregroundStyle(Theme.textPrimary)
                    Spacer()
                    Button(action: refresh) {
                        Image(systemName: "arrow.clockwise").font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(Theme.textDim)
                    }.buttonStyle(.plain).focusable(false)
                }

                if loading {
                    Text("Scanning your tailnet…").font(.ui(13)).foregroundStyle(Theme.textSecondary)
                } else if rows.isEmpty {
                    Text("No other devices found on your tailnet. Make sure Tailscale is running.")
                        .font(.ui(13)).foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    ForEach(rows) { row in deviceRow(row) }
                }
            }
            .padding(18)
            .frame(width: 360)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.ground)
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Theme.hairline, lineWidth: 1))
            )
            .shadow(color: .black.opacity(0.55), radius: 30, x: 0, y: 16)
        }
        .onExitCommand { dismiss() }
        .onAppear { refresh() }
    }

    @ViewBuilder private func deviceRow(_ row: RemoteDeviceRow) -> some View {
        let enabled = row.pairability == .pairable && !pairing.contains(row.id)
        HStack(spacing: 10) {
            Image(systemName: glyph(row.os)).font(.system(size: 13))
                .foregroundStyle(enabled ? Theme.textPrimary : Theme.textDim).frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                Text(row.name).font(.ui(13, .medium))
                    .foregroundStyle(enabled ? Theme.textPrimary : Theme.textDim)
                Text(subtitle(row)).font(.ui(11)).foregroundStyle(Theme.textSecondary)
            }
            Spacer()
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 7).fill(enabled ? Theme.raised : .clear))
        .contentShape(Rectangle())
        .onTapGesture { if enabled { pair(row) } }
    }

    private func subtitle(_ row: RemoteDeviceRow) -> String {
        if pairing.contains(row.id) { return "pairing… (approve on that device)" }
        switch row.pairability {
        case .pairable:   return "ready to pair"
        case .notServing: return "Shepherd not running"
        case .offline:    return "offline"
        }
    }

    private func glyph(_ os: String) -> String {
        switch os.lowercased() {
        case "ios", "android": return "iphone"
        case "macos": return "laptopcomputer"
        default: return "desktopcomputer"
        }
    }

    private func refresh() {
        loading = true
        store.discoverDevices { r in self.rows = r; self.loading = false }
    }

    private func pair(_ row: RemoteDeviceRow) {
        guard let ip = row.ipv4 else { return }
        pairing.insert(row.id)
        store.addRemoteHost(host: ip, port: AgentStore.defaultRemotePort)
    }

    private func dismiss() { store.showingRemoteDevices = false }
}
```

- [ ] **Step 3: Rewire the sidebar ⋯ menu**

In `spike/seam1/Sources/SidebarView.swift`, replace `overflowMenu` (lines 75-94) body so it opens the sheet and drops the code row:

```swift
    private var overflowMenu: some View {
        Menu {
            Toggle("Serve to remote devices", isOn: Binding(
                get: { store.isServing },
                set: { store.setServing($0) }))
            Button("Add remote device…") { store.showingRemoteDevices = true }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.textDim)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .focusable(false)
    }
```

Delete `promptAddRemoteHost()` entirely (lines 151-178) and its doc comment.

- [ ] **Step 4: Present the sheet from `ContentView`**

In `spike/seam1/Sources/ContentView.swift`, alongside the existing `pendingApproval` overlay (around lines 71-77), add a sibling overlay in the same `ZStack`/overlay group:

```swift
            if store.showingRemoteDevices {
                RemoteDeviceSheet().transition(.opacity)
            }
```
and extend the adjacent `.animation(...)` (line 77) to also animate on `store.showingRemoteDevices` (add a second `.animation(.easeOut(duration: 0.12), value: store.showingRemoteDevices)` modifier).

- [ ] **Step 5: Regenerate, build, and full test run**

```sh
cd spike/seam1 && xcodegen generate \
&& xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build \
&& xcodebuild test -project Shepherd.xcodeproj -scheme Shepherd -derivedDataPath ./build \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache
```
Expected: `BUILD SUCCEEDED` + `TEST SUCCEEDED`. Confirm no remaining references: `grep -rn "pairingCode\|promptAddRemoteHost\|currentCode" spike/seam1/Sources` should return nothing (the `hello` case's `pairingCode:` label in `RemoteProtocol.swift`/`RemoteClient.swift` is the wire field and is fine — filter it out mentally; the *host* code path no longer reads it).

- [ ] **Step 6: Verify the approval popup already shows the verified name**

Confirm `PairingApprovalView.swift:21` reads `store.pendingApproval?.name`. Because Task 3 makes `needsApproval`'s `name` the verified peer name (from `verifyPeer`), and `requestApproval` forwards that into `pendingApproval` (`AgentStore.swift:1365`), the popup now shows the verified identity with no further change. No edit needed — this step is a read-only confirmation. (If desired copy tweak: leave as-is per YAGNI.)

- [ ] **Step 7: Commit**

```sh
git add spike/seam1/Sources/RemoteDeviceSheet.swift spike/seam1/Sources/AgentStore.swift \
        spike/seam1/Sources/SidebarView.swift spike/seam1/Sources/ContentView.swift
git commit -m "feat(remote): tailnet device discovery sheet, drop code from sidebar UI

$(printf 'Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 6: Remote-workspace indicator in the sidebar

Remote (mirror) workspaces look identical to local ones today. Add an at-a-glance marker: a small antenna glyph in the folder header when `ws.isRemote`, with a tooltip naming the host.

**Files:**
- Modify: `spike/seam1/Sources/SidebarView.swift` (`WorkspaceFolderHeader.body`, the `HStack` at lines 212-241)

**Interfaces:**
- Consumes: `Workspace.isRemote` + `Workspace.remoteHostID` (existing, `Workspace.swift:14-16`).
- Produces: no new public surface — a view-only change.

- [ ] **Step 1: Add the indicator glyph to the folder header**

In `spike/seam1/Sources/SidebarView.swift`, inside `WorkspaceFolderHeader.body`, immediately after `FolderIcon(open: !ws.collapsed, state: ws.aggregateState)` (line 213) and before the `if editing {` block, insert:

```swift
            if ws.isRemote {
                Image(systemName: "antenna.radiowaves.left.and.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Theme.textDim)
                    .help("Remote · \(remoteHostDisplay)")
            }
```

Add this computed helper to `WorkspaceFolderHeader` (near `isActive`, line 209):

```swift
    /// Host part of `remoteHostID` ("host:port") for the indicator tooltip.
    private var remoteHostDisplay: String {
        guard let id = ws.remoteHostID else { return "remote" }
        return id.split(separator: ":").first.map(String.init) ?? id
    }
```

- [ ] **Step 2: Build, verify it compiles**

```sh
cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build
```
Expected: `BUILD SUCCEEDED`. (Pure view change — no unit test; visual confirmation is part of the manual pass. A local workspace shows no glyph; a mirror shows the antenna with a host tooltip.)

- [ ] **Step 3: Commit**

```sh
git add spike/seam1/Sources/SidebarView.swift
git commit -m "feat(remote): antenna glyph marks remote workspaces in the sidebar

$(printf 'Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Manual verification (user, two Macs on the tailnet)

Deferred to the user (never relaunch Shepherd automatically). After merge + rebuild + resign:
1. Mac A: ⋯ → **Serve to remote devices** on.
2. Mac B: ⋯ → **Add remote device…** → the sheet lists Mac A as *ready to pair*; other devices greyed (offline / not serving).
3. Click Mac A → approval popup appears **on Mac A** showing Mac B's *verified* name → **Allow**.
4. Mac A's workspaces appear as mirrors on Mac B, **each folder showing the antenna glyph** (Task 6) with Mac A's host in its tooltip; reconnect after quit is silent (persisted secret).
5. Negative: a device on a *different* tailnet user (if available) never appears and, if it dials directly, is rejected.
Screenshot via the window-id `screencapture` recipe in `CLAUDE.md`.

## Self-Review notes (spec coverage)

- Spec §1/§5 identity gate → Task 1 (`pairingDecision`) + Task 3 (`verifyPeer`/`selfUserID`, same-UserID via the pure function).
- Spec §2 CLI-not-library, binary resolution order → Task 2 (`resolveBinary`, tested).
- Spec §3 discovery source + same-UserID filter + port-probe + row status → Task 2 (`parse`/`myPeers`/`row`/`probe`) + Task 5 (`discoverDevices`).
- Spec §4 pairing flow (no code) → Task 3 (host) + Task 4 (client sends nil code) + Task 5 (click → addRemoteHost).
- Spec §5 peer-IP capture + verified approval name → Task 3 (`accept` capture, `process`) + Task 5 Step 6.
- Spec §6 sheet UI, ⋯ rewire, empty state → Task 5.
- Spec §7 no version bump / `hello` field kept / `addRemoteHost` loses code / remove `pairingCode` display → Tasks 3-5.
- Spec §9 persistence unchanged → no task needed (per-device secret path untouched).
- Spec §10 testing → pure tests (Tasks 1-2), loopback E2E migration (Task 3), manual (above).
- Spec §11 milestones M1/M2/M3 map to Tasks 1+3+4 / 2 / 5 respectively.
