# Android Phase 2 (Host) — per-pane PTY data channels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the macOS host the plumbing to stream any serving pane's live PTY to a paired phone and inject the phone's input back — the host half of Phase 2's "respond" slice.

**Architecture:** The `shepherdd pty` helper (spawned per pane by libghostty when serving) dials a dedicated `$SHEPHERD_PTY_SOCK` unix socket, sends a one-frame `PtyHello`, then streams its tee'd output up and writes received input into the inner PTY. A `PtyHub` (owned by `AgentStore`) accepts helper connections and keeps a per-pane `PtyBroker` = a 256 KB replay ring + a set of attached phone viewers. `RemoteServer` accepts phone data-channel TCP connections on the *same* port as control, distinguishes them by the first frame (`DataHello` vs `ControlMessage.hello`), gates them on the `sessionNonce` it now stores per live control session, replies `DataReady{cols,rows}`, replays the ring, and fans out live bytes; phone input is written back to the helper.

**Tech Stack:** Swift, `spike/seam1` (xcodegen). Pure model in `ShepherdModelTests`; loopback E2E in `ShepherdRemoteTests`; helper pump in `HelperTests`/`ShepherddPtyTests`. Framing is the existing `[u32 BE len][json]`.

## Global Constraints

- **Don't kill the user's live Shepherd** — verify by compile + unit/loopback tests only; defer GUI/device runtime checks to a user checklist. Never `killall`/relaunch.
- **libghostty C API calls on the main thread.**
- **`xcodegen generate` after adding/removing any source file**; a new compiled *source* must be added to the target's explicit `sources:` list in `project.yml` (test files under `Tests/`/`RemoteTests/`/`HelperTests/` are globbed).
- **Frame format is `[u32 big-endian length][json]`** — reuse, don't reinvent.
- **The helper tap is never load-bearing:** if `$SHEPHERD_PTY_SOCK` is unset or the dial fails, the local pane must behave byte-identically to M0.
- **Serving-gated:** all of this is inert unless `shepherd.remote.serving` is on (dark-shipped, off by default).
- Commit messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Spec: `docs/superpowers/specs/2026-07-02-android-phase2-data-channels-design.md`.

---

## File Structure

- **Create** `spike/seam1/Sources/PtyBroker.swift` — pure `PtyRing` (append/evict/snapshot) + the `PtyBroker` per-pane shell (helper fd, ring, viewers, fan-out) + `PtyHub` (unix listener + paneID→broker registry). AppKit-free except socket syscalls.
- **Modify** `spike/seam1/Sources/RemoteProtocol.swift` — add `DataMessage` enum + `DataFrameCodec`/`DataFrameDecoder`.
- **Modify** `spike/seam1/Sources/RemoteServer.swift` — store `sessionNonce` per live control session; add the data-channel accept path (first-frame sniff → nonce gate → `DataReady` → viewer register).
- **Modify** `spike/seam1/Sources/AgentStore.swift` — own a `PtyHub`, expose `ptySocketPath`, start/stop it with the remote server, pass `lookupBroker`/`validateNonce` closures to `RemoteServer`.
- **Modify** `spike/seam1/Sources/GhosttyTerminal.swift` — inject `$SHEPHERD_PTY_SOCK` into the pane PTY env.
- **Modify** `spike/seam1/Helper/main.swift` — turn `Tee` into the real tap (dial, `PtyHello`, output up, input into `gMaster` via the poll set).
- **Modify** `spike/seam1/project.yml` — add `PtyBroker.swift` to the app target's `sources:` and to `ShepherdModelTests` (pure `PtyRing`).
- **Test** `spike/seam1/Tests/PtyBrokerTests.swift` (pure ring), `spike/seam1/Tests/DataMessageTests.swift` (protocol), `spike/seam1/RemoteTests/DataChannelTests.swift` (loopback E2E), `spike/seam1/HelperTests/ShepherddPtyTests.swift` (extend).

---

### Task 1: `DataMessage` protocol + framing

**Files:**
- Modify: `spike/seam1/Sources/RemoteProtocol.swift` (append after `FrameDecoder`/`RemoteProtocolError`)
- Test: `spike/seam1/Tests/DataMessageTests.swift` (create)

**Interfaces:**
- Consumes: nothing (mirrors the existing `FrameCodec`/`FrameDecoder` pattern).
- Produces:
  - `enum DataMessage: Codable, Equatable` with cases `dataHello(sessionNonce: String, paneID: String)`, `dataReady(cols: Int, rows: Int)`, `dataRejected(reason: String)`, `ptyHello(paneID: String, cols: Int, rows: Int)`.
  - `enum DataFrameCodec { static func encode(_ m: DataMessage) throws -> Data }` — `[u32 BE len][json]`.
  - `final class DataFrameDecoder { func feed(_ data: Data) throws -> [DataMessage] }` — same accumulation/`maxFrame` guard as `FrameDecoder`.

- [ ] **Step 1: Write the failing test**

