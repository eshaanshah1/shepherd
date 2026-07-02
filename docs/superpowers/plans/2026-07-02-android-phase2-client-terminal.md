# Android Phase 2 sub-project B — terminal client + full resize (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the phone tap into an existing host pane, read its live PTY screen, and send input (answer an `AskUserQuestion`/permission/plan menu, submit a prompt) — with Claude's PTY resized to the phone while the phone is the active driver, snapped back to the desktop size on detach/refocus.

**Architecture:** The shipped host already streams each serving pane's PTY into a per-pane `PtyBroker` (256 KB ring + viewer fan-out) and admits nonce-gated data channels. This slice adds: (host) initial size in `DataHello`, a `ControlMessage.resize` for live changes, an `AgentStore` active-driver arbiter with snap-back, and minimal typed framing on the **app→helper** link so the app can push a set-size to the helper (the sole owner of Claude's inner PTY `gMaster`); (Android) a `DataMessage` codec, a raw-duplex `DataChannel`, a Termux-emulator-backed `RemoteTerminalSession`, and an Agent screen reached from the Fleet list / a notification.

**Tech Stack:** Swift (AppKit app + `shepherdd` helper executable, xcodegen, `ShepherdModelTests`/`ShepherdRemoteTests`/`ShepherdHelperTests`), Kotlin/Android (Compose, kotlinx-serialization/coroutines, JUnit), Termux `terminal-emulator` + `terminal-view` via JitPack.

## Global Constraints

- **Wire codec:** `[u32 big-endian length][json]` for all handshake frames (control + data), matching shipped `FrameCodec`/`DataFrameCodec`/Kotlin `WireCodec`. Swift enum Codable shape = single-key object keyed by case name, associated values as labeled object fields; nil fields omitted (Kotlin must match — see `WireCodec`).
- **App→helper frame (new):** `[u32 big-endian length][1-byte type][payload]`, `type 0x00` = input (payload = raw PTY bytes), `type 0x01` = resize (payload = `[u16 BE cols][u16 BE rows]`). helper→app stays **raw** (unchanged); the replay ring stays raw (unchanged).
- **Raw after handshake:** phone↔app data channel is raw duplex after `DataReady`; resize never travels on it (control channel only).
- **Non-load-bearing helper:** no `$SHEPHERD_PTY_SOCK` / dead socket ⇒ local pane byte-identical to M0. Never let a remote path block the local pump.
- **libghostty C API + all `ghostty_*` and PTY ioctls on the main thread** (host app). Helper resize (`sh_set_winsize(gMaster)`) runs on the helper's poll thread.
- **Don't kill live Shepherd:** verify by compile + unit/loopback tests only; the on-device adb pass is a user-run checklist at the end. Never `killall`/relaunch the running app.
- **Termux dep:** `com.termux:terminal-view:<pinned>` via `maven { url "https://jitpack.io" }`, `terminal-emulator` transitive; Apache-2.0 NOTICE. Fallback = vendor the two module sources (Task A0 decides).
- **Kotlin package root:** `com.eshaan.shepherd`. Android min/target/compile SDK 31/35/35, JVM 17.
- **Commit messages** end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

# Part 1 — Host (Swift app + `shepherdd` helper)

