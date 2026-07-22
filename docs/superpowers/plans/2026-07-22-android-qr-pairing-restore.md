# Android QR Pairing Restore — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the Android client to a pairable, working state by replacing its dead 4-digit-code pairing with a QR bootstrap over Tailscale that matches the Mac's post-`58a41a9` identity-gated model.

**Architecture:** A pure `shepherd://pair?…` payload is byte-pinned across Swift and Kotlin. The Mac renders it as a QR (Core Image) in a new "Connect a phone…" sheet; the phone scans it (ZXing), parses it, and dials the host over Tailscale — where admission is already source-IP/identity gated. The dead code field is removed; MagicDNS name is primary with the Tailscale IP as a connect fallback.

**Tech Stack:** Swift/SwiftUI + Core Image (Mac); Kotlin/Compose + `com.journeyapps:zxing-android-embedded` (phone). Build the phone with **JDK 17**.

## Global Constraints

- **Phone build JVM:** JDK 17. `export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home` before any `./gradlew` command. Working dir for gradle: `android/`.
- **Byte-pinned wire:** the exact payload string is `shepherd://pair?host=<magicdns>&ip=<v4>&port=<port>&name=<name>` with query items in that order; Swift encodes it and Kotlin parses it — tests on both sides must assert the identical literal string.
- **No secret in the QR** — admission stays Tailscale-identity gated; do not add a code/secret to the payload.
- **Swift new source files** must be added to the `ShepherdModelTests` target's explicit `sources:` list in `spike/seam1/project.yml` (the app target picks them up via its `Sources/` glob automatically), then `xcodegen generate` before building. Run `xcodegen generate` from `spike/seam1/`.
- **Mac swift-test command** (from `spike/seam1/`):
  `xcodebuild test -project Shepherd.xcodeproj -scheme Shepherd -destination 'platform=macOS,arch=arm64' -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache -only-testing:ShepherdModelTests`
- **Commit messages** end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Do **not** kill/relaunch the running Shepherd app; verify by compile + unit tests and defer runtime/E2E to the user.

---

### Task 1: Pure pairing payload — Swift encoder

**Files:**
- Create: `spike/seam1/Sources/PairingPayload.swift`
- Modify: `spike/seam1/project.yml` (add the source to the `ShepherdModelTests` `sources:` list)
- Test: `spike/seam1/Tests/PairingPayloadTests.swift`

**Interfaces:**
- Produces: `enum PairingPayload { static func encode(host: String?, ip: String?, port: UInt16, name: String) -> String }` emitting `shepherd://pair?host=…&ip=…&port=…&name=…` (omitting `host`/`ip` when nil/empty; `port` and `name` always present).

- [ ] **Step 1: Write the failing test**

`spike/seam1/Tests/PairingPayloadTests.swift`:
```swift
import XCTest
@testable import Shepherd

final class PairingPayloadTests: XCTestCase {
    func testEncodePinnedString() {
        let s = PairingPayload.encode(host: "work.tail1234.ts.net", ip: "100.78.141.27",
                                      port: 8722, name: "work")
        XCTAssertEqual(s, "shepherd://pair?host=work.tail1234.ts.net&ip=100.78.141.27&port=8722&name=work")
    }
    func testEncodeOmitsEmptyHostAndIP() {
        let s = PairingPayload.encode(host: nil, ip: "100.64.0.5", port: 8722, name: "mac")
        XCTAssertEqual(s, "shepherd://pair?ip=100.64.0.5&port=8722&name=mac")
    }
}
```

- [ ] **Step 2: Add the source to the test target and regenerate**

In `spike/seam1/project.yml`, add `- Sources/PairingPayload.swift` to the `ShepherdModelTests` target's `sources:` list (alongside `Sources/SplitTree.swift` etc.). Then from `spike/seam1/`:
```bash
xcodegen generate
```

- [ ] **Step 3: Run test to verify it fails**

Run the Mac swift-test command (Global Constraints) with `-only-testing:ShepherdModelTests/PairingPayloadTests`.
Expected: FAIL — `cannot find 'PairingPayload' in scope`.

- [ ] **Step 4: Write minimal implementation**

`spike/seam1/Sources/PairingPayload.swift`:
```swift
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
```