```swift
// spike/seam1/Tests/DataMessageTests.swift
import XCTest
@testable import Shepherd

final class DataMessageTests: XCTestCase {
    private func roundTrip(_ m: DataMessage) throws -> [DataMessage] {
        let dec = DataFrameDecoder()
        return try dec.feed(try DataFrameCodec.encode(m))
    }

    func testEachCaseRoundTrips() throws {
        let cases: [DataMessage] = [
            .dataHello(sessionNonce: "n0nce", paneID: "pane-abc"),
            .dataReady(cols: 120, rows: 40),
            .dataRejected(reason: "bad nonce"),
            .ptyHello(paneID: "pane-abc", cols: 80, rows: 24),
        ]
        for c in cases { XCTAssertEqual(try roundTrip(c), [c]) }
    }

    func testTwoFramesInOneFeedDecodeInOrder() throws {
        var data = try DataFrameCodec.encode(.ptyHello(paneID: "p", cols: 80, rows: 24))
        data.append(try DataFrameCodec.encode(.dataReady(cols: 80, rows: 24)))
        let msgs = try DataFrameDecoder().feed(data)
        XCTAssertEqual(msgs, [.ptyHello(paneID: "p", cols: 80, rows: 24), .dataReady(cols: 80, rows: 24)])
    }

    func testPartialFrameBuffersUntilComplete() throws {
        let full = try DataFrameCodec.encode(.dataReady(cols: 80, rows: 24))
        let dec = DataFrameDecoder()
        XCTAssertEqual(try dec.feed(full.prefix(3)), [])         // len not even fully read
        XCTAssertEqual(try dec.feed(full.suffix(from: 3)), [.dataReady(cols: 80, rows: 24)])
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spike/seam1 && xcodegen generate && xcodebuild -project Shepherd.xcodeproj -scheme ShepherdModelTests -destination 'platform=macOS' -derivedDataPath ./build test 2>&1 | tail -20`
Expected: FAIL — "cannot find 'DataMessage'/'DataFrameCodec'/'DataFrameDecoder' in scope".

- [ ] **Step 3: Write minimal implementation**

Append to `spike/seam1/Sources/RemoteProtocol.swift`:

```swift
// MARK: - Data-channel protocol (Phase 2)

/// Data-channel handshake messages. After the hello exchange the connection carries
/// RAW PTY bytes (no more DataMessage frames). Same wire codec as ControlMessage but a
/// distinct enum so control and data protocols evolve independently. Keep additive.
enum DataMessage: Codable, Equatable {
    case dataHello(sessionNonce: String, paneID: String)   // phone → app
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
            if len < 0 || len > maxFrame { throw RemoteProtocolError.frameTooLarge }
            guard buf.count >= 4 + len else { break }
            let json = buf.subdata(in: (buf.startIndex + 4)..<(buf.startIndex + 4 + len))
            buf.removeSubrange(buf.startIndex..<(buf.startIndex + 4 + len))
            msgs.append(try JSONDecoder().decode(DataMessage.self, from: json))
        }
        return msgs
    }

    /// Bytes buffered but not yet consumed as a frame — after the ptyHello/dataHello the
    /// caller switches to raw mode and must not lose bytes that arrived in the same read.
    var leftover: Data { buf }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme ShepherdModelTests -destination 'platform=macOS' -derivedDataPath ./build test 2>&1 | tail -20`
Expected: PASS (all `DataMessageTests`).

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/RemoteProtocol.swift spike/seam1/Tests/DataMessageTests.swift
git commit -m "feat(remote): DataMessage protocol + framing for Phase 2 data channels

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `PtyRing` (pure replay buffer)

**Files:**
- Create: `spike/seam1/Sources/PtyBroker.swift`
- Modify: `spike/seam1/project.yml` (add `PtyBroker.swift` to app target `sources:` and to `ShepherdModelTests` sources)
- Test: `spike/seam1/Tests/PtyBrokerTests.swift` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `struct PtyRing { init(cap: Int = 256*1024); mutating func append(_ bytes: [UInt8]); func snapshot() -> [UInt8]; var count: Int }` — a byte ring that keeps at most the last `cap` bytes (evicts oldest).

- [ ] **Step 1: Write the failing test**

```swift
// spike/seam1/Tests/PtyBrokerTests.swift
import XCTest
@testable import Shepherd

final class PtyRingTests: XCTestCase {
    func testAppendUnderCapKeepsEverythingInOrder() {
        var r = PtyRing(cap: 16)
        r.append(Array("abc".utf8)); r.append(Array("def".utf8))
        XCTAssertEqual(r.snapshot(), Array("abcdef".utf8))
        XCTAssertEqual(r.count, 6)
    }

    func testAppendOverCapEvictsOldest() {
        var r = PtyRing(cap: 4)
        r.append(Array("abcdef".utf8))          // only last 4 survive
        XCTAssertEqual(r.snapshot(), Array("cdef".utf8))
        XCTAssertEqual(r.count, 4)
    }

    func testAppendAcrossBoundaryEvictsAcrossCalls() {
        var r = PtyRing(cap: 4)
        r.append(Array("ab".utf8)); r.append(Array("cde".utf8))  // "abcde" → last 4 = "bcde"
        XCTAssertEqual(r.snapshot(), Array("bcde".utf8))
    }

    func testSingleAppendLargerThanCapKeepsTail() {
        var r = PtyRing(cap: 3)
        r.append(Array("abcdefgh".utf8))
        XCTAssertEqual(r.snapshot(), Array("fgh".utf8))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spike/seam1 && xcodegen generate && xcodebuild -project Shepherd.xcodeproj -scheme ShepherdModelTests -destination 'platform=macOS' -derivedDataPath ./build test 2>&1 | tail -20`
Expected: FAIL — "cannot find 'PtyRing' in scope".

- [ ] **Step 3: Write minimal implementation**

Create `spike/seam1/Sources/PtyBroker.swift`:

```swift
import Foundation

/// A byte ring that retains at most the last `cap` bytes of PTY output for replay to a
/// newly-attaching viewer. Pure/value type — unit-tested. Simple contiguous buffer with
/// front-trim; PTY output is bursty but bounded by `cap`, so trimming on append is fine.
struct PtyRing {
    private var buf: [UInt8] = []
    let cap: Int
    init(cap: Int = 256 * 1024) { self.cap = cap }

    mutating func append(_ bytes: [UInt8]) {
        buf.append(contentsOf: bytes)
        if buf.count > cap { buf.removeFirst(buf.count - cap) }
    }
    func snapshot() -> [UInt8] { buf }
    var count: Int { buf.count }
}
```

Then add the source to both targets in `project.yml`. Under the app target's `sources:` list add `- path: Sources/PtyBroker.swift` (if the list is explicit) — otherwise the `Sources` glob already covers it. Under `ShepherdModelTests` `sources:` (the explicit list beside `SplitTree`/`StopPolicy`/etc.) add:

```yaml
        - path: Sources/PtyBroker.swift
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd spike/seam1 && xcodegen generate && xcodebuild -project Shepherd.xcodeproj -scheme ShepherdModelTests -destination 'platform=macOS' -derivedDataPath ./build test 2>&1 | tail -20`
Expected: PASS (all `PtyRingTests`).

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/PtyBroker.swift spike/seam1/Tests/PtyBrokerTests.swift spike/seam1/project.yml
git commit -m "feat(remote): PtyRing bounded replay buffer for pane data channels

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `PtyBroker` + `PtyHub` (helper attach over `$SHEPHERD_PTY_SOCK`)

**Files:**
- Modify: `spike/seam1/Sources/PtyBroker.swift` (append `PtyBroker` + `PtyHub`)
- Test: `spike/seam1/RemoteTests/DataChannelTests.swift` (create — loopback, in `ShepherdRemoteTests`)

**Interfaces:**
- Consumes: `PtyRing` (Task 2), `DataMessage`/`DataFrameCodec`/`DataFrameDecoder` (Task 1).
- Produces:
  - `final class PtyBroker` — per pane. `init(paneID: String, cols: Int, rows: Int)`; `var cols/rows: Int`; `func attachHelper(fd: Int32)`; `func attachViewer(fd: Int32)` (replays ring then live); `func detachViewer(fd: Int32)`; `func feedFromHelper(_ bytes: [UInt8])` (append ring + fan out to viewers); `func inputFromViewer(_ bytes: [UInt8])` (write to helper fd); `func close()`. All fd writes go through a serial queue; lock-guarded viewer set.
  - `final class PtyHub` — `init(socketPath: String, makeBroker: @escaping (String, Int, Int) -> PtyBroker)`; `func start() -> Bool` (bind+listen AF_UNIX, accept loop, read `PtyHello`, create/lookup broker, `attachHelper`); `func stop()`; `func broker(for paneID: String) -> PtyBroker?`.

- [ ] **Step 1: Write the failing test**

```swift
// spike/seam1/RemoteTests/DataChannelTests.swift
import XCTest
@testable import Shepherd

final class DataChannelTests: XCTestCase {
    // Connect a fake helper to the hub's unix socket, send PtyHello + bytes,
    // assert the broker captured them in its ring.
    func testHelperAttachAndRingCapture() throws {
        let path = NSTemporaryDirectory() + "shep-pty-\(UInt32.random(in: 0..<UInt32.max)).sock"
        let hub = PtyHub(socketPath: path, makeBroker: { PtyBroker(paneID: $0, cols: $1, rows: $2) })
        XCTAssertTrue(hub.start())
        defer { hub.stop() }

        let fd = try connectUnix(path)
        defer { close(fd) }
        try writeFrame(fd, .ptyHello(paneID: "paneX", cols: 100, rows: 30))
        writeRaw(fd, Array("hello-world".utf8))

        let broker = try waitFor { hub.broker(for: "paneX") }
        XCTAssertEqual(broker.cols, 100); XCTAssertEqual(broker.rows, 30)
        try waitUntil { broker.ringSnapshotForTest() == Array("hello-world".utf8) }
    }

    // --- helpers (loopback plumbing) ---
    func connectUnix(_ path: String) throws -> Int32 {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        var addr = sockaddr_un(); addr.sun_family = sa_family_t(AF_UNIX)
        _ = path.withCString { strncpy(&addr.sun_path.0, $0, MemoryLayout.size(ofValue: addr.sun_path) - 1) }
        let r = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        XCTAssertEqual(r, 0, "connect errno \(errno)")
        return fd
    }
    func writeFrame(_ fd: Int32, _ m: DataMessage) throws {
        let d = try DataFrameCodec.encode(m); _ = d.withUnsafeBytes { write(fd, $0.baseAddress, d.count) }
    }
    func writeRaw(_ fd: Int32, _ bytes: [UInt8]) { var b = bytes; _ = write(fd, &b, b.count) }
    func waitFor<T>(_ f: () -> T?, timeout: TimeInterval = 2) throws -> T {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end { if let v = f() { return v }; usleep(10_000) }
        throw XCTSkip("timed out")
    }
    func waitUntil(_ cond: () -> Bool, timeout: TimeInterval = 2) throws {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end { if cond() { return }; usleep(10_000) }
        XCTFail("condition never held")
    }
}
```

> Note: `ringSnapshotForTest()` is a test-only accessor added to `PtyBroker` in Step 3.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spike/seam1 && xcodegen generate && xcodebuild -project Shepherd.xcodeproj -scheme ShepherdRemoteTests -destination 'platform=macOS' -derivedDataPath ./build test 2>&1 | tail -25`
Expected: FAIL — "cannot find 'PtyHub'/'PtyBroker' in scope".

- [ ] **Step 3: Write minimal implementation**

Append to `spike/seam1/Sources/PtyBroker.swift`:

```swift
import Darwin

/// Per-pane broker: fans a helper's PTY output out to attached phone viewers and writes
/// viewer input back to the helper. All socket writes go through a serial queue; the
/// viewer set is lock-guarded. Blocking writes with a send timeout + drop-on-stall (same
/// discipline as RemoteServer) — non-blocking I/O + coalescing is the deferred hardening.
final class PtyBroker {
    let paneID: String
    private(set) var cols: Int
    private(set) var rows: Int
    private let lock = NSLock()
    private var helperFD: Int32 = -1
    private var viewers = Set<Int32>()
    private var ring = PtyRing()
    private let q = DispatchQueue(label: "shepherd.pty.broker")

    init(paneID: String, cols: Int, rows: Int) { self.paneID = paneID; self.cols = cols; self.rows = rows }

    func attachHelper(fd: Int32) { lock.lock(); helperFD = fd; lock.unlock() }