Files in `spike/seam1/`. Run tests from `spike/seam1`:
```
xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  build test 2>&1 | tail -40
```
(`ShepherdModelTests`, `ShepherdRemoteTests`, `ShepherdHelperTests` are all schemes' test targets.)

### Task H1: Protocol — `DataHello` gains size; add `ControlMessage.resize`; add app→helper frame codec

**Files:**
- Modify: `Sources/RemoteProtocol.swift` (the `DataMessage` enum ~line 124; the `ControlMessage` enum ~line 21; add a new `HelperFrameCodec` section near the data-channel section ~line 158)
- Test: `Tests/RemoteProtocolTests.swift` (exists in `ShepherdModelTests`; add cases) — if absent, add file and to `project.yml` `ShepherdModelTests.sources`.

**Interfaces:**
- Produces:
  - `DataMessage.dataHello(sessionNonce: String, paneID: String, cols: Int, rows: Int)` (was 2 args)
  - `ControlMessage.resize(paneID: String, cols: Int, rows: Int)`
  - `enum HelperFrame { case input([UInt8]); case resize(cols: Int, rows: Int) }`
  - `enum HelperFrameCodec { static func encode(_ f: HelperFrame) -> Data }`
  - `final class HelperFrameDecoder { func feed(_ d: Data) -> [HelperFrame] }`

- [ ] **Step 1: Write failing tests** in `Tests/RemoteProtocolTests.swift`:

```swift
func testDataHelloCarriesSize() throws {
    let m = DataMessage.dataHello(sessionNonce: "n1", paneID: "p1", cols: 40, rows: 30)
    let enc = try DataFrameCodec.encode(m)
    let dec = DataFrameDecoder()
    XCTAssertEqual(try dec.feed(enc), [m])
    // wire shape
    let json = String(data: enc.suffix(from: enc.startIndex + 4), encoding: .utf8)!
    XCTAssertTrue(json.contains("\"dataHello\""))
    XCTAssertTrue(json.contains("\"cols\":40")); XCTAssertTrue(json.contains("\"rows\":30"))
}

func testControlResizeRoundTrips() throws {
    let m = ControlMessage.resize(paneID: "p1", cols: 41, rows: 22)
    XCTAssertEqual(try FrameDecoder().feed(try FrameCodec.encode(m)), [m])
}

func testHelperFrameInputRoundTrips() {
    let f = HelperFrame.input([0x1b, 0x5b, 0x41])   // ESC [ A
    let out = HelperFrameCodec.encode(f)
    // [u32 len=4][type 0x00][3 payload bytes]
    XCTAssertEqual(Array(out.prefix(4)), [0,0,0,4])
    XCTAssertEqual(out[out.startIndex + 4], 0x00)
    XCTAssertEqual(HelperFrameDecoder().feed(out), [f])
}

func testHelperFrameResizeEncodesColsRows() {
    let out = HelperFrameCodec.encode(.resize(cols: 40, rows: 30))
    XCTAssertEqual(Array(out.prefix(4)), [0,0,0,5])            // 1 type + 4 payload
    XCTAssertEqual(out[out.startIndex + 4], 0x01)
    XCTAssertEqual(HelperFrameDecoder().feed(out), [.resize(cols: 40, rows: 30)])
}

func testHelperFrameDecoderReassemblesSplitFrames() {
    let a = HelperFrameCodec.encode(.input([0x61]))
    let b = HelperFrameCodec.encode(.resize(cols: 10, rows: 5))
    let dec = HelperFrameDecoder()
    XCTAssertEqual(dec.feed(a.prefix(3)), [])
    XCTAssertEqual(dec.feed(a.suffix(from: a.startIndex + 3) + b.prefix(2)), [.input([0x61])])
    XCTAssertEqual(dec.feed(b.suffix(from: b.startIndex + 2)), [.resize(cols: 10, rows: 5)])
}
```

- [ ] **Step 2: Run — expect FAIL** (`dataHello` arity, no `resize`, no `HelperFrame*`):

```
xcodebuild ... -scheme ShepherdModelTests build test 2>&1 | grep -E "error:|Test Case|failed"
```
Expected: compile errors / missing symbols.

- [ ] **Step 3: Implement.** In `RemoteProtocol.swift`, change the `DataMessage` case and add `ControlMessage.resize`:

```swift
// in ControlMessage enum, add after .paneRenamed:
case resize(paneID: String, cols: Int, rows: Int)
// in DataMessage enum, replace the dataHello case:
case dataHello(sessionNonce: String, paneID: String, cols: Int, rows: Int)   // phone → app
```

Append the app→helper frame codec after `DataFrameDecoder` (~line 158):

```swift
// MARK: - App→helper frame (Phase 2 resize)
// [u32 BE len][1-byte type][payload]. type 0x00 = input (raw bytes); 0x01 = resize [u16 BE cols][u16 BE rows].
// helper→app output stays raw; only this low-volume direction is framed.
enum HelperFrame: Equatable { case input([UInt8]); case resize(cols: Int, rows: Int) }

enum HelperFrameCodec {
    static func encode(_ f: HelperFrame) -> Data {
        var body: [UInt8]
        switch f {
        case .input(let b): body = [0x00] + b
        case .resize(let c, let r):
            body = [0x01, UInt8((c >> 8) & 0xff), UInt8(c & 0xff), UInt8((r >> 8) & 0xff), UInt8(r & 0xff)]
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
            default: break
            }
        }
        return out
    }
}
```

> Note: `.input([])` with empty payload encodes len=1 (`[0x00]`); decoder yields `.input([])`. `body[1...]` on a 1-length array is the empty slice — safe.

- [ ] **Step 4: Run — expect PASS** (also fix the two shipped call sites that break from the `dataHello` arity change; Step 5 & Task H4/H5 cover them, but the model target compiles now).

- [ ] **Step 5: Fix the `dataHello` decode site in `RemoteServer.swift`** (line ~219) to the new arity (kept minimal here; full arbiter wiring is H5):

```swift
if case let .dataHello(nonce, paneID, cols, rows)? = try? JSONDecoder().decode(DataMessage.self, from: json) {
    serveDataChannel(fd, nonce: nonce, paneID: paneID, cols: cols, rows: rows)   // signature updated in H5
    return
}
```
(If H5 isn't done yet, temporarily match `serveDataChannel(fd, nonce:paneID:)` and ignore cols/rows so the app target compiles; H5 replaces it.)

- [ ] **Step 6: Commit** `feat(remote): protocol — sized DataHello, ControlMessage.resize, app→helper HelperFrame codec`.

---

### Task H2: Helper — decode app→helper frames (input + resize)

**Files:**
- Modify: `Helper/main.swift` (the app→helper reader in the `poll` loop ~lines 137–174; the winsize section ~line 68; `gMaster` ~line 70)
- Test: `HelperTests/ShepherddPtyTests.swift`

The helper does **not** link `RemoteProtocol.swift` (it hand-rolls `ptyHello` JSON — see line 35). So it hand-rolls a matching `HelperFrame` decode. Keep it byte-identical to `HelperFrameCodec`.

**Interfaces:**
- Consumes: the app writes `HelperFrame` bytes to the helper (Task H4).
- Produces: `func decodeHelperFrames(_ buf: inout [UInt8]) -> [(isResize: Bool, bytes: [UInt8], cols: Int, rows: Int)]` (test seam), plus applying resize via `sh_set_winsize(gMaster, ...)`.

- [ ] **Step 1: Write failing test** in `ShepherddPtyTests.swift`:

```swift
func testHelperDecodesInputAndResizeFrames() {
    // input "hi"
    var buf: [UInt8] = [0,0,0,3, 0x00, 0x68, 0x69,
                        // resize 40x30
                        0,0,0,5, 0x01, 0,40, 0,30]
    let frames = decodeHelperFrames(&buf)
    XCTAssertEqual(frames.count, 2)
    XCTAssertFalse(frames[0].isResize); XCTAssertEqual(frames[0].bytes, [0x68,0x69])
    XCTAssertTrue(frames[1].isResize); XCTAssertEqual(frames[1].cols, 40); XCTAssertEqual(frames[1].rows, 30)
    XCTAssertTrue(buf.isEmpty)   // fully consumed
}
```

- [ ] **Step 2: Run — expect FAIL** (`decodeHelperFrames` undefined).

- [ ] **Step 3: Implement in `main.swift`.** Add the pure decoder (file-scope) and route it into the poll loop. Add a resize applier:

```swift
// Byte-identical to Sources/RemoteProtocol.swift HelperFrameCodec.
func decodeHelperFrames(_ buf: inout [UInt8]) -> [(isResize: Bool, bytes: [UInt8], cols: Int, rows: Int)] {
    var out = [(Bool, [UInt8], Int, Int)]()
    while buf.count >= 4 {
        let len = (Int(buf[0]) << 24) | (Int(buf[1]) << 16) | (Int(buf[2]) << 8) | Int(buf[3])
        if len <= 0 || buf.count < 4 + len { break }
        let body = Array(buf[4..<4+len]); buf.removeFirst(4 + len)
        switch body[0] {
        case 0x00: out.append((false, Array(body[1...]), 0, 0))
        case 0x01 where body.count == 5:
            out.append((true, [], (Int(body[1]) << 8) | Int(body[2]), (Int(body[3]) << 8) | Int(body[4])))
        default: break
        }
    }
    return out.map { (isResize: $0.0, bytes: $0.1, cols: $0.2, rows: $0.3) }
}

func applyResize(cols: Int, rows: Int) {
    var ws = winsize(ws_row: UInt16(rows), ws_col: UInt16(cols), ws_xpixel: 0, ws_ypixel: 0)
    _ = sh_set_winsize(gMaster, &ws)
}
```

Where the poll loop reads the **app→helper socket** (the fd that currently writes raw bytes to `gMaster` — the socket read branch that injects input), replace the raw `writeAll(gMaster, …)` with frame decoding accumulated in a persistent `var appInBuf = [UInt8]()`:

```swift
// on bytes read from the pty-socket (n > 0):
appInBuf.append(contentsOf: UnsafeBufferPointer(start: buf, count: n))
for f in decodeHelperFrames(&appInBuf) {
    if f.isResize { applyResize(cols: f.cols, rows: f.rows) }
    else { f.bytes.withUnsafeBufferPointer { _ = writeAllFD(gMaster, $0.baseAddress!, $0.count) } }
}
```
(Match the exact helper var names for the input branch; `writeAllFD` = the helper's existing raw-write helper — reuse whatever name it uses for `writeAll(fd, ptr, count)`.)

- [ ] **Step 4: Run — expect PASS.** Also run the M0-parity test that asserts a dead/absent socket leaves the pump byte-identical (unchanged; the new decode only runs on the socket branch which is inert without a socket).

- [ ] **Step 5: Commit** `feat(helper): decode app→helper input/resize frames, apply winsize to gMaster`.

---

### Task H3: `PtyBroker` — frame input to the helper; expose resize + current size

**Files:**
- Modify: `Sources/PtyBroker.swift`
- Test: `Tests/PtyBrokerTests.swift` (or wherever `PtyRing`/broker are tested in `ShepherdModelTests`) + the loopback in `ShepherdRemoteTests`.

**Interfaces:**
- Consumes: `HelperFrameCodec` (H1).
- Produces (on `PtyBroker`): `func setSize(cols: Int, rows: Int)` (updates `cols`/`rows` + sends a resize frame to the helper), and `inputFromViewer` now wraps bytes in an input frame. Reads: `cols`/`rows` (already present).

- [ ] **Step 1: Write failing test.** A fake helper fd (socketpair): assert `inputFromViewer([0x61])` arrives as `HelperFrameCodec.encode(.input([0x61]))`, and `setSize(40,30)` arrives as `.resize(40,30)` and updates `broker.cols/rows`. (Use the same socketpair pattern as the existing broker/loopback tests.)

```swift
func testBrokerFramesInputAndResizeToHelper() throws {
    var fds = [Int32](repeating: 0, count: 2); socketpair(AF_UNIX, SOCK_STREAM, 0, &fds)
    let b = PtyBroker(paneID: "p1", cols: 80, rows: 24)
    b.attachHelper(fd: fds[0])
    b.inputFromViewer([0x61])
    b.setSize(cols: 40, rows: 30)
    let got = readAvailable(fds[1], count: 64)          // test helper
    XCTAssertEqual(got, Array(HelperFrameCodec.encode(.input([0x61]))) + Array(HelperFrameCodec.encode(.resize(cols: 40, rows: 30))))
    XCTAssertEqual(b.cols, 40); XCTAssertEqual(b.rows, 30)
}
```

- [ ] **Step 2: Run — expect FAIL** (`setSize` missing; input still raw).

- [ ] **Step 3: Implement** in `PtyBroker.swift`:

```swift
func inputFromViewer(_ bytes: [UInt8]) {
    lock.lock(); let h = helperFD; lock.unlock()
    if h >= 0 { writeAll(h, Array(HelperFrameCodec.encode(.input(bytes)))) }
}

func setSize(cols: Int, rows: Int) {
    lock.lock(); self.cols = cols; self.rows = rows; let h = helperFD; lock.unlock()
    if h >= 0 { writeAll(h, Array(HelperFrameCodec.encode(.resize(cols: cols, rows: rows)))) }
}
```
`cols`/`rows` are already `private(set) var` — keep. (`writeAll` already exists and is fd-serial.)

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit** `feat(remote): PtyBroker frames viewer input; setSize pushes winsize to helper`.

---

### Task H4: `RemoteServer.serveDataChannel` — apply attach size; snap-back on detach

**Files:**
- Modify: `Sources/RemoteServer.swift` (`serveDataChannel` ~307; add an `onSizeOwnershipChange` hook + a resize entry point)
- Test: `ShepherdRemoteTests` loopback (extend the existing data-channel E2E)

**Interfaces:**
- Consumes: `PtyBroker.setSize` (H3); an injected arbiter `sizeArbiter: (String) -> Bool` = "does the phone currently own the size for this paneID" (defaults `{ _ in true }` for tests/dark-ship; wired to `AgentStore` in H5).
- Produces: `func applyResize(paneID: String, cols: Int, rows: Int)` (called by the control-message path in H5) and snap-back on the data-channel read-loop exit.

- [ ] **Step 1: Write/extend failing loopback test** in `ShepherdRemoteTests`: pair→approve→nonce; fake helper attaches (`ptyHello p1 80x24`); open a data channel with `dataHello(nonce, "p1", cols: 40, rows: 30)`; assert the fake helper receives `HelperFrame.resize(40,30)` (phone owns, arbiter true) **and** `DataReady` echoes `{cols:40,rows:30}`; then close the data channel and assert the fake helper receives a snap-back `HelperFrame.resize(80,24)`.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.** Add stored `private let sizeArbiter: (String) -> Bool` + a `desktopSize` lookup `private let desktopSize: (String) -> (Int, Int)?` injected via `init` (defaults: arbiter `{ _ in true }`, desktopSize `{ _ in nil }`). Update `serveDataChannel` signature to `(_ fd, nonce, paneID, cols, rows)`:

```swift
// after DataReady is computed but BEFORE streaming: apply the phone's attach size if it owns it.
if sizeArbiter(paneID) { broker.setSize(cols: cols, rows: rows) }
let ready = DataMessage.dataReady(cols: broker.cols, rows: broker.rows)
_ = rawWrite(fd, (try? DataFrameCodec.encode(ready)) ?? Data())
// ... attach viewer, pump input (unchanged) ...
// on read-loop EXIT (after detachViewer), snap back to desktop size if we know it:
if let (dc, dr) = desktopSize(paneID) { broker.setSize(cols: dc, rows: dr) }
```
Add the public entry the control path uses:
```swift
func applyResize(paneID: String, cols: Int, rows: Int) {
    guard sizeArbiter(paneID), let b = lookupBroker(paneID) else { return }
    b.setSize(cols: cols, rows: rows)
}
```

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit** `feat(remote): data channel applies attach size; snap-back to desktop size on detach`.

---

### Task H5: Control-message `resize`; wire the `AgentStore` arbiter + desktop refocus snap-back

**Files:**
- Modify: `Sources/RemoteServer.swift` (`handleControlConnection` dispatch ~232–301 — add the `.resize` case), `Sources/AgentStore.swift` (arbiter closures passed into `RemoteServer.init`; call `applyResize`/snap-back on focus changes)
- Test: `ShepherdRemoteTests` (control-channel resize reaches the fake helper only when arbiter true) + a pure `AgentStore` arbiter unit if extractable; otherwise cover the arbiter logic as a pure free function in `Workspace.swift`-style helper with a `ShepherdModelTests` test.

**Interfaces:**
- Consumes: `RemoteServer.applyResize` (H4), `PtyHub`/`lookupBroker` (shipped).
- Produces: arbiter `phoneOwnsSize(paneID)` = "the pane's desktop surface is NOT the focused pane of the selected tab in the selected workspace" (desktop wins ties); `desktopSizeFor(paneID)` = the pane's last known desktop `cols×rows`.

- [ ] **Step 1: Write failing test** — pure arbiter helper in a model file:

```swift
func testPhoneOwnsSizeOnlyWhenDesktopPaneUnfocused() {
    // focusedPaneID = "p1" ⇒ p1 desktop-owned (phone does NOT own); p2 phone-owned.
    XCTAssertFalse(phoneOwnsSize(paneID: "p1", focusedPaneID: "p1", selectedTabHasPane: true))
    XCTAssertTrue(phoneOwnsSize(paneID: "p2", focusedPaneID: "p1", selectedTabHasPane: true))
    // pane not in the selected/visible tab ⇒ phone owns
    XCTAssertTrue(phoneOwnsSize(paneID: "p3", focusedPaneID: "p1", selectedTabHasPane: false))
}
```
Add `func phoneOwnsSize(paneID: String, focusedPaneID: String?, selectedTabHasPane: Bool) -> Bool { !(selectedTabHasPane && focusedPaneID == paneID) }` in a model file (e.g. append to `Workspace.swift`, covered by `ShepherdModelTests`).

- [ ] **Step 2: Run — expect FAIL** then implement the helper (Step 1's one-liner) → PASS.

- [ ] **Step 3: Wire into `RemoteServer` dispatch.** In `handleControlConnection`'s `switch`, add:
```swift
case let .resize(paneID, cols, rows) where phase == .paired:
    applyResize(paneID: paneID, cols: cols, rows: rows)
```

- [ ] **Step 4: Wire the arbiter + desktop size + refocus snap-back in `AgentStore`.** When constructing `RemoteServer`, pass:
```swift
sizeArbiter: { [weak self] paneID in
    guard let self else { return true }
    return phoneOwnsSize(paneID: paneID,
        focusedPaneID: self.selectedTab?.focusedPaneID,
        selectedTabHasPane: self.selectedTab?.contains(paneID) ?? false)
},
desktopSize: { [weak self] paneID in self?.desktopWinsize(for: paneID) }
```
Add `AgentStore.desktopWinsize(for:)` returning the pane's current desktop grid (from the pane's `GhosttySurfaceView` last-known `cols×rows`; store it on the `Pane` when the surface reports size, or read the surface's `ghostty_surface_size`). On the focus mutation (`focusPane`/`select`), after updating `focusedPaneID`, if a pane that WAS phone-owned just became focused, push its desktop size to its broker:
```swift
if let ws = desktopWinsize(for: newlyFocusedPaneID) {
    remoteServer?.applyResizeForcingDesktop(paneID: newlyFocusedPaneID, cols: ws.0, rows: ws.1)
}
```
Add `RemoteServer.applyResizeForcingDesktop(paneID:cols:rows:)` = `lookupBroker(paneID)?.setSize(...)` **bypassing the arbiter** (refocus is authoritative). All `ghostty_*`/ioctl reads on the main thread.

- [ ] **Step 5: Run all host tests — expect PASS.** `xcodebuild ... build test`. Model 88+/88+, Remote 13+/13+, Helper 11+/11+.

- [ ] **Step 6: Commit** `feat(remote): ControlMessage.resize + AgentStore active-driver arbiter with refocus snap-back`.

---

# Part 2 — Android client (`android/`)

Build/test from `android/`:
```
JAVA_HOME=$(/usr/libexec/java_home -v 17 2>/dev/null || echo "$JAVA_HOME") ./gradlew :app:testDebugUnitTest
```
(If no JDK 17 on the CLI, use Android Studio's bundled JDK: `JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"`.)

### Task A0: Termux dependency — verify JitPack resolution (fallback: vendor source)

**Files:**
- Modify: `android/settings.gradle.kts` (add jitpack repo), `android/app/build.gradle.kts` (add dep), `android/NOTICE` (create — Apache-2.0 attribution)

- [ ] **Step 1:** Add JitPack to `settings.gradle.kts` `dependencyResolutionManagement.repositories`:
```kotlin
repositories { google(); mavenCentral(); maven { url = uri("https://jitpack.io") } }
```

- [ ] **Step 2:** Add to `app/build.gradle.kts` dependencies (pin to the latest stable tag confirmed resolvable — try `0.118.0` first):
```kotlin
implementation("com.termux:terminal-view:0.118.0")   // pulls terminal-emulator transitively
```

- [ ] **Step 3: Verify resolution:**
```
./gradlew :app:dependencies --configuration debugRuntimeClasspath 2>&1 | grep -i "com.termux"
```
Expected: `com.termux:terminal-view` and `com.termux:terminal-emulator` both resolve.

- [ ] **Step 4 (fallback, only if Step 3 fails):** Vendor source instead — clone `github.com/termux/termux-app` at tag `v0.118.3`, copy its `terminal-emulator/` and `terminal-view/` gradle modules into `android/`, add `include(":terminal-emulator", ":terminal-view")` to `settings.gradle.kts`, and `implementation(project(":terminal-view"))`. Record the SHA in `NOTICE`. Log this deviation in the plan's progress notes.

- [ ] **Step 5:** Create `android/NOTICE` with the Termux Apache-2.0 attribution (project name, copyright, license URL).

- [ ] **Step 6: Commit** `build(android): add Termux terminal-view/-emulator dependency + NOTICE`.

---

### Task A1: `DataMessage` codec + `ControlMessage.Resize` (byte-pinned to Swift)

**Files:**
- Create: `app/src/main/java/com/eshaan/shepherd/protocol/DataMessage.kt`, `app/src/main/java/com/eshaan/shepherd/protocol/DataWireCodec.kt`
- Modify: `app/src/main/java/com/eshaan/shepherd/protocol/ControlMessage.kt` (add `Resize`), `.../protocol/WireCodec.kt` (encode/parse `resize`)
- Test: `app/src/test/java/com/eshaan/shepherd/protocol/DataWireCodecTest.kt`, extend `WireCodecTest.kt`

**Interfaces:**
- Produces:
```kotlin
sealed interface DataMessage {
    data class DataHello(val sessionNonce: String, val paneId: String, val cols: Int, val rows: Int) : DataMessage
    data class DataReady(val cols: Int, val rows: Int) : DataMessage
    data class DataRejected(val reason: String) : DataMessage
    data class PtyHello(val paneId: String, val cols: Int, val rows: Int) : DataMessage
}
object DataWireCodec { fun encode(m: DataMessage): ByteArray; class Decoder { fun feed(d: ByteArray): List<DataMessage> } }
// ControlMessage.Resize(paneId, cols, rows)
```

- [ ] **Step 1: Write failing tests** `DataWireCodecTest.kt` (golden vectors pinned to Swift shapes — note `paneID`/`sessionNonce` JSON keys):

```kotlin
@Test fun dataHelloMatchesSwiftShape() {
    val enc = DataWireCodec.encode(DataMessage.DataHello("n1","p1",40,30))
    val json = String(enc, 4, enc.size-4, Charsets.UTF_8)
    assertTrue(json.contains("\"dataHello\""))
    assertTrue(json.contains("\"sessionNonce\":\"n1\"")); assertTrue(json.contains("\"paneID\":\"p1\""))
    assertTrue(json.contains("\"cols\":40")); assertTrue(json.contains("\"rows\":30"))
}
@Test fun decodesDataReady() {
    val m = DataWireCodec.Decoder().feed(frame("""{"dataReady":{"cols":41,"rows":22}}""")).single()
    assertEquals(DataMessage.DataReady(41,22), m)
}
@Test fun decodesDataRejected() {
    val m = DataWireCodec.Decoder().feed(frame("""{"dataRejected":{"reason":"bad nonce"}}""")).single()
    assertEquals(DataMessage.DataRejected("bad nonce"), m)
}
```
(`frame(json)` helper = prepend `[u32 BE len]`, as in `WireCodecTest`.) Add to `WireCodecTest.kt`:
```kotlin
@Test fun encodesResizeMatchesSwift() {
    val json = frameJson(ControlMessage.Resize("p1", 40, 30))
    assertTrue(json.contains("\"resize\"")); assertTrue(json.contains("\"paneID\":\"p1\""))
    assertTrue(json.contains("\"cols\":40")); assertTrue(json.contains("\"rows\":30"))
}
```

- [ ] **Step 2: Run — expect FAIL:** `./gradlew :app:testDebugUnitTest --tests '*DataWireCodecTest' --tests '*WireCodecTest'`.

- [ ] **Step 3: Implement.** `DataMessage.kt` = the sealed interface above. `DataWireCodec.kt` mirrors `WireCodec` (same `[u32 BE len][json]`, single-key object keyed by case name; `paneID`/`sessionNonce` keys):

```kotlin
object DataWireCodec {
    private fun body(m: DataMessage): JsonObject = buildJsonObject {
        when (m) {
            is DataMessage.DataHello -> putJsonObject("dataHello") {
                put("sessionNonce", m.sessionNonce); put("paneID", m.paneId); put("cols", m.cols); put("rows", m.rows)
            }
            is DataMessage.DataReady -> putJsonObject("dataReady") { put("cols", m.cols); put("rows", m.rows) }
            is DataMessage.DataRejected -> putJsonObject("dataRejected") { put("reason", m.reason) }
            is DataMessage.PtyHello -> putJsonObject("ptyHello") { put("paneID", m.paneId); put("cols", m.cols); put("rows", m.rows) }
        }
    }
    fun encode(m: DataMessage): ByteArray {
        val json = body(m).toString().toByteArray(Charsets.UTF_8)
        val out = ByteArray(4 + json.size)
        out[0]=(json.size ushr 24).toByte(); out[1]=(json.size ushr 16).toByte()
        out[2]=(json.size ushr 8).toByte(); out[3]=json.size.toByte(); json.copyInto(out,4); return out
    }
    private fun parse(json: String): DataMessage? {
        val root = Json.parseToJsonElement(json).jsonObject
        val k = root.keys.firstOrNull() ?: return null; val b = root.getValue(k).jsonObject
        return when (k) {
            "dataReady" -> DataMessage.DataReady(b.getValue("cols").jsonPrimitive.int, b.getValue("rows").jsonPrimitive.int)
            "dataRejected" -> DataMessage.DataRejected(b.getValue("reason").jsonPrimitive.content)
            "dataHello" -> DataMessage.DataHello(b.getValue("sessionNonce").jsonPrimitive.content,
                b.getValue("paneID").jsonPrimitive.content, b.getValue("cols").jsonPrimitive.int, b.getValue("rows").jsonPrimitive.int)
            "ptyHello" -> DataMessage.PtyHello(b.getValue("paneID").jsonPrimitive.content,
                b.getValue("cols").jsonPrimitive.int, b.getValue("rows").jsonPrimitive.int)
            else -> null
        }
    }
    class Decoder { /* identical framing loop to WireCodec.Decoder, calling parse() */ }
}
```
(Copy `WireCodec.Decoder`'s loop verbatim, swapping `parse` for the data `parse`.) Add `ControlMessage.Resize` and its `WireCodec` encode/parse arm:
```kotlin
// ControlMessage.kt: data class Resize(val paneId: String, val cols: Int, val rows: Int) : ControlMessage
// WireCodec.bodyJson: is ControlMessage.Resize -> putJsonObject("resize") { put("paneID", msg.paneId); put("cols", msg.cols); put("rows", msg.rows) }
// WireCodec.parse: "resize" -> ControlMessage.Resize(b.getValue("paneID")..., b.getValue("cols")....int, b.getValue("rows")....int)
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `feat(android): DataMessage codec + ControlMessage.Resize, byte-pinned to host`.

---

### Task A2: `transport/DataChannel.kt` — raw-duplex PTY data client

**Files:**
- Create: `app/src/main/java/com/eshaan/shepherd/transport/DataChannel.kt`
- Test: `app/src/test/java/com/eshaan/shepherd/transport/DataChannelLoopbackTest.kt`

**Interfaces:**
- Consumes: `DataWireCodec` (A1), a `sessionNonce` (from `ConnStatus.Connected` on the control `RemoteConnection`).
- Produces:
```kotlin
class DataChannel(host, port, sessionNonce, paneId, initialCols, initialRows, scope,
                  connect: (String,Int)->Socket = { h,p -> Socket(h,p) }) {
    val status: StateFlow<DataStatus>           // Connecting / Ready(cols,rows) / Rejected(reason) / Disconnected
    val output: SharedFlow<ByteArray>           // raw PTY bytes from host
    fun input(bytes: ByteArray)                 // raw → host (after Ready)
    fun start(); fun stop()
}
sealed interface DataStatus { object Connecting; data class Ready(val cols:Int,val rows:Int); data class Rejected(val reason:String); object Disconnected }
```

- [ ] **Step 1: Write failing loopback test** (mirror `RemoteConnectionLoopbackTest`): a `ServerSocket` on `127.0.0.1`; client `DataChannel.start()` → server reads a `DataHello` frame (assert nonce/paneID/cols/rows via `DataWireCodec.Decoder`) → server sends `DataReady(40,30)` frame then raw bytes `"screen"` → assert `status` becomes `Ready(40,30)` and `output` emits `"screen"`; then `channel.input("hi".toByteArray())` → assert server reads raw `"hi"`.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.** Session: connect → send `DataWireCodec.encode(DataHello(nonce,paneId,cols,rows))` → decode frames until the first `DataReady`/`DataRejected` (feed the decoder; on `DataReady` flip status, **stash any bytes the decoder left after the ready frame as the first raw output**), then loop reading raw → `output.emit`. `input()` writes raw bytes (guarded on `Ready`). Backoff/reconnect + `stop()` off-thread, copied from `RemoteConnection`'s discipline. **Critical:** the `DataReady` frame and the first raw bytes can arrive in one `read()` — decode exactly the ready frame, then treat the remainder as raw (same coalescing hazard the host's helper-sniff solved). Use `DataWireCodec.Decoder` fed byte-by-byte until the first message, then switch to raw with the unconsumed tail.

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `feat(android): DataChannel raw-duplex PTY transport with handshake + backoff`.

---

### Task A3: `terminal/RemoteTerminalSession.kt` — drive Termux emulator from the socket

**Files:**
- Create: `app/src/main/java/com/eshaan/shepherd/terminal/RemoteTerminalSession.kt`
- Test: `app/src/test/java/com/eshaan/shepherd/terminal/RemoteTerminalSessionTest.kt`

**Interfaces:**
- Consumes: `DataChannel` (A2), `com.termux.terminal.TerminalEmulator`, a `resizeSink: (cols:Int,rows:Int)->Unit` (wired to the control connection in A5).
- Produces:
```kotlin
class RemoteTerminalSession(cols: Int, rows: Int, private val channel: DataChannel, private val resizeSink: (Int,Int)->Unit) {
    val emulator: TerminalEmulator
    fun onOutput(bytes: ByteArray)              // append(bytes, len) to emulator on the UI thread
    fun sendInput(bytes: ByteArray)             // → channel.input
    fun onSizeChanged(cols: Int, rows: Int)     // emulator.resize + debounced resizeSink
    fun screenText(): String                    // test seam: transcript/screen dump
}
```
`TerminalEmulator(cols, rows, transcriptRows, client)` — use a minimal `TerminalOutput`/client stub that routes `write(bytes)` back to `sendInput` (some Termux versions require a session client; provide a no-op that forwards writes to the channel).

- [ ] **Step 1: Write failing test:** construct with 40×30; `onOutput("hello".toByteArray())`; assert `screenText()` contains `"hello"`. Then `sendInput` a byte and assert it reaches a fake `DataChannel` (inject a fake via constructor or a `channelInput` lambda seam). Then `onSizeChanged(20,10)` twice quickly → assert `resizeSink` called with `(20,10)` (debounced to the last value).

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.** Wrap `TerminalEmulator`; `onOutput` → `emulator.append(bytes, bytes.size)`; collect `channel.output` in the owning ViewModel and call `onOutput`. `onSizeChanged` → `emulator.resize(rows, cols)` (Termux signature is `(rows, cols)` — verify against the resolved version) + a coroutine-debounced `resizeSink(cols,rows)` (≈100 ms). `screenText()` reads `emulator.screen` transcript for the test.

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `feat(android): RemoteTerminalSession bridging DataChannel ↔ Termux emulator`.

---

### Task A4: `ui/AgentScreen.kt` + `AgentViewModel.kt` — terminal view, extra-keys, input

**Files:**
- Create: `app/src/main/java/com/eshaan/shepherd/ui/AgentScreen.kt`, `.../ui/AgentViewModel.kt`
- Test: `app/src/test/java/com/eshaan/shepherd/ui/AgentViewModelTest.kt` (pure VM logic); on-device instrumented render is the manual pass.

**Interfaces:**
- Consumes: `RemoteConnection` (control, for the nonce + `Resize`), `DataChannel` (A2), `RemoteTerminalSession` (A3).
- Produces: `AgentViewModel(paneId, host, port, controlConn)` exposing `terminalSession: StateFlow<RemoteTerminalSession?>` + `status: StateFlow<DataStatus>`; `AgentScreen(vm)` composable = a `TerminalView` (via `AndroidView`) bound to `vm.terminalSession.emulator` + an extra-keys `Row` (Esc/Ctrl/Tab/↑↓←→/Enter, each → `session.sendInput(escBytes)`) + a text field (submit → `sendInput(text + "\r")`).

- [ ] **Step 1: Write failing VM test:** `AgentViewModel` with a fake control conn already `Connected("nonce-1")` → on `attach()`, it constructs a `DataChannel` with that nonce + paneId and starts it; `status` mirrors the channel. Assert the extra-key byte map: `escBytesFor(Key.Up) == byteArrayOf(0x1b,'['.code.toByte,'A'.code.toByte)`, `Key.Esc == byteArrayOf(0x1b)`, `Ctrl+C == byteArrayOf(0x03)`. Put `escBytesFor` as a pure top-level function (easy to test).

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.** `escBytesFor` pure map. `AgentViewModel.attach()` reads the live `sessionNonce` from `controlConn.status` (`ConnStatus.Connected`), builds `DataChannel`, builds `RemoteTerminalSession(resizeSink = { c,r -> controlConn.send(ControlMessage.Resize(paneId,c,r)) })`, collects `channel.output` → `session.onOutput`. `AgentScreen`: `AndroidView({ TerminalView(ctx,null).apply { attachSession/ setTerminalCursorBlinkerState ... } })` bound to the emulator; Termux `TerminalView` normally drives a `TerminalSession` — here feed the emulator directly and set the view's `TerminalViewClient` to forward key events to `session.sendInput`. Extra-keys `Row` of `IconButton`s; a `TextField` + send. On `TerminalView` size change → `session.onSizeChanged(cols,rows)`.

- [ ] **Step 4: Run VM test — expect PASS.**
- [ ] **Step 5: Commit** `feat(android): Agent screen — Termux TerminalView + extra-keys + input`.

---

### Task A5: Navigation — Fleet tap + notification deep-link → Agent screen

**Files:**
- Modify: `app/src/main/java/com/eshaan/shepherd/ui/FleetScreen.kt` (row tap → navigate), `.../ui/FleetViewModel.kt` (expose the live `RemoteConnection` + host/port), `.../MainActivity.kt` (nav host / route + `onNewIntent` deep-link), `.../fcm/Notifications.kt` (deep-link intent extra: paneID)
- Test: extend `FleetViewModelTest` (tap → selectedPaneId), manual on-device for nav.

- [ ] **Step 1: Write failing test:** `FleetViewModel.openAgent("p1")` sets `navTarget = NavTarget.Agent("p1")` (a `StateFlow`); consuming it clears to null.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.** Add `navTarget` to `FleetViewModel`; `FleetScreen` `TabRow` `onClick` → `vm.openAgent(paneId)`. `MainActivity`: a simple `when (navTarget)` swap between `FleetScreen` and `AgentScreen(agentViewModel(paneId))`, passing the same host/port/`RemoteConnection` the Fleet uses. `Notifications.kt`: put `paneID` extra on the tap `PendingIntent`; `MainActivity.onNewIntent` → `vm.openAgent(extra)`.

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `feat(android): navigate Fleet/notification → Agent screen`.

---

### Task A6: On-device verification (adb) — user-run checklist

**Not automated.** With the phone on the tailnet + adb, and the host app running with serving on:

- [ ] Install: `./gradlew :app:installDebug` (JDK 17 env).
- [ ] From the Fleet screen, tap a **blocked** agent → Agent screen shows its recent screen (ring replay: the `AskUserQuestion`/permission menu).
- [ ] Confirm the pane **reflows to phone width** (host resized Claude) — menu readable without pan/zoom.
- [ ] Answer the `AskUserQuestion` (arrow + Enter, or type) → host agent advances; state dot updates.
- [ ] Submit a new prompt from the text field → agent runs.
- [ ] Detach (back to Fleet) and **refocus the pane on the Mac** → Claude snaps back to desktop width (no mis-sized grid).
- [ ] Rotate the phone / toggle keyboard → live `Resize` reflows while attached.

Report results here; file any gaps as follow-ups. Do **not** modify the running app to test.

---

## Self-Review

**Spec coverage:** §4.1 sized DataHello + resize protocol → H1/A1. §4.2 helper resize apply → H2. §4.3 broker input framing + resize → H3; data-channel attach size + snap-back → H4. §5.1 active-driver arbiter + control-channel resize + refocus snap-back → H5; Android resize emit → A3/A4. §5 `transport/DataChannel` → A2; `terminal/` → A3; `ui/` Agent screen + extra-keys → A4; nav/deep-link → A5. §6 nonce gate = shipped (unchanged). §7 tests: pure codec (H1/A1), loopback (H4/A2), helper (H2), Android golden + emulator (A1/A3), device (A6). Termux vendoring → A0.

**Placeholder scan:** none — every code step has concrete code; A6 is explicitly a manual checklist, not a code task.

**Type consistency:** `DataMessage.dataHello(sessionNonce,paneID,cols,rows)` and `DataReady(cols,rows)` identical across H1/H4/A1/A2. `HelperFrame`/`HelperFrameCodec` identical H1↔H3↔H2 (helper hand-rolls a byte-identical decode). `ControlMessage.resize(paneID,cols,rows)` H1/H5/A1/A4. `PtyBroker.setSize(cols:rows:)` H3↔H4↔H5. `phoneOwnsSize(...)` H5. `RemoteServer.applyResize`/`applyResizeForcingDesktop` H4↔H5.

**Open risk flagged:** Termux `TerminalEmulator`/`TerminalView` exact constructor + `resize(rows,cols)` arg order + client interface vary by version — A0 pins the version; A3/A4 verify signatures against the resolved artifact and adjust (the only place API drift bites).