- [ ] **Step 5: Run test to verify it passes**

Same command as Step 3. Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/PairingPayload.swift spike/seam1/Tests/PairingPayloadTests.swift spike/seam1/project.yml
git commit -m "feat(remote): pure PairingPayload encoder (Swift, byte-pinned)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Pure pairing payload — Kotlin parser

**Files:**
- Create: `android/app/src/main/java/com/eshaan/shepherd/protocol/PairingPayload.kt`
- Test: `android/app/src/test/java/com/eshaan/shepherd/protocol/PairingPayloadTest.kt`

**Interfaces:**
- Consumes: the pinned string from Task 1.
- Produces: `object PairingPayload { data class Parsed(val host: String?, val ip: String?, val port: Int, val name: String?); fun parse(s: String): Parsed? }` — returns null on wrong scheme, missing `port`, or when both `host` and `ip` are absent.

- [ ] **Step 1: Write the failing test**

`android/app/src/test/java/com/eshaan/shepherd/protocol/PairingPayloadTest.kt`:
```kotlin
package com.eshaan.shepherd.protocol

import org.junit.Assert.*
import org.junit.Test

class PairingPayloadTest {
    @Test fun parsesPinnedSwiftString() {
        val p = PairingPayload.parse("shepherd://pair?host=work.tail1234.ts.net&ip=100.78.141.27&port=8722&name=work")!!
        assertEquals("work.tail1234.ts.net", p.host)
        assertEquals("100.78.141.27", p.ip)
        assertEquals(8722, p.port)
        assertEquals("work", p.name)
    }
    @Test fun toleratesMissingHost() {
        val p = PairingPayload.parse("shepherd://pair?ip=100.64.0.5&port=8722&name=mac")!!
        assertNull(p.host); assertEquals("100.64.0.5", p.ip)
    }
    @Test fun rejectsWrongSchemeAndNoEndpoint() {
        assertNull(PairingPayload.parse("https://pair?ip=1.2.3.4&port=8722"))
        assertNull(PairingPayload.parse("shepherd://pair?port=8722&name=x"))
        assertNull(PairingPayload.parse("garbage"))
    }
    @Test fun decodesPercentEncodedName() {
        val p = PairingPayload.parse("shepherd://pair?ip=100.64.0.5&port=8722&name=my%20mac")!!
        assertEquals("my mac", p.name)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd android && export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
./gradlew :app:testDebugUnitTest --no-daemon --tests "com.eshaan.shepherd.protocol.PairingPayloadTest"
```
Expected: FAIL — unresolved reference `PairingPayload`.

- [ ] **Step 3: Write minimal implementation**