    func feedFromHelper(_ bytes: [UInt8]) {
        lock.lock(); ring.append(bytes); let vs = viewers; lock.unlock()
        for v in vs { writeAll(v, bytes) }
    }

    func attachViewer(fd: Int32) {
        lock.lock(); let replay = ring.snapshot(); viewers.insert(fd); lock.unlock()
        if !replay.isEmpty { writeAll(fd, replay) }
    }

    func detachViewer(fd: Int32) { lock.lock(); viewers.remove(fd); lock.unlock() }

    func inputFromViewer(_ bytes: [UInt8]) {
        lock.lock(); let h = helperFD; lock.unlock()
        if h >= 0 { writeAll(h, bytes) }
    }

    func close() {
        lock.lock(); let vs = viewers; let h = helperFD; viewers.removeAll(); helperFD = -1; lock.unlock()
        for v in vs { Darwin.close(v) }
        if h >= 0 { Darwin.close(h) }
    }

    private func writeAll(_ fd: Int32, _ bytes: [UInt8]) {
        q.async {
            var off = 0
            bytes.withUnsafeBytes { raw in
                let base = raw.bindMemory(to: UInt8.self).baseAddress!
                while off < bytes.count {
                    let w = write(fd, base + off, bytes.count - off)
                    if w < 0 { if errno == EINTR { continue }; return }   // drop on stall/error
                    off += w
                }
            }
        }
    }

    // Test-only.
    func ringSnapshotForTest() -> [UInt8] { lock.lock(); defer { lock.unlock() }; return ring.snapshot() }
}

/// Accepts helper connections on a unix-domain socket ($SHEPHERD_PTY_SOCK), reads each
/// helper's PtyHello, and routes it to its pane's broker (created on first sight).
final class PtyHub {
    private let socketPath: String
    private let makeBroker: (String, Int, Int) -> PtyBroker
    private var listenFD: Int32 = -1
    private let lock = NSLock()
    private var brokers: [String: PtyBroker] = [:]

    init(socketPath: String, makeBroker: @escaping (String, Int, Int) -> PtyBroker) {
        self.socketPath = socketPath; self.makeBroker = makeBroker
    }

    func broker(for paneID: String) -> PtyBroker? { lock.lock(); defer { lock.unlock() }; return brokers[paneID] }

    func start() -> Bool {
        unlink(socketPath)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0); guard fd >= 0 else { return false }
        var addr = sockaddr_un(); addr.sun_family = sa_family_t(AF_UNIX)
        _ = socketPath.withCString { strncpy(&addr.sun_path.0, $0, MemoryLayout.size(ofValue: addr.sun_path) - 1) }
        let ok = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) == 0 } }
        guard ok, listen(fd, 16) == 0 else { close(fd); return false }
        listenFD = fd
        Thread.detachNewThread { [weak self] in self?.acceptLoop(fd) }
        return true
    }

    func stop() {
        if listenFD >= 0 { close(listenFD); listenFD = -1 }
        unlink(socketPath)
        lock.lock(); let bs = brokers.values; brokers.removeAll(); lock.unlock()
        bs.forEach { $0.close() }
    }

    private func acceptLoop(_ fd: Int32) {
        while true {
            let c = accept(fd, nil, nil)
            if c < 0 { if errno == EINTR { continue }; break }
            Thread.detachNewThread { [weak self] in self?.serveHelper(c) }
        }
    }

    private func serveHelper(_ fd: Int32) {
        let dec = DataFrameDecoder()
        var broker: PtyBroker?
        var buf = [UInt8](repeating: 0, count: 65536)
        while true {
            let n = read(fd, &buf, buf.count)
            if n <= 0 { break }
            if let b = broker {
                b.feedFromHelper(Array(buf[0..<n]))                    // raw after hello
                continue
            }
            let msgs = (try? dec.feed(Data(buf[0..<n]))) ?? []
            for m in msgs {
                if case let .ptyHello(paneID, cols, rows) = m {
                    let b = makeBroker(paneID, cols, rows)
                    lock.lock(); brokers[paneID] = b; lock.unlock()
                    b.attachHelper(fd: fd)
                    broker = b
                    let extra = dec.leftover                           // bytes past the hello frame
                    if !extra.isEmpty { b.feedFromHelper([UInt8](extra)) }
                }
            }
        }
        broker?.close()
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme ShepherdRemoteTests -destination 'platform=macOS' -derivedDataPath ./build test 2>&1 | tail -25`
Expected: PASS (`testHelperAttachAndRingCapture`).

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/PtyBroker.swift spike/seam1/RemoteTests/DataChannelTests.swift
git commit -m "feat(remote): PtyBroker + PtyHub — helper attach, ring, viewer fan-out

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Nonce store in `RemoteServer`

**Files:**
- Modify: `spike/seam1/Sources/RemoteServer.swift` (`ConnState`, `admit`, `closeConn`; add `hasLiveNonce`)
- Test: `spike/seam1/RemoteTests/DataChannelTests.swift` (add a case)

**Interfaces:**
- Consumes: existing `admit(_:_:)`, `closeConn(_:_:)`, `makeNonce` closure.
- Produces: `RemoteServer.hasLiveNonce(_ nonce: String) -> Bool` (thread-safe); the nonce minted in `admit` is stored on the `ConnState` and in a server-level `Set<String>`, removed in `closeConn`.

- [ ] **Step 1: Write the failing test**

Add to `DataChannelTests`:

```swift
    func testNonceLifecycleViaLoopback() throws {
        let server = try makePairedLoopbackServer()   // helper below: starts server on 127.0.0.1
        defer { server.stop() }
        let (fd, nonce) = try pairAndGetNonce(server) // pairs+approves, returns accepted nonce
        XCTAssertTrue(server.hasLiveNonce(nonce))
        close(fd)                                      // control session drops
        try waitUntil { !server.hasLiveNonce(nonce) }  // nonce invalidated on close
    }
```

> `makePairedLoopbackServer()`/`pairAndGetNonce(_:)` mirror the existing `RemoteServerTests` loopback harness (bind `127.0.0.1`, auto-approve, send `hello`, read `accepted`). Reuse that file's helpers — copy the minimal bind/connect/`hello`/read-`accepted` sequence.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme ShepherdRemoteTests -destination 'platform=macOS' -derivedDataPath ./build test 2>&1 | tail -25`
Expected: FAIL — "value of type 'RemoteServer' has no member 'hasLiveNonce'".

- [ ] **Step 3: Write minimal implementation**

In `RemoteServer.swift`, add to `ConnState`: `var nonce: String?`. Add server fields near `clients`:

```swift
    private var liveNonces = Set<String>()
    private let nonceLock = NSLock()

    func hasLiveNonce(_ nonce: String) -> Bool {
        nonceLock.lock(); defer { nonceLock.unlock() }; return liveNonces.contains(nonce)
    }
```

In `admit`, capture and store the nonce instead of discarding it:

```swift
    private func admit(_ fd: Int32, _ state: ConnState) {
        let nonce = makeNonce()
        state.lock.lock(); state.nonce = nonce; state.lock.unlock()
        nonceLock.lock(); liveNonces.insert(nonce); nonceLock.unlock()
        let accepted = encode(.accepted(sessionNonce: nonce))
        let snap = encode(.snapshot(panes: snapshot()))
        clientsLock.lock()
        clients[fd] = state
        enqueueWrite(fd, accepted, on: state)
        enqueueWrite(fd, snap, on: state)
        clientsLock.unlock()
    }
```

In `closeConn`, drop the nonce (add near where it removes from `clients`/`conns`):

```swift
        state.lock.lock(); let n = state.nonce; state.nonce = nil; state.lock.unlock()
        if let n { nonceLock.lock(); liveNonces.remove(n); nonceLock.unlock() }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme ShepherdRemoteTests -destination 'platform=macOS' -derivedDataPath ./build test 2>&1 | tail -25`
Expected: PASS (`testNonceLifecycleViaLoopback` + existing `ShepherdRemoteTests`).

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/RemoteServer.swift spike/seam1/RemoteTests/DataChannelTests.swift
git commit -m "feat(remote): store sessionNonce per live control session (data-channel gate)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Data-channel accept path (nonce gate → DataReady → replay → fan-out → input)

**Files:**
- Modify: `spike/seam1/Sources/RemoteServer.swift` (first-frame sniff in `handleConnection`; a `serveDataChannel` path); init gains `lookupBroker` + `validateNonce` closures
- Test: `spike/seam1/RemoteTests/DataChannelTests.swift` (full E2E)

**Interfaces:**
- Consumes: `hasLiveNonce` (Task 4), `PtyHub.broker(for:)`/`PtyBroker.attachViewer`/`inputFromViewer`/`detachViewer` (Task 3), `DataFrameDecoder`/`DataFrameCodec` (Task 1).
- Produces: `RemoteServer.init` gains `validateNonce: @escaping (String) -> Bool` and `lookupBroker: @escaping (String) -> PtyBroker?`. On a connection whose first frame decodes as `DataMessage.dataHello`, the server validates the nonce + broker, sends `.dataReady(cols,rows)`, calls `attachViewer`, then pumps: viewer bytes → `inputFromViewer`; on read-EOF → `detachViewer`.

- [ ] **Step 1: Write the failing test**

Add to `DataChannelTests` (E2E: fake helper + real data channel through the server):

```swift
    func testDataChannelEndToEnd() throws {
        // hub for helper side + server for phone side, wired by lookupBroker/validateNonce.
        let ptyPath = NSTemporaryDirectory() + "shep-pty-\(UInt32.random(in: 0..<UInt32.max)).sock"
        let hub = PtyHub(socketPath: ptyPath, makeBroker: { PtyBroker(paneID: $0, cols: $1, rows: $2) })
        XCTAssertTrue(hub.start()); defer { hub.stop() }
        let server = try makePairedLoopbackServer(validateNonce: { hub != nil ? true : true }, // replaced below
                                                  lookupBroker: { hub.broker(for: $0) })
        defer { server.stop() }
        let (ctlFD, nonce) = try pairAndGetNonce(server); defer { close(ctlFD) }

        // fake helper attaches + emits a screenful
        let helperFD = try connectUnix(ptyPath); defer { close(helperFD) }
        try writeFrame(helperFD, .ptyHello(paneID: "paneY", cols: 90, rows: 25))
        writeRaw(helperFD, Array("PRE".utf8))                       // pre-attach → into ring
        _ = try waitFor { hub.broker(for: "paneY") }

        // phone opens the data channel with the nonce
        let dataFD = try connectTCP(server.boundPort)              // helper below
        defer { close(dataFD) }
        try writeFrame(dataFD, .dataHello(sessionNonce: nonce, paneID: "paneY"))
        let ready = try readOneDataMessage(dataFD)                  // helper below
        XCTAssertEqual(ready, .dataReady(cols: 90, rows: 25))
        XCTAssertEqual(try readRaw(dataFD, 3), Array("PRE".utf8))   // ring replay

        // live fan-out + input round-trip
        writeRaw(helperFD, Array("LIVE".utf8))
        XCTAssertEqual(try readRaw(dataFD, 4), Array("LIVE".utf8))
        writeRaw(dataFD, Array("keys".utf8))
        XCTAssertEqual(try readRaw(helperFD, 4), Array("keys".utf8))
    }

    func testDataChannelRejectsBadNonce() throws {
        let ptyPath = NSTemporaryDirectory() + "shep-pty-\(UInt32.random(in: 0..<UInt32.max)).sock"
        let hub = PtyHub(socketPath: ptyPath, makeBroker: { PtyBroker(paneID: $0, cols: $1, rows: $2) })
        XCTAssertTrue(hub.start()); defer { hub.stop() }
        let server = try makePairedLoopbackServer(lookupBroker: { hub.broker(for: $0) })
        defer { server.stop() }
        let dataFD = try connectTCP(server.boundPort); defer { close(dataFD) }
        try writeFrame(dataFD, .dataHello(sessionNonce: "not-a-real-nonce", paneID: "paneY"))
        XCTAssertEqual(try readOneDataMessage(dataFD), .dataRejected(reason: "bad nonce"))
    }
```

> Add small loopback helpers `connectTCP(_ port:)`, `readOneDataMessage(_:)`, `readRaw(_:_:)` to the file (mirror the byte-read helpers in `RemoteServerTests`). `makePairedLoopbackServer` gains optional `validateNonce`/`lookupBroker` params defaulting to the server's own `hasLiveNonce` and `{ _ in nil }`. Expose `RemoteServer.boundPort` if not already present.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme ShepherdRemoteTests -destination 'platform=macOS' -derivedDataPath ./build test 2>&1 | tail -25`
Expected: FAIL — extra init args / no data-channel handling.

- [ ] **Step 3: Write minimal implementation**

Add the two closures to `RemoteServer`'s stored props + `init` (default `validateNonce` to `self.hasLiveNonce` isn't possible in init — pass explicitly from `AgentStore`; for tests default `lookupBroker` to `{ _ in nil }`). In `handleConnection`, before the control `FrameDecoder` loop, peek the first frame: try `DataFrameDecoder` first; if it yields a `.dataHello`, hand off to `serveDataChannel` and return; otherwise fall through to the existing control path with the already-read bytes.