`android/app/src/main/java/com/eshaan/shepherd/protocol/PairingPayload.kt`:
```kotlin
package com.eshaan.shepherd.protocol

import java.net.URI
import java.net.URLDecoder

/** Parses the QR bootstrap payload minted by the Swift PairingPayload.encode. Byte-pinned. */
object PairingPayload {
    data class Parsed(val host: String?, val ip: String?, val port: Int, val name: String?)

    fun parse(s: String): Parsed? {
        val uri = try { URI(s.trim()) } catch (e: Exception) { return null }
        if (uri.scheme != "shepherd") return null
        val q = uri.rawQuery ?: return null
        val map = q.split("&").mapNotNull {
            val i = it.indexOf('=')
            if (i < 0) null
            else URLDecoder.decode(it.substring(0, i), "UTF-8") to URLDecoder.decode(it.substring(i + 1), "UTF-8")
        }.toMap()
        val port = map["port"]?.toIntOrNull() ?: return null
        val host = map["host"]?.ifBlank { null }
        val ip = map["ip"]?.ifBlank { null }
        if (host == null && ip == null) return null
        return Parsed(host, ip, port, map["name"]?.ifBlank { null })
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Same command as Step 2. Expected: PASS (all four tests).

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/eshaan/shepherd/protocol/PairingPayload.kt android/app/src/test/java/com/eshaan/shepherd/protocol/PairingPayloadTest.kt
git commit -m "feat(android): PairingPayload parser (Kotlin, byte-pinned to host)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Mac — capture the host's own MagicDNS name + Tailscale IP

**Files:**
- Modify: `spike/seam1/Sources/TailscaleDiscovery.swift` (`parse`, `TSStatus`)
- Test: `spike/seam1/Tests/TailscaleDiscoveryTests.swift` (add a case)

**Interfaces:**
- Produces: `TSStatus` gains `let selfDNSName: String?` and `let selfIPv4: String?`, populated from the JSON `Self` object (`DNSName` trailing-dot trimmed; first CGNAT `TailscaleIPs`).

- [ ] **Step 1: Write the failing test**

Add to `spike/seam1/Tests/TailscaleDiscoveryTests.swift`:
```swift
func testParseCapturesSelfDNSNameAndIP() {
    let json = """
    {"Self":{"UserID":1,"DNSName":"work.tail1234.ts.net.","TailscaleIPs":["100.78.141.27","fd7a::1"]},
     "Peer":{},"User":{}}
    """.data(using: .utf8)!
    let s = TailscaleDiscovery.parse(json)!
    XCTAssertEqual(s.selfDNSName, "work.tail1234.ts.net")
    XCTAssertEqual(s.selfIPv4, "100.78.141.27")
}
```

- [ ] **Step 2: Run test to verify it fails**

Mac swift-test command with `-only-testing:ShepherdModelTests/TailscaleDiscoveryTests/testParseCapturesSelfDNSNameAndIP`.
Expected: FAIL — `value of type 'TSStatus' has no member 'selfDNSName'`.

- [ ] **Step 3: Write minimal implementation**

In `TailscaleDiscovery.parse`, after computing `selfUserID`, add:
```swift
        let selfDNSName = (selfObj?["DNSName"] as? String)?
            .trimmingCharacters(in: CharacterSet(charactersIn: "."))
            .nilIfEmpty
        let selfIPv4 = (selfObj?["TailscaleIPs"] as? [String])?.first { isTailscaleCGNAT($0) }