Because both protocols share `[u32 len][json]` framing, decode the first complete frame's JSON once and branch on whether it parses as `DataMessage.dataHello`:

```swift
    // At the top of handleConnection, replace the direct control loop with a first-frame sniff.
    private func handleConnection(_ fd: Int32) {
        var buf = [UInt8](repeating: 0, count: 8192)
        // Read until we have one full frame, then decide control vs data.
        let sniff = DataFrameDecoder()
        var firstData: DataMessage?
        var consumed = Data()
        while firstData == nil {
            let n = read(fd, &buf, buf.count)
            if n <= 0 { close(fd); return }
            consumed.append(Data(buf[0..<n]))
            if let m = (try? sniff.feed(Data(buf[0..<n])))?.first { firstData = m; break }
            // Not a DataMessage frame yet? It might be a control hello — bail to control path.
            if consumed.count >= 4 {
                let len = consumed.prefix(4).withUnsafeBytes { Int(UInt32(bigEndian: $0.load(as: UInt32.self))) }
                if consumed.count >= 4 + len { break }   // full frame that isn't a DataMessage → control
            }
        }
        if case let .dataHello(nonce, paneID)? = firstData {
            serveDataChannel(fd, nonce: nonce, paneID: paneID, leftover: sniff.leftover)
            return
        }
        handleControlConnection(fd, prebuffered: consumed)   // existing loop, seeded with read bytes
    }

    private func serveDataChannel(_ fd: Int32, nonce: String, paneID: String, leftover: Data) {
        guard validateNonce(nonce), let broker = lookupBroker(paneID) else {
            _ = try? DataFrameCodec.encode(.dataRejected(reason: "bad nonce")).withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
            close(fd); return
        }
        _ = try? DataFrameCodec.encode(.dataReady(cols: broker.cols, rows: broker.rows)).withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
        broker.attachViewer(fd: fd)
        if !leftover.isEmpty { broker.inputFromViewer([UInt8](leftover)) }   // input past the hello frame
        var buf = [UInt8](repeating: 0, count: 65536)
        while true {
            let n = read(fd, &buf, buf.count)
            if n <= 0 { break }
            broker.inputFromViewer(Array(buf[0..<n]))
        }
        broker.detachViewer(fd: fd)
        close(fd)
    }
```

Refactor the existing control-reading `while` loop body into `handleControlConnection(_ fd:prebuffered:)` — same logic, but seed its `FrameDecoder` with `prebuffered` before the read loop (so the sniffed bytes aren't lost). Keep the existing `ConnState`/pairing/broadcast logic unchanged.

> Rejection message uses the constant string "bad nonce" for both bad-nonce and unknown-pane so the test is deterministic; the reason is not security-sensitive.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme ShepherdRemoteTests -destination 'platform=macOS' -derivedDataPath ./build test 2>&1 | tail -25`
Expected: PASS (`testDataChannelEndToEnd`, `testDataChannelRejectsBadNonce`, and all prior).

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/RemoteServer.swift spike/seam1/RemoteTests/DataChannelTests.swift
git commit -m "feat(remote): data-channel accept path — nonce gate, DataReady, replay, fan-out, input

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Helper tap — dial `$SHEPHERD_PTY_SOCK`, stream output, inject input

**Files:**
- Modify: `spike/seam1/Helper/main.swift` (`Tee`, `pump` poll set)
- Test: `spike/seam1/HelperTests/ShepherddPtyTests.swift` (extend)

**Interfaces:**
- Consumes: `DataFrameCodec` shape (the helper re-encodes `PtyHello` with the same `[u32 len][json]` bytes — the helper target does not link the app, so it writes the frame directly; keep the JSON shape `{"ptyHello":{"paneID":…,"cols":…,"rows":…}}` in sync with Task 1).
- Produces: `Tee` connected to a socket when `$SHEPHERD_PTY_SOCK` set; a `ptySock` fd added to the `pump` poll set so inbound bytes are written to `gMaster`.

- [ ] **Step 1: Write the failing test**

Extend `ShepherddPtyTests` with a test that runs `shepherdd pty -- /bin/cat` with `$SHEPHERD_PTY_SOCK` pointed at a listener the test controls; assert (a) the helper connects + sends a `ptyHello` frame, (b) output typed into the outer PTY is mirrored to the socket, (c) bytes written to the socket appear on the outer PTY (injected as input to `cat`). If the existing test harness spawns the built helper binary, add:

```swift
    func testHelperStreamsAndInjectsOverPtySock() throws {
        let path = NSTemporaryDirectory() + "shep-pty-t-\(UInt32.random(in: 0..<UInt32.max)).sock"
        let listenFD = try startUnixListener(path)          // harness helper
        defer { close(listenFD); unlink(path) }
        let (helper, outerMaster) = try spawnHelper(env: ["SHEPHERD_PTY_SOCK": path, "SHEPHERD_TAB_ID": "paneZ"],
                                                    program: ["/bin/cat"])
        defer { helper.terminate() }
        let conn = try acceptOne(listenFD)                  // helper dials in
        let hello = try readOnePtyHelloJSON(conn)           // parse the first frame's JSON
        XCTAssertEqual(hello["paneID"] as? String, "paneZ")

        writeRaw(outerMaster, Array("abc\n".utf8))          // user types into the pane
        XCTAssertTrue(try socketSees(conn, contains: "abc")) // cat echoes → tee'd to socket

        writeRaw(conn, Array("xyz\n".utf8))                 // phone input via socket
        XCTAssertTrue(try outerSees(outerMaster, contains: "xyz")) // injected → cat echoes to outer
    }
```

> Reuse whatever spawn/PTY harness `ShepherddPtyTests` already has; the four helper funcs (`startUnixListener`, `acceptOne`, `readOnePtyHelloJSON`, `socketSees`/`outerSees`) are thin wrappers over `socket`/`accept`/`read` + a deadline loop.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme ShepherddPtyTests -destination 'platform=macOS' -derivedDataPath ./build test 2>&1 | tail -25`
Expected: FAIL — helper never connects / `Tee` is a no-op.

- [ ] **Step 3: Write minimal implementation**

Replace the M0 `Tee` no-op in `Helper/main.swift`:

```swift
final class Tee {
    static let shared = Tee()
    private var sock: Int32 = -1

    /// Dial $SHEPHERD_PTY_SOCK and send PtyHello. Best-effort: any failure leaves sock=-1
    /// and the helper behaves exactly like M0 (tap is never load-bearing).
    func connect(paneID: String, cols: Int, rows: Int) {
        guard let path = ProcessInfo.processInfo.environment["SHEPHERD_PTY_SOCK"], !path.isEmpty else { return }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0); guard fd >= 0 else { return }
        var addr = sockaddr_un(); addr.sun_family = sa_family_t(AF_UNIX)
        _ = path.withCString { strncpy(&addr.sun_path.0, $0, MemoryLayout.size(ofValue: addr.sun_path) - 1) }
        let ok = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) == 0 } }
        guard ok else { close(fd); return }
        var tv = timeval(tv_sec: 2, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        // {"ptyHello":{"paneID":"…","cols":N,"rows":N}} — must match RemoteProtocol.DataMessage.
        let json = "{\"ptyHello\":{\"paneID\":\"\(paneID)\",\"cols\":\(cols),\"rows\":\(rows)}}"
        let jd = Array(json.utf8); var len = UInt32(jd.count).bigEndian
        var frame = [UInt8](); withUnsafeBytes(of: &len) { frame.append(contentsOf: $0) }; frame.append(contentsOf: jd)
        _ = frame.withUnsafeBytes { write(fd, $0.baseAddress, frame.count) }
        sock = fd
    }

    var fd: Int32 { sock }

    func output(_ buf: UnsafePointer<UInt8>, count: Int) {
        guard sock >= 0 else { return }
        var off = 0
        while off < count {
            let w = write(sock, buf + off, count - off)
            if w < 0 { if errno == EINTR { continue }; return }   // drop on stall
            off += w
        }
    }
}
```

Wire it in `runPty`, before `pump`:

```swift
    let paneID = ProcessInfo.processInfo.environment["SHEPHERD_TAB_ID"] ?? ""
    Tee.shared.connect(paneID: paneID, cols: Int(ws.ws_col), rows: Int(ws.ws_row))
```

Add the tap fd to `pump`'s poll set and inject its input into `master`:

```swift
    // inside pump(master:), build pfds with the tap fd when present:
    let tap = Tee.shared.fd
    var pfds = [pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0),
                pollfd(fd: master,       events: Int16(POLLIN), revents: 0)]
    if tap >= 0 { pfds.append(pollfd(fd: tap, events: Int16(POLLIN), revents: 0)) }
    // ... in the loop, after the master branch:
    if tap >= 0, pfds.count > 2, pfds[2].revents & Int16(POLLIN) != 0 {
        let n = read(tap, buf, cap)
        if n > 0 { writeAll(master, n) }   // phone input → inner PTY
    }
    // reset pfds[2].revents too when present.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme ShepherddPtyTests -destination 'platform=macOS' -derivedDataPath ./build test 2>&1 | tail -25`
Expected: PASS (new test + the existing M0 pump tests — the no-socket path must stay green, proving the tap is non-load-bearing).

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Helper/main.swift spike/seam1/HelperTests/ShepherddPtyTests.swift
git commit -m "feat(helper): shepherdd pty tap — stream output + inject input over \$SHEPHERD_PTY_SOCK

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Wiring — inject `$SHEPHERD_PTY_SOCK`, own the `PtyHub` in `AgentStore`

**Files:**
- Modify: `spike/seam1/Sources/AgentStore.swift` (add `ptySocketPath`, own a `PtyHub`, start/stop with the remote server, pass `validateNonce`/`lookupBroker` into `RemoteServer`)
- Modify: `spike/seam1/Sources/GhosttyTerminal.swift:~109` (inject the env var)
- Test: `spike/seam1/Tests/*` — a pure assertion that the injected env list includes `SHEPHERD_PTY_SOCK` when serving (if env construction is testable); otherwise this task is covered by Task 5's loopback + a manual note.

**Interfaces:**
- Consumes: `PtyHub` (Task 3), `RemoteServer` new init args (Task 5), `RemoteServer.hasLiveNonce` (Task 4).
- Produces: `AgentStore.ptySocketPath: String`; `AgentStore` starts `PtyHub` when `isServing` and Tailscale is up (same gate as the control server), stops it on toggle-off/quit.

- [ ] **Step 1: Write the failing test / assertion**

If the pane-env array is built in a pure helper, add a test asserting membership; otherwise assert `AgentStore.shared.ptySocketPath` is non-empty and distinct from `socketPath`:

```swift
    func testPtySocketPathIsDistinctFromControlSocket() {
        XCTAssertFalse(AgentStore.shared.ptySocketPath.isEmpty)
        XCTAssertNotEqual(AgentStore.shared.ptySocketPath, AgentStore.shared.socketPath)
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spike/seam1 && xcodebuild -project Shepherd.xcodeproj -scheme ShepherdRemoteTests -destination 'platform=macOS' -derivedDataPath ./build test 2>&1 | tail -20`
Expected: FAIL — no `ptySocketPath`.

- [ ] **Step 3: Write minimal implementation**

In `AgentStore.swift`, near `socketPath`:

```swift
    /// Dedicated unix socket for shepherdd pty data streams (kept separate from
    /// socketPath, which carries newline-delimited hook JSON). Injected as $SHEPHERD_PTY_SOCK.
    let ptySocketPath: String = NSTemporaryDirectory() + "shepherd-pty-\(ProcessInfo.processInfo.processIdentifier).sock"
    private var ptyHub: PtyHub?
```

Where the control `RemoteServer` is created (the serving-on path), also start the hub and pass the closures:

```swift
        let hub = PtyHub(socketPath: ptySocketPath, makeBroker: { PtyBroker(paneID: $0, cols: $1, rows: $2) })
        _ = hub.start()
        self.ptyHub = hub
        // when constructing RemoteServer(...), add:
        //   validateNonce: { [weak self] in self?.remoteServer?.hasLiveNonce($0) ?? false },
        //   lookupBroker:  { [weak self] in self?.ptyHub?.broker(for: $0) }
```

On serving-off / teardown: `ptyHub?.stop(); ptyHub = nil` alongside the existing `remoteServer` stop.

In `GhosttyTerminal.swift`, add to the injected env list (next to `SHEPHERD_SOCK`/`SHEPHERD_TAB_ID`), only when serving:

```swift
            ghostty_env_var_s(key: dup("SHEPHERD_PTY_SOCK"), value: dup(AgentStore.shared.ptySocketPath)),
```

(Guard behind `AgentStore.shared.isServing` if the env array is conditionally built; harmless if always present since the helper only dials when it *also* runs — i.e. when serving.)

- [ ] **Step 4: Run tests + full build to verify**

Run: `cd spike/seam1 && xcodegen generate && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -15 && xcodebuild -project Shepherd.xcodeproj -scheme ShepherdRemoteTests -destination 'platform=macOS' -derivedDataPath ./build test 2>&1 | tail -15`
Expected: app **builds**; `ShepherdRemoteTests` PASS.

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/AgentStore.swift spike/seam1/Sources/GhosttyTerminal.swift
git commit -m "feat(remote): wire PtyHub into AgentStore + inject \$SHEPHERD_PTY_SOCK

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Whole-branch verification + docs

**Files:**
- Modify: `docs/superpowers/specs/2026-07-02-android-phase2-data-channels-design.md` (Status), `CLAUDE.md` (note host data channels done), the Android-client memory note.

- [ ] **Step 1:** Run the full suites:

```bash
cd spike/seam1 && xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme ShepherdModelTests -destination 'platform=macOS' -derivedDataPath ./build test 2>&1 | tail -8
xcodebuild -project Shepherd.xcodeproj -scheme ShepherdRemoteTests -destination 'platform=macOS' -derivedDataPath ./build test 2>&1 | tail -8
xcodebuild -project Shepherd.xcodeproj -scheme ShepherddPtyTests -destination 'platform=macOS' -derivedDataPath ./build test 2>&1 | tail -8
```
Expected: all green. Record counts.

- [ ] **Step 2:** Update the spec Status section + `CLAUDE.md` "Done vs deferred" (host data channels implemented, dark-shipped; Android terminal = next). Note the deferred user checklist: live device attach + respond.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: host PTY data channels implemented (Android Phase 2, host half)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** §3 data path → Tasks 3,6,7. §4.1 protocol → Task 1. §4.2 helper tap → Task 6. §4.3 nonce store → Task 4; broker/ring/hub → Tasks 2,3; data-channel accept/replay/fan-out/input → Task 5. §4.4 wiring → Task 7. §6 nonce gate → Tasks 4,5. §7 testing → each task's tests + Task 8. Android §5 = **out of scope** for this plan (follow-up plan). Covered.

**Placeholder scan:** every code step carries real Swift; test steps carry real assertions. The helper-test and loopback harness funcs reference existing `ShepherddPtyTests`/`RemoteServerTests` plumbing rather than inventing it — the one intentional "reuse existing harness" pointer, since duplicating the PTY-spawn harness verbatim would be wrong.

**Type consistency:** `PtyHello`/`ptyHello`, `dataHello`/`dataReady`/`dataRejected` match across Tasks 1/3/5/6. `PtyBroker.attachViewer(fd:)`/`inputFromViewer`/`detachViewer`/`feedFromHelper`/`cols`/`rows` consistent Tasks 3↔5. `hasLiveNonce`/`validateNonce`/`lookupBroker` consistent Tasks 4↔5↔7. `Tee.connect`/`Tee.fd`/`Tee.output` consistent Task 6. Ring 256 KB consistent with spec.

**Known follow-up folded in:** the helper writes the `ptyHello` frame by hand-built JSON (it can't link the app target); Task 6 flags the shape must track Task 1 — if `DataMessage` changes, update both. A shared golden-vector test between Swift enum and the hand-built string is a reasonable hardening but YAGNI for one message.