```
Update the return to `TSStatus(selfUserID: selfUserID, selfDNSName: selfDNSName, selfIPv4: selfIPv4, peers: peers, userNames: userNames)`.

Extend the struct:
```swift
struct TSStatus: Equatable {
    let selfUserID: String?; let selfDNSName: String?; let selfIPv4: String?
    let peers: [TSPeer]; let userNames: [String: String]
}
```
Add the helper (bottom of the file, outside the enum):
```swift
private extension String { var nilIfEmpty: String? { isEmpty ? nil : self } }
```
Then fix the other `TSStatus(...)` construction sites if any fail to compile (search `TSStatus(`), passing `selfDNSName: nil, selfIPv4: nil` where the fields are unknown.

- [ ] **Step 4: Run test to verify it passes**

Mac swift-test command with `-only-testing:ShepherdModelTests/TailscaleDiscoveryTests`. Expected: PASS (existing + new).

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/TailscaleDiscovery.swift spike/seam1/Tests/TailscaleDiscoveryTests.swift
git commit -m "feat(remote): capture host MagicDNS name + Tailscale IP in TSStatus

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Mac — "Connect a phone…" QR sheet

**Files:**
- Create: `spike/seam1/Sources/PhonePairingQRView.swift`
- Modify: `spike/seam1/Sources/AgentStore.swift` (add `@Published var showingPhonePairingQR` and `func phonePairingPayload() -> String?`)
- Modify: `spike/seam1/Sources/SidebarView.swift` (overflow menu item)
- Modify: `spike/seam1/Sources/ContentView.swift` (present the sheet)

**Interfaces:**
- Consumes: `PairingPayload.encode` (Task 1); `TSStatus.selfDNSName/selfIPv4` (Task 3); existing `AgentStore` `tailnetStatus()`, `isServing`, `AgentStore.defaultRemotePort`.
- Produces: `AgentStore.showingPhonePairingQR: Bool`, `AgentStore.phonePairingPayload() -> String?` (nil when Tailscale is down); `PhonePairingQRView`.

This task is UI (no unit test); its gate is a clean app build.

- [ ] **Step 1: Add store state + payload builder**

In `AgentStore.swift`, near `@Published var showingRemoteDevices = false`:
```swift
    @Published var showingPhonePairingQR = false
```
Add a method (near `discoverDevices`):
```swift
    /// The QR bootstrap payload for a phone to reach this host, or nil if Tailscale is down.
    func phonePairingPayload() -> String? {
        let status = tailnetStatus()
        let ip = status?.selfIPv4 ?? RemoteServer.currentTailscaleIPv4()
        let host = status?.selfDNSName
        guard host != nil || ip != nil else { return nil }
        let name = host?.split(separator: ".").first.map(String.init) ?? (Host.current().localizedName ?? "mac")
        return PairingPayload.encode(host: host, ip: ip, port: AgentStore.defaultRemotePort, name: name)
    }
```

- [ ] **Step 2: Create the QR view**

`spike/seam1/Sources/PhonePairingQRView.swift`:
```swift
import SwiftUI
import CoreImage.CIFilterBuiltins

/// Self-drawn Theme sheet: a QR of this host's pairing payload for a phone to scan.
/// Styled like RemoteDeviceSheet. Backdrop-click / Esc dismiss.
struct PhonePairingQRView: View {
    @EnvironmentObject var store: AgentStore

    var body: some View {
        let payload = store.phonePairingPayload()
        ZStack {
            Color.black.opacity(0.35).ignoresSafeArea().onTapGesture { dismiss() }
            VStack(alignment: .leading, spacing: 12) {
                Text("Connect a phone").font(.ui(15, .semibold)).foregroundStyle(Theme.textPrimary)
                if let payload, let img = Self.qr(payload) {
                    Image(nsImage: img).interpolation(.none).resizable()
                        .frame(width: 220, height: 220)
                        .background(Color.white).cornerRadius(8)
                        .frame(maxWidth: .infinity, alignment: .center)
                    Text("Scan with the Shepherd app on your phone, then approve here.")
                        .font(.ui(12)).foregroundStyle(Theme.textSecondary)
                    if let dns = store.phonePairingHostLabel() {
                        Text(dns).font(.ui(11).monospaced()).foregroundStyle(Theme.textDim).textSelection(.enabled)
                    }
                } else {
                    Text("Tailscale is not running — can't build a pairing link.")
                        .font(.ui(13)).foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(18).frame(width: 300)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.ground)
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Theme.hairline, lineWidth: 1)))
            .shadow(color: .black.opacity(0.55), radius: 30, x: 0, y: 16)
        }
        .onExitCommand { dismiss() }
    }

    private static func qr(_ s: String) -> NSImage? {
        let ctx = CIContext()
        let f = CIFilter.qrCodeGenerator()
        f.message = Data(s.utf8); f.correctionLevel = "M"
        guard let ci = f.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)),
              let cg = ctx.createCGImage(ci, from: ci.extent) else { return nil }
        return NSImage(cgImage: cg, size: NSSize(width: ci.extent.width, height: ci.extent.height))
    }

    private func dismiss() { store.showingPhonePairingQR = false }
}
```
Add the small label helper to `AgentStore.swift`:
```swift
    /// Human-readable host line under the QR (MagicDNS name : port), or nil.
    func phonePairingHostLabel() -> String? {
        guard let host = tailnetStatus()?.selfDNSName ?? RemoteServer.currentTailscaleIPv4() else { return nil }
        return "\(host):\(AgentStore.defaultRemotePort)"
    }
```

- [ ] **Step 3: Add the menu item**

In `SidebarView.swift`, inside `overflowMenu`'s `Menu { … }`, after the "Add remote device…" button:
```swift
            if store.isServing {
                Button("Connect a phone…") { store.showingPhonePairingQR = true }
            }
```

- [ ] **Step 4: Present the sheet**

In `ContentView.swift`, mirror the `showingRemoteDevices` overlay block:
```swift
        .overlay {
            if store.showingPhonePairingQR {
                PhonePairingQRView()
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.12), value: store.showingPhonePairingQR)
```

- [ ] **Step 5: Regenerate + build the app**

```bash
cd spike/seam1 && xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -5
```
Expected: `BUILD SUCCEEDED`. (Fix any missing `Theme.ui`/token names by matching those used in `RemoteDeviceSheet.swift`.)

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/PhonePairingQRView.swift spike/seam1/Sources/AgentStore.swift spike/seam1/Sources/SidebarView.swift spike/seam1/Sources/ContentView.swift spike/seam1/project.yml
git commit -m "feat(remote): Connect-a-phone QR sheet on the host

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Phone — drop the dead pairing code

**Files:**
- Modify: `android/app/src/main/java/com/eshaan/shepherd/pairing/PairingController.kt`
- Modify: `android/app/src/main/java/com/eshaan/shepherd/ui/PairingViewModel.kt`
- Test: `android/app/src/test/java/com/eshaan/shepherd/pairing/PairingControllerTest.kt`

**Interfaces:**
- Produces: `PairingController.helloForFirstPair(deviceId, deviceName, secret, fcmToken)` (no `host`/`port`/`code`); `PairingViewModel.pair(host: String, ip: String?, port: Int)`.
- Consumes: `PairingPayload.Parsed` (Task 2), `RemoteConnection(..., fallbackHosts=…)` (Task 6).

- [ ] **Step 1: Update the failing test**

Replace `firstPairHelloCarriesCodeAndSecretAndToken` in `PairingControllerTest.kt` with:
```kotlin
    @Test fun firstPairHelloHasNoCodeButCarriesSecretAndToken() {
        val c = PairingController(InMemoryPairingStore())
        val h = c.helloForFirstPair("dev-1", "Pixel 8", "secret-abc", "tok")
        assertNull(h.pairingCode)
        assertEquals("secret-abc", h.secret); assertEquals("tok", h.fcmToken); assertEquals("dev-1", h.deviceId)
    }
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd android && export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
./gradlew :app:testDebugUnitTest --no-daemon --tests "com.eshaan.shepherd.pairing.PairingControllerTest"
```
Expected: FAIL — `helloForFirstPair` still requires the old params (compile error).

- [ ] **Step 3: Update the implementation**

In `PairingController.kt` replace `helloForFirstPair`:
```kotlin
    fun helloForFirstPair(deviceId: String, deviceName: String, secret: String,
                          fcmToken: String?): ControlMessage.Hello =
        ControlMessage.Hello(deviceId, deviceName, pairingCode = null, secret = secret, fcmToken = fcmToken)
```

In `PairingViewModel.kt` replace `pair`:
```kotlin
    fun pair(host: String, ip: String?, port: Int) {
        val deviceId = DeviceIdentity.newDeviceId()
        val primary = host.ifBlank { ip ?: "" }
        val fallbacks = listOfNotNull(ip).filter { it != primary }
        val pending = Pairing(primary, port, deviceId, DeviceIdentity.deviceName(), DeviceIdentity.newSecret())
        viewModelScope.launch {
            val token = fcmToken()
            val c = RemoteConnection(primary, port,
                helloFactory = { controller.helloForFirstPair(deviceId, pending.deviceName, pending.secret, token) },
                scope = viewModelScope, fallbackHosts = fallbacks)
            conn = c
            viewModelScope.launch { c.status.collect { _state.value = controller.reduce(_state.value, it, pending) } }
            c.start()
        }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Same command as Step 2. Expected: PASS. (`RemoteConnection`'s `fallbackHosts` param lands in Task 6; if executing tasks out of order, do Task 6 first — noted in Interfaces.)

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/eshaan/shepherd/pairing/PairingController.kt android/app/src/main/java/com/eshaan/shepherd/ui/PairingViewModel.kt android/app/src/test/java/com/eshaan/shepherd/pairing/PairingControllerTest.kt
git commit -m "feat(android): drop the dead pairing code from first-pair hello

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Phone — RemoteConnection host fallback

**Files:**
- Modify: `android/app/src/main/java/com/eshaan/shepherd/transport/RemoteConnection.kt`
- Test: `android/app/src/test/java/com/eshaan/shepherd/transport/RemoteConnectionLoopbackTest.kt` (add a case)

**Interfaces:**
- Produces: `RemoteConnection(..., fallbackHosts: List<String> = emptyList())` — a new **last-before-`connect`** constructor param; each session tries `listOf(host) + fallbackHosts` (deduped) and uses the first that connects.

- [ ] **Step 1: Write the failing test**

Add to `RemoteConnectionLoopbackTest.kt` (uses the existing `scope`/server test helpers in that file; model it on the nearby cases):
```kotlin
    @Test fun fallsBackToSecondHostWhenFirstRefused() = runTest {
        val server = java.net.ServerSocket(0)
        val goodPort = server.localPort
        val attempted = mutableListOf<String>()
        val conn = RemoteConnection("dead-host", goodPort,
            helloFactory = { ControlMessage.Hello("d", "n", null, "s", null, 2) },
            scope = this, fallbackHosts = listOf("127.0.0.1"),
            connect = { h, p ->
                attempted += h
                if (h == "127.0.0.1") java.net.Socket("127.0.0.1", p)
                else throw java.net.ConnectException("refused")
            })
        conn.start()
        // let one session attempt run
        kotlinx.coroutines.delay(200)
        conn.stop(); server.close()
        assertEquals(listOf("dead-host", "127.0.0.1"), attempted)
    }
```
(If the file's existing tests use a different dispatcher/`runTest` idiom, match it; the assertion — both hosts attempted in order — is the point.)

- [ ] **Step 2: Run test to verify it fails**

```bash
cd android && export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
./gradlew :app:testDebugUnitTest --no-daemon --tests "com.eshaan.shepherd.transport.RemoteConnectionLoopbackTest"
```
Expected: FAIL — no `fallbackHosts` parameter.

- [ ] **Step 3: Write minimal implementation**

In `RemoteConnection.kt`, add the constructor param immediately **before** `connect`:
```kotlin
    private val fallbackHosts: List<String> = emptyList(),
    private val connect: (String, Int) -> Socket = { h, p -> Socket(h, p) },
```
Add a helper and use it in `runSession`:
```kotlin
    private fun openSocket(): Socket {
        val candidates = (listOf(host) + fallbackHosts).distinct()
        var last: Exception? = null
        for (h in candidates) {
            try { return connect(h, port) } catch (e: Exception) { last = e }
        }
        throw last ?: java.net.ConnectException("no reachable host")
    }
```
Replace `val s = connect(host, port); socket = s;` with `val s = openSocket(); socket = s;`.

- [ ] **Step 4: Run test to verify it passes**

Same command as Step 2. Expected: PASS (existing loopback tests + the new one).

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/eshaan/shepherd/transport/RemoteConnection.kt android/app/src/test/java/com/eshaan/shepherd/transport/RemoteConnectionLoopbackTest.kt
git commit -m "feat(android): RemoteConnection ordered host fallback (MagicDNS then IP)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Phone — ZXing scanner dependency + camera permission

**Files:**
- Modify: `android/app/build.gradle.kts`
- Modify: `android/app/src/main/AndroidManifest.xml`

**Interfaces:**
- Produces: `com.journeyapps.barcodescanner.ScanContract` / `ScanOptions` on the classpath; `android.permission.CAMERA` declared.

This task's gate is a clean assemble (no new unit test — it's dependency wiring).

- [ ] **Step 1: Add the dependencies**

In `android/app/build.gradle.kts`, inside `dependencies { … }`, after the termux line:
```kotlin
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("androidx.appcompat:appcompat:1.7.0")   // ZXing CaptureActivity extends AppCompatActivity
```

- [ ] **Step 2: Declare the camera permission**

In `android/app/src/main/AndroidManifest.xml`, after the `POST_NOTIFICATIONS` permission line:
```xml
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-feature android:name="android.hardware.camera" android:required="false" />
```

- [ ] **Step 3: Verify it assembles**

```bash
cd android && export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
./gradlew :app:assembleDebug --no-daemon 2>&1 | tail -5
```
Expected: `BUILD SUCCESSFUL` (dependency resolves from jitpack/mavenCentral).

- [ ] **Step 4: Commit**

```bash
git add android/app/build.gradle.kts android/app/src/main/AndroidManifest.xml
git commit -m "build(android): add ZXing scanner + CAMERA permission

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Phone — QR-scan pairing screen

**Files:**
- Modify: `android/app/src/main/java/com/eshaan/shepherd/ui/PairingScreen.kt`

**Interfaces:**
- Consumes: `PairingPayload.parse` (Task 2), `PairingViewModel.pair(host, ip, port)` (Task 5), `ScanContract`/`ScanOptions` (Task 7).

UI task — gate is a clean assemble + the earlier unit tests still passing. E2E is the user's.

- [ ] **Step 1: Rewrite the screen (scan primary, manual fallback, no code)**

Replace `PairingScreen.kt` body:
```kotlin
package com.eshaan.shepherd.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.eshaan.shepherd.pairing.PairingState
import com.eshaan.shepherd.protocol.PairingPayload
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

@Composable
fun PairingScreen(vm: PairingViewModel, onPaired: () -> Unit) {
    val state by vm.state.collectAsState()
    var showManual by remember { mutableStateOf(false) }
    var scanError by remember { mutableStateOf<String?>(null) }
    var host by remember { mutableStateOf("") }
    var port by remember { mutableStateOf("8722") }
    LaunchedEffect(state) { if (state is PairingState.Paired) onPaired() }

    val scanLauncher = rememberLauncherForActivityResult(ScanContract()) { result ->
        val contents = result.contents ?: return@rememberLauncherForActivityResult   // cancelled
        val p = PairingPayload.parse(contents)
        if (p == null) { scanError = "That QR isn't a Shepherd pairing code." }
        else { scanError = null; vm.pair(p.host ?: "", p.ip, p.port) }
    }

    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Pair with a Shepherd host", style = MaterialTheme.typography.titleLarge)
        Text("On the Mac: ⋯ menu → Connect a phone… → scan the QR.",
            style = MaterialTheme.typography.bodyMedium)
        Button(onClick = {
            scanError = null
            scanLauncher.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setBeepEnabled(false).setPrompt("Scan the Shepherd QR").setOrientationLocked(false))
        }) { Text("Scan QR to pair") }

        scanError?.let { Text(it, color = MaterialTheme.colorScheme.error) }

        TextButton(onClick = { showManual = !showManual }) {
            Text(if (showManual) "Hide manual entry" else "Enter host manually")
        }
        if (showManual) {
            OutlinedTextField(host, { host = it }, singleLine = true,
                label = { Text("Host (Tailscale 100.x or MagicDNS)") })
            OutlinedTextField(port, { port = it.filter(Char::isDigit) }, singleLine = true,
                label = { Text("Port") })
            Button(onClick = { vm.pair(host.trim(), null, port.toIntOrNull() ?: 8722) },
                enabled = host.isNotBlank()) { Text("Pair") }
        }

        when (val s = state) {
            PairingState.Connecting -> Text("Connecting…")
            PairingState.WaitingApproval -> Text("Waiting for approval on the host…")
            is PairingState.Error -> Text("Failed: ${s.reason}", color = MaterialTheme.colorScheme.error)
            else -> {}
        }
    }
}
```

- [ ] **Step 2: Verify it assembles**

```bash
cd android && export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
./gradlew :app:assembleDebug --no-daemon 2>&1 | tail -5
```
Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 3: Run the full unit-test suite**

```bash
./gradlew :app:testDebugUnitTest --no-daemon 2>&1 | tail -8
```
Expected: `BUILD SUCCESSFUL` (all tests, including Tasks 2/5/6).

- [ ] **Step 4: Commit**

```bash
git add android/app/src/main/java/com/eshaan/shepherd/ui/PairingScreen.kt
git commit -m "feat(android): QR-scan pairing screen (manual fallback, no code field)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] **Mac:** `cd spike/seam1 && xcodegen generate && xcodebuild … build` → `BUILD SUCCEEDED`, and `xcodebuild test … -only-testing:ShepherdModelTests` → all pass.
- [ ] **Phone:** `cd android && ./gradlew :app:assembleDebug :app:testDebugUnitTest --no-daemon` (JDK 17) → `BUILD SUCCESSFUL`.
- [ ] **Hand off E2E to the user:** bring `nothing-phone-2` online on Tailscale; on the Mac enable serving → ⋯ → "Connect a phone…"; on the phone tap "Scan QR to pair" → scan → approve on the Mac → fleet loads → open an agent → terminal + smart-approve work.

## Spec traceability

- Payload wire → Tasks 1, 2. Host MagicDNS/IP capture → Task 3. Host QR sheet + menu → Task 4. Remove dead code → Task 5. MagicDNS→IP fallback → Task 6. Scanner deps/permission → Task 7. Scan UI + manual fallback → Task 8. JDK-17 build note → Global Constraints + Final verification.
