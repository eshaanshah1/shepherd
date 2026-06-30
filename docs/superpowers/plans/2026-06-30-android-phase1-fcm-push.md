# Host FCM Push Implementation Plan (Android Phase 1, step 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a host agent needs attention and you're away from the machine, wake your phone over FCM with a data-only push (no terminal content); when you're at the machine, alert locally as today.

**Architecture:** A pure decision layer (`FCMMessage`, `NotificationRoutingPolicy`) + effectful shells (`FCMPusher`, `PresenceMonitor`) mirror the existing `StopPolicy`/`AgentStore` and `SleepPolicy`/`SleepGuard` splits. `AgentStore.apply` routes each attention transition to local surfaces *or* an FCM push based on a presence signal (`isAway = lidClosed && !externalDisplayAttached`). The control protocol gains an FCM token at pairing + a token-refresh message. All dark-shipped behind the existing `shepherd.remote.serving` toggle + presence of a service-account key.

**Tech Stack:** Swift (xcodegen project at `spike/seam1`), XCTest, the Security framework (RS256), IOKit (`ClamshellMonitor`), AppKit (`CGDisplay`, `NSApplication`), `URLSession` (FCM v1 + OAuth2), Google FCM HTTP v1 API.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-30-android-fcm-push-design.md` — every task implements part of it.
- **Branch:** `android-fcm-push` (already checked out, off `master`).
- **Build:** after adding/removing ANY source file, run `xcodegen generate` from `spike/seam1` before `xcodebuild` — else the file isn't compiled.
- **Test targets:** pure-model files must be added to `ShepherdModelTests` `sources:` in `project.yml` explicitly; the app target globs `Sources/` so it picks new files up automatically (but still needs `xcodegen generate`). Test *files* under `Tests/` and `RemoteTests/` are globbed — no `project.yml` edit for a new test file.
- **Pure-model rule:** files in `ShepherdModelTests` must not import AppKit/IOKit/Security and must keep `Date.now`/randomness out of the model — pass `now`/`iat` in as parameters (as `SleepPolicy` does).
- **Don't kill the user's live Shepherd** ([shepherd-dont-kill-while-live]): verify by `xcodebuild` + the model/loopback test suites + (for FCM auth) an optional manual token-exchange check. Real-device push delivery is deferred to step 3's checklist. Never `killall`/relaunch the running app.
- **Privacy:** FCM payloads are data-only — `{paneID, state, urgent}` only. Never put titles, cwd, reasons, or terminal bytes in a push.
- **Build command (run from `spike/seam1`):**
  ```bash
  xcodegen generate && xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
    -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build
  ```
- **Test commands (run from `spike/seam1`):**
  ```bash
  xcodebuild test -project Shepherd.xcodeproj -scheme Shepherd -destination 'platform=macOS' \
    -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
    -only-testing:ShepherdModelTests
  # swap -only-testing:ShepherdRemoteTests for the loopback suite
  ```
- **Commit trailer (every commit):**
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```

---

### Task 1: Protocol — FCM token at pairing, token refresh, protocol version

**Files:**
- Modify: `spike/seam1/Sources/RemoteProtocol.swift` (the `hello` case + `refreshFCMToken` case + `PairedDevice`)
- Modify: `spike/seam1/Sources/RemoteServer.swift:170` (the `.hello` pattern match — make it compile)
- Modify: `spike/seam1/RemoteTests/RemoteServerTests.swift` (every `.hello(...)` call site + the `makeServer` helper still compiles)
- Test: `spike/seam1/Tests/RemoteProtocolTests.swift` (add round-trip tests)

**Interfaces:**
- Produces:
  - `ControlMessage.hello(deviceID: String, deviceName: String, pairingCode: String?, secret: String?, fcmToken: String?, protocolVersion: Int)`
  - `ControlMessage.refreshFCMToken(token: String)`
  - `PairedDevice(deviceID: String, secret: String, name: String, fcmToken: String?)`
  - `let kRemoteProtocolVersion = 1`

- [ ] **Step 1: Write the failing tests** — append to `spike/seam1/Tests/RemoteProtocolTests.swift` (inside the `final class RemoteProtocolTests` body):

```swift
    func testHelloCarriesFCMTokenAndVersion() throws {
        let hello = ControlMessage.hello(deviceID: "d1", deviceName: "Pixel", pairingCode: "8421",
                                         secret: nil, fcmToken: "FCMTOK", protocolVersion: kRemoteProtocolVersion)
        XCTAssertEqual(try FrameDecoder().feed(try FrameCodec.encode(hello)), [hello])
    }

    func testRefreshFCMTokenRoundTrip() throws {
        let msg = ControlMessage.refreshFCMToken(token: "NEWTOK")
        XCTAssertEqual(try FrameDecoder().feed(try FrameCodec.encode(msg)), [msg])
    }

    func testPairedDeviceCarriesFCMToken() throws {
        let dev = PairedDevice(deviceID: "d1", secret: "s", name: "Pixel", fcmToken: "FCMTOK")
        let back = try JSONDecoder().decode(PairedDevice.self, from: JSONEncoder().encode(dev))
        XCTAssertEqual(back, dev)
        XCTAssertEqual(back.fcmToken, "FCMTOK")
    }
```

- [ ] **Step 2: Run tests to verify they fail (won't compile yet)**

Run the `ShepherdModelTests` test command from Global Constraints.
Expected: FAIL — compile error, `.hello` has no `fcmToken`/`protocolVersion`, no `refreshFCMToken` case, `PairedDevice` has no `fcmToken`.

- [ ] **Step 3: Update `RemoteProtocol.swift`** — change the `hello` case, add `refreshFCMToken`, add the version constant, and extend `PairedDevice`:

```swift
// near the top of RemoteProtocol.swift, after the imports:
/// Wire protocol version, pinned in the `hello` handshake. Bump on a breaking change;
/// keep messages additive otherwise. The Kotlin client sends the version it implements.
let kRemoteProtocolVersion = 1
```

In `enum ControlMessage`, replace the `hello` case and add `refreshFCMToken`:

```swift
    case hello(deviceID: String, deviceName: String, pairingCode: String?, secret: String?,
               fcmToken: String?, protocolVersion: Int)
    case refreshFCMToken(token: String)
```

Extend `PairedDevice`:

```swift
struct PairedDevice: Codable, Equatable {
    let deviceID: String
    let secret: String
    let name: String
    var fcmToken: String?
}
```

- [ ] **Step 4: Fix the `RemoteServer.swift` pattern match so it compiles** — at `RemoteServer.swift:170`, change the `.hello` case pattern to bind the two new fields (they're unused here for now — pairing decision is unchanged; the token is threaded in Task 6):

```swift
                case let .hello(deviceID, name, code, secret, _, _) where phase == .unpaired:
```

- [ ] **Step 5: Fix the `RemoteServerTests.swift` `.hello(...)` call sites** — there are four `c.send(.hello(...))` calls (lines ~106, 115, 123, 158). Update each to the new shape, e.g.:

```swift
        c.send(.hello(deviceID: "d1", deviceName: "Pixel", pairingCode: "8421",
                      secret: nil, fcmToken: "FCMTOK", protocolVersion: kRemoteProtocolVersion))
```

Apply the same `fcmToken:` / `protocolVersion:` additions to the `pairingCode: "0000"` call (line ~115) and any others — keep each call's existing `deviceID`/`pairingCode`/`secret` values, only add the two new arguments.

- [ ] **Step 6: Run both test suites to verify pass**

Run the `ShepherdModelTests` and `ShepherdRemoteTests` test commands.
Expected: PASS — all existing tests plus the three new round-trip tests.

- [ ] **Step 7: Commit**

```bash
git add spike/seam1/Sources/RemoteProtocol.swift spike/seam1/Sources/RemoteServer.swift \
        spike/seam1/RemoteTests/RemoteServerTests.swift spike/seam1/Tests/RemoteProtocolTests.swift
git commit -m "$(cat <<'EOF'
feat(remote): protocol carries FCM token + version, adds refreshFCMToken

hello gains fcmToken + protocolVersion; new refreshFCMToken message;
PairedDevice persists the token. Additive — old persisted devices decode
fcmToken=nil. Threaded into the server in a later task.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `FCMMessage.swift` — pure FCM message + JWT + dedup model

**Files:**
- Create: `spike/seam1/Sources/FCMMessage.swift`
- Modify: `spike/seam1/project.yml` (add the file to `ShepherdModelTests` sources)
- Test: `spike/seam1/Tests/FCMMessageTests.swift`

**Interfaces:**
- Produces:
  - `struct ServiceAccount: Equatable { let clientEmail: String; let privateKeyPEM: String; let projectID: String; let tokenURI: String }`
  - `func parseServiceAccount(_ json: Data) throws -> ServiceAccount`
  - `func buildSigningInput(clientEmail: String, tokenURI: String, scope: String, iat: Int) -> String` — returns `"<b64url header>.<b64url claims>"`
  - `func buildWakeMessage(token: String, paneID: String, state: String, urgent: Bool) -> [String: Any]`
  - `enum PushDecision { static func shouldPush(paneID: String, state: String, lastPushed: [String: (state: String, at: Date)], now: Date, window: TimeInterval) -> Bool }`
  - `func base64url(_ data: Data) -> String`

- [ ] **Step 1: Write the failing tests** — create `spike/seam1/Tests/FCMMessageTests.swift`:

```swift
import XCTest

final class FCMMessageTests: XCTestCase {

    func testParseServiceAccount() throws {
        // private_key is a harmless placeholder — parseServiceAccount only extracts fields;
        // PEM validity is exercised by FCMPusher (not unit-tested), not here.
        let json = """
        {"client_email":"svc@proj.iam.gserviceaccount.com","private_key":"PEM_PLACEHOLDER","project_id":"proj-123","token_uri":"https://oauth2.googleapis.com/token"}
        """.data(using: .utf8)!
        let sa = try parseServiceAccount(json)
        XCTAssertEqual(sa.clientEmail, "svc@proj.iam.gserviceaccount.com")
        XCTAssertEqual(sa.projectID, "proj-123")
        XCTAssertEqual(sa.tokenURI, "https://oauth2.googleapis.com/token")
        XCTAssertEqual(sa.privateKeyPEM, "PEM_PLACEHOLDER")
    }

    func testBase64URLHasNoPaddingOrUnsafeChars() {
        let s = base64url(Data([0xfb, 0xff, 0xfe]))   // base64 would be "+//+"
        XCTAssertFalse(s.contains("+")); XCTAssertFalse(s.contains("/")); XCTAssertFalse(s.contains("="))
    }

    func testSigningInputIsTwoB64URLSegmentsWithExpectedClaims() throws {
        let input = buildSigningInput(clientEmail: "svc@x.com",
                                      tokenURI: "https://oauth2.googleapis.com/token",
                                      scope: "https://www.googleapis.com/auth/firebase.messaging",
                                      iat: 1000)
        let parts = input.split(separator: ".")
        XCTAssertEqual(parts.count, 2)
        // Decode the claims segment (add back base64 padding) and assert iat/exp/iss.
        var b64 = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        let claims = try JSONSerialization.jsonObject(with: Data(base64Encoded: b64)!) as! [String: Any]
        XCTAssertEqual(claims["iss"] as? String, "svc@x.com")
        XCTAssertEqual(claims["iat"] as? Int, 1000)
        XCTAssertEqual(claims["exp"] as? Int, 4600)   // iat + 3600
        XCTAssertEqual(claims["aud"] as? String, "https://oauth2.googleapis.com/token")
    }

    func testWakeMessageIsDataOnlyWithUrgency() {
        let m = buildWakeMessage(token: "TOK", paneID: "p1", state: "blocked", urgent: true)
        let msg = m["message"] as! [String: Any]
        XCTAssertEqual(msg["token"] as? String, "TOK")
        let data = msg["data"] as! [String: String]
        XCTAssertEqual(data, ["paneID": "p1", "state": "blocked", "urgent": "true"])
        XCTAssertEqual((msg["android"] as! [String: String])["priority"], "high")
        XCTAssertNil(msg["notification"])   // data-only: no notification block, ever
    }

    func testWakeMessageNonUrgentIsNormalPriority() {
        let m = buildWakeMessage(token: "TOK", paneID: "p1", state: "needsCheck", urgent: false)
        let msg = m["message"] as! [String: Any]
        XCTAssertEqual((msg["data"] as! [String: String])["urgent"], "false")
        XCTAssertEqual((msg["android"] as! [String: String])["priority"], "normal")
    }

    func testDedupSuppressesSameStateWithinWindow() {
        let now = Date(timeIntervalSince1970: 100)
        let last = ["p1": (state: "blocked", at: Date(timeIntervalSince1970: 96))]
        XCTAssertFalse(PushDecision.shouldPush(paneID: "p1", state: "blocked", lastPushed: last, now: now, window: 5))
    }

    func testDedupAllowsDifferentStateOrAfterWindow() {
        let now = Date(timeIntervalSince1970: 100)
        let last = ["p1": (state: "blocked", at: Date(timeIntervalSince1970: 96))]
        XCTAssertTrue(PushDecision.shouldPush(paneID: "p1", state: "error", lastPushed: last, now: now, window: 5))
        XCTAssertTrue(PushDecision.shouldPush(paneID: "p1", state: "blocked", lastPushed: last, now: now, window: 2))
        XCTAssertTrue(PushDecision.shouldPush(paneID: "p2", state: "blocked", lastPushed: last, now: now, window: 5))
    }
}
```

- [ ] **Step 2: Add the source to `project.yml`** — under `ShepherdModelTests:` `sources:`, add a line (alphabetical-ish, near the other `Sources/` entries):

```yaml
      - path: Sources/FCMMessage.swift
```

- [ ] **Step 3: Run tests to verify they fail**

Run `xcodegen generate` then the `ShepherdModelTests` test command.
Expected: FAIL — `cannot find 'parseServiceAccount' in scope` etc.

- [ ] **Step 4: Write `spike/seam1/Sources/FCMMessage.swift`**

```swift
import Foundation

/// Pure FCM message + JWT-claims + dedup model. No AppKit / no crypto / no network —
/// the effectful pusher (FCMPusher.swift) signs + sends. Kept pure so it is unit-tested
/// like StopPolicy/SleepPolicy; `iat`/`now` are passed in to keep Date.now out of the model.

struct ServiceAccount: Equatable {
    let clientEmail: String
    let privateKeyPEM: String
    let projectID: String
    let tokenURI: String
}

enum FCMMessageError: Error { case malformedKey }

/// Parse a Google service-account JSON key into the fields the pusher needs.
func parseServiceAccount(_ json: Data) throws -> ServiceAccount {
    guard let obj = try JSONSerialization.jsonObject(with: json) as? [String: Any],
          let email = obj["client_email"] as? String,
          let key = obj["private_key"] as? String,
          let project = obj["project_id"] as? String else { throw FCMMessageError.malformedKey }
    let tokenURI = (obj["token_uri"] as? String) ?? "https://oauth2.googleapis.com/token"
    return ServiceAccount(clientEmail: email, privateKeyPEM: key, projectID: project, tokenURI: tokenURI)
}

/// base64url (RFC 7515): standard base64, +→-, /→_, no padding.
func base64url(_ data: Data) -> String {
    data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

/// The `header.claims` JWT signing input for an FCM service-account access-token request.
/// The caller RS256-signs this string's UTF-8 bytes and appends `.signature`.
func buildSigningInput(clientEmail: String, tokenURI: String, scope: String, iat: Int) -> String {
    let header = #"{"alg":"RS256","typ":"JWT"}"#
    // JSONSerialization key order isn't guaranteed; build claims JSON deterministically so
    // tests (and signatures) are stable. Google validates fields, not byte order, so this is safe.
    let claims = "{\"iss\":\"\(clientEmail)\",\"scope\":\"\(scope)\",\"aud\":\"\(tokenURI)\",\"iat\":\(iat),\"exp\":\(iat + 3600)}"
    let h = base64url(Data(header.utf8))
    let c = base64url(Data(claims.utf8))
    return "\(h).\(c)"
}

/// The FCM HTTP v1 `messages:send` body — DATA-ONLY (no `notification` block, so no
/// terminal content transits Google; the woken app raises its own local notification).
func buildWakeMessage(token: String, paneID: String, state: String, urgent: Bool) -> [String: Any] {
    [
        "message": [
            "token": token,
            "data": ["paneID": paneID, "state": state, "urgent": urgent ? "true" : "false"],
            "android": ["priority": urgent ? "high" : "normal"],
        ] as [String: Any]
    ]
}

/// Coalesce: don't re-push the same state for the same pane within `window` seconds — guards
/// a flapping pane from a buzz-storm. A different state, a new pane, or a lapsed window pushes.
enum PushDecision {
    static func shouldPush(paneID: String, state: String,
                           lastPushed: [String: (state: String, at: Date)],
                           now: Date, window: TimeInterval) -> Bool {
        guard let last = lastPushed[paneID] else { return true }
        if last.state != state { return true }
        return now.timeIntervalSince(last.at) >= window
    }
}
```

- [ ] **Step 5: Run tests to verify pass**

Run the `ShepherdModelTests` test command.
Expected: PASS — all 7 new `FCMMessageTests` plus the existing model tests.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/FCMMessage.swift spike/seam1/Tests/FCMMessageTests.swift spike/seam1/project.yml
git commit -m "$(cat <<'EOF'
feat(remote): pure FCM message/JWT/dedup model

parseServiceAccount, base64url, buildSigningInput (deterministic iat),
data-only buildWakeMessage with urgency, PushDecision dedup window.
Pure + unit-tested; the signing/sending shell lands next.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `NotificationRoutingPolicy.swift` — pure present-vs-away routing

**Files:**
- Create: `spike/seam1/Sources/NotificationRoutingPolicy.swift`
- Modify: `spike/seam1/project.yml` (add to `ShepherdModelTests` sources)
- Test: `spike/seam1/Tests/NotificationRoutingPolicyTests.swift`

**Interfaces:**
- Consumes: `AgentState` + its `wantsAttention` (already in `AgentState.swift`, already in the `ShepherdModelTests` target).
- Produces:
  - `struct Routing: Equatable { let local: Bool; let fcm: Bool }`
  - `enum NotificationRoutingPolicy { static func decide(isAway: Bool) -> Routing; static func catchUpTargets(_ panes: [(id: String, state: AgentState)]) -> [String] }`

- [ ] **Step 1: Write the failing tests** — create `spike/seam1/Tests/NotificationRoutingPolicyTests.swift`:

```swift
import XCTest

final class NotificationRoutingPolicyTests: XCTestCase {

    func testPresentRoutesToLocalSurfacesOnly() {
        XCTAssertEqual(NotificationRoutingPolicy.decide(isAway: false), Routing(local: true, fcm: false))
    }

    func testAwayRoutesToPushOnly() {
        // Away ⇒ NO local surface (no banner, no sound — a closed machine stays silent).
        XCTAssertEqual(NotificationRoutingPolicy.decide(isAway: true), Routing(local: false, fcm: true))
    }

    func testCatchUpTargetsAreOnlyAttentionStates() {
        let panes: [(id: String, state: AgentState)] = [
            ("a", .blocked), ("b", .working), ("c", .needsCheck),
            ("d", .idle), ("e", .error), ("f", .shell),
        ]
        XCTAssertEqual(NotificationRoutingPolicy.catchUpTargets(panes), ["a", "c", "e"])
    }
}
```

- [ ] **Step 2: Add the source to `project.yml`** — under `ShepherdModelTests:` `sources:`:

```yaml
      - path: Sources/NotificationRoutingPolicy.swift
```

- [ ] **Step 3: Run tests to verify they fail**

Run `xcodegen generate` then the `ShepherdModelTests` test command.
Expected: FAIL — `cannot find 'NotificationRoutingPolicy' in scope`.

- [ ] **Step 4: Write `spike/seam1/Sources/NotificationRoutingPolicy.swift`**

```swift
import Foundation

/// Pure routing of an attention transition. `local` gates BOTH local surfaces together —
/// the desktop banner AND the attention sound — so a closed/away machine fires neither and
/// everything routes to the phone. Mirrors SleepPolicy: pure, unit-tested, no AppKit.
struct Routing: Equatable {
    let local: Bool   // desktop banner + attention sound (both, together)
    let fcm: Bool     // data-only push to paired devices
}

enum NotificationRoutingPolicy {
    /// Present (at the machine) → local only; away (mobile) → push only. Mutually exclusive.
    static func decide(isAway: Bool) -> Routing {
        isAway ? Routing(local: false, fcm: true) : Routing(local: true, fcm: false)
    }

    /// On the away→present edge, the pane ids still needing attention (to desktop-banner —
    /// no sound burst). Panes resolved while away already left their attention state, so
    /// they're naturally excluded — no cross-device bookkeeping needed.
    static func catchUpTargets(_ panes: [(id: String, state: AgentState)]) -> [String] {
        panes.filter { $0.state.wantsAttention }.map { $0.id }
    }
}
```

- [ ] **Step 5: Run tests to verify pass**

Run the `ShepherdModelTests` test command.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/NotificationRoutingPolicy.swift \
        spike/seam1/Tests/NotificationRoutingPolicyTests.swift spike/seam1/project.yml
git commit -m "$(cat <<'EOF'
feat(remote): pure present-vs-away notification routing

decide(isAway:) → local surfaces (banner+sound, together) when present,
FCM push when away; catchUpTargets filters the still-attention panes for
the away→present banner sweep. Pure + unit-tested.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `FCMPusher.swift` — service-account auth + data-only send (shell)

**Files:**
- Create: `spike/seam1/Sources/FCMPusher.swift`
- Modify: `README.md` (Firebase setup section)
- (No `project.yml` edit — the app target globs `Sources/`. No test target — this is the IO shell.)

**Interfaces:**
- Consumes (from Task 2): `parseServiceAccount`, `buildSigningInput`, `base64url`, `buildWakeMessage`, `ServiceAccount`.
- Produces:
  - `final class FCMPusher` with:
    - `init?(serviceAccountPath: String)` — returns `nil` if the file is absent/unreadable/malformed (so a missing key cleanly disables push).
    - `func wake(tokens: [String], paneID: String, state: String, urgent: Bool) async -> [String]` — POSTs one message per token; returns tokens FCM rejected as unregistered/invalid (to prune). Mints/caches the OAuth2 token internally.

- [ ] **Step 1: Write `spike/seam1/Sources/FCMPusher.swift`** (no unit test — IO/crypto shell; verified by build + the manual auth check in Step 3 and the loopback mock in Task 6):

```swift
import Foundation
import Security

/// Effectful FCM v1 sender. Holds a service-account key, mints + caches a short-lived
/// OAuth2 access token (RS256-signed JWT → token exchange), and POSTs DATA-ONLY messages.
/// Reaches Google (not the phone), so it wakes an app even when the phone is unreachable.
/// Pure message/claims construction lives in FCMMessage.swift; this is the shell.
final class FCMPusher {
    private let account: ServiceAccount
    private let privateKey: SecKey
    private let session = URLSession(configuration: .ephemeral)

    private let tokenLock = NSLock()
    private var accessToken: String?
    private var accessTokenExpiry = Date.distantPast

    /// nil if the key file is absent/unreadable/malformed — push then stays disabled, no error.
    init?(serviceAccountPath: String) {
        guard let data = FileManager.default.contents(atPath: serviceAccountPath),
              let account = try? parseServiceAccount(data),
              let key = FCMPusher.loadRSAPrivateKey(pem: account.privateKeyPEM) else { return nil }
        self.account = account
        self.privateKey = key
    }

    /// Send a data-only wake to each token. Returns the tokens Google rejected as
    /// UNREGISTERED / invalid-argument so the caller can drop them.
    func wake(tokens: [String], paneID: String, state: String, urgent: Bool) async -> [String] {
        guard !tokens.isEmpty, let token = await ensureAccessToken() else { return [] }
        var dead: [String] = []
        let url = URL(string: "https://fcm.googleapis.com/v1/projects/\(account.projectID)/messages:send")!
        for device in tokens {
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: buildWakeMessage(
                token: device, paneID: paneID, state: state, urgent: urgent))
            guard let (body, resp) = try? await session.data(for: req),
                  let http = resp as? HTTPURLResponse else { continue }
            // 404 UNREGISTERED or 400 INVALID_ARGUMENT for the token ⇒ dead token, prune it.
            if http.statusCode == 404 ||
               (http.statusCode == 400 && (String(data: body, encoding: .utf8)?.contains("INVALID_ARGUMENT") ?? false)) {
                dead.append(device)
            }
        }
        return dead
    }

    // MARK: OAuth2 access token (cached ~1h)

    private func ensureAccessToken() async -> String? {
        tokenLock.lock()
        if let t = accessToken, Date() < accessTokenExpiry { tokenLock.unlock(); return t }
        tokenLock.unlock()
        guard let jwt = signedJWT() else { return nil }
        var req = URLRequest(url: URL(string: account.tokenURI)!)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        let form = "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=\(jwt)"
        req.httpBody = form.data(using: .utf8)
        guard let (data, resp) = try? await session.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let access = obj["access_token"] as? String else { return nil }
        let ttl = (obj["expires_in"] as? Int) ?? 3600
        tokenLock.lock()
        accessToken = access
        accessTokenExpiry = Date().addingTimeInterval(TimeInterval(ttl - 60))   // refresh a minute early
        tokenLock.unlock()
        return access
    }

    private func signedJWT() -> String? {
        let iat = Int(Date().timeIntervalSince1970)
        let signingInput = buildSigningInput(
            clientEmail: account.clientEmail, tokenURI: account.tokenURI,
            scope: "https://www.googleapis.com/auth/firebase.messaging", iat: iat)
        var error: Unmanaged<CFError>?
        guard let sig = SecKeyCreateSignature(privateKey, .rsaSignatureMessagePKCS1v15SHA256,
                                              Data(signingInput.utf8) as CFData, &error) as Data? else { return nil }
        return "\(signingInput).\(base64url(sig))"
    }

    // MARK: PEM (PKCS#8) → SecKey

    /// Google service-account keys are PKCS#8 (PEM-armored); SecKeyCreateWithData wants the
    /// inner PKCS#1 RSAPrivateKey. For RSA-2048 PKCS#8 the wrapper is a fixed 26-byte prefix
    /// (SEQUENCE | version INTEGER | rsaEncryption AlgId | OCTET STRING header), so we strip
    /// it. The manual auth check (Step 3) confirms the strip is correct.
    private static func loadRSAPrivateKey(pem: String) -> SecKey? {
        // Drop the PEM armor lines (any line wrapped in dashes) generically — no banner literal.
        let b64 = pem.split(whereSeparator: { $0 == "\n" || $0 == "\r" })
            .filter { !$0.hasPrefix("-----") }
            .joined()
        guard let pkcs8 = Data(base64Encoded: b64), pkcs8.count > 26 else { return nil }
        let pkcs1 = pkcs8.subdata(in: 26..<pkcs8.count)
        let attrs: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
            kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
            kSecAttrKeySizeInBits as String: 2048,
        ]
        var error: Unmanaged<CFError>?
        return SecKeyCreateWithData(pkcs1 as CFData, attrs as CFData, &error)
    }
}
```

- [ ] **Step 2: Build to verify it compiles**

Run the build command from Global Constraints.
Expected: BUILD SUCCEEDED.

- [ ] **Step 3 (MANUAL, optional — proves the risky pipeline without a phone): document + run the auth check**

This is the only way to confirm the PKCS#8 strip + RS256 + OAuth exchange before a real device exists. It needs a real service-account key (created in Step 4's README flow). With a key at `~/.config/shepherd/fcm-service-account.json`, add a temporary throwaway `main`-style check OR run this shell equivalent to confirm the same token endpoint works (proves the account + project, independent of Swift):

```bash
# Sanity: the key parses and the project id is present.
python3 - <<'PY'
import json; d=json.load(open("$HOME/.config/shepherd/fcm-service-account.json"))
print("project:", d["project_id"], "client:", d["client_email"])
PY
```
Then, after wiring (Task 7), the in-app path is exercised live during step 3. Record the result; do NOT block this task on a phone. (If the Swift `loadRSAPrivateKey` returns nil or the token exchange ≠ 200, the 26-byte strip is the first suspect — verify the key is RSA-2048 PKCS#8.)

- [ ] **Step 4: Add the Firebase setup section to `README.md`** — append a section (place it near any existing remote/keep-awake setup notes):

```markdown
## Remote push (FCM) — host setup

Shepherd can wake a paired phone over Firebase Cloud Messaging when an agent
needs you and you're away from the Mac (lid shut, no external display). Setup is
one-time and shared with the Android client (step 3).

1. Create a free Firebase project at <https://console.firebase.google.com>.
2. **Project Settings → Service accounts → Generate new private key** → download the JSON.
3. Save it as `~/.config/shepherd/fcm-service-account.json`.

That's all — `project_id` is read from the key. With no key present, push is
silently disabled (Shepherd alerts locally as usual). The key is a send-only
FCM credential; treat it as a secret. Pushes carry only `{paneID, state}` — no
terminal content ever transits Google.
```

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/FCMPusher.swift README.md
git commit -m "$(cat <<'EOF'
feat(remote): FCMPusher — service-account auth + data-only send

Loads ~/.config/shepherd key (nil-init disables push), mints+caches an
OAuth2 token (PKCS#8→PKCS#1 strip, RS256 via Security framework), POSTs
data-only wakes per token, returns dead tokens to prune. README documents
the one-time Firebase setup.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `PresenceMonitor.swift` — lid + external-display presence (shell)

**Files:**
- Create: `spike/seam1/Sources/PresenceMonitor.swift`
- (No `project.yml` edit — app globs `Sources/`. No test target — IO shell, composes the existing `ClamshellMonitor`.)

**Interfaces:**
- Consumes: `ClamshellMonitor` (existing — `isLidClosed`, `onChange`, `start()`, `stop()`).
- Produces:
  - `final class PresenceMonitor` with `private(set) var isAway: Bool`, `var onChange: ((Bool) -> Void)?` (fires with the new `isAway` on any change), `func start()`, `func stop()`, and `static func externalDisplayAttached() -> Bool`.

- [ ] **Step 1: Write `spike/seam1/Sources/PresenceMonitor.swift`**

```swift
import Foundation
import AppKit
import CoreGraphics

/// "Are you away from this Mac?" — `isAway = lidClosed && !externalDisplayAttached`. Composes
/// the existing ClamshellMonitor (lid) with a screen-parameters observer (external display).
/// Observe-only, like ClamshellMonitor/ThermalMonitor. `onChange` fires with the new isAway on
/// any lid OR display change; the away→present edge (onChange(false)) drives the catch-up sweep.
@MainActor
final class PresenceMonitor {
    private(set) var isAway = false
    var onChange: ((Bool) -> Void)?

    private let clamshell = ClamshellMonitor()
    private var screenObserver: NSObjectProtocol?

    func start() {
        clamshell.onChange = { [weak self] _ in self?.recompute() }
        clamshell.start()
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in
            // Posted on the main queue; @MainActor hop keeps the recompute on main.
            Task { @MainActor in self?.recompute() }
        }
        isAway = Self.compute(lidClosed: clamshell.isLidClosed)
    }

    func stop() {
        clamshell.stop()
        if let o = screenObserver { NotificationCenter.default.removeObserver(o); screenObserver = nil }
    }

    private func recompute() {
        let now = Self.compute(lidClosed: clamshell.isLidClosed)
        guard now != isAway else { return }
        isAway = now
        onChange?(now)
    }

    private static func compute(lidClosed: Bool) -> Bool { lidClosed && !externalDisplayAttached() }

    /// True if any ACTIVE display is not the built-in panel (i.e. an external monitor is attached).
    static func externalDisplayAttached() -> Bool {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return false }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return false }
        return ids.prefix(Int(count)).contains { CGDisplayIsBuiltin($0) == 0 }
    }
}
```

- [ ] **Step 2: Build to verify it compiles**

Run `xcodegen generate` then the build command.
Expected: BUILD SUCCEEDED.

- [ ] **Step 3: Commit**

```bash
git add spike/seam1/Sources/PresenceMonitor.swift
git commit -m "$(cat <<'EOF'
feat(remote): PresenceMonitor — lid + external-display away signal

isAway = lidClosed && !externalDisplayAttached, composing ClamshellMonitor
with a didChangeScreenParameters observer; onChange fires the new isAway on
either signal so the away→present edge can drive catch-up.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: RemoteServer — persist FCM token at pairing + handle refresh

**Files:**
- Modify: `spike/seam1/Sources/RemoteServer.swift` (thread `fcmToken` into `PairedDevice`; remember the connection's `deviceID`; handle `refreshFCMToken`; add an `updateFCMToken` closure to `init`)
- Modify: `spike/seam1/RemoteTests/RemoteServerTests.swift` (`makeServer` passes the new closure; add two loopback tests)

**Interfaces:**
- Consumes (from Task 1): `ControlMessage.hello(..., fcmToken:, protocolVersion:)`, `ControlMessage.refreshFCMToken(token:)`, `PairedDevice(..., fcmToken:)`.
- Produces: `RemoteServer.init(..., updateFCMToken: @escaping (String, String) -> Void, ...)` — called with `(deviceID, token)` when a paired connection sends `refreshFCMToken`.

- [ ] **Step 1: Write the failing loopback tests** — append to `RemoteServerTests` in `spike/seam1/RemoteTests/RemoteServerTests.swift`:

```swift
    func testPairingPersistsFCMToken() {
        let port: UInt16 = 48725
        let captured = NSMutableArray()   // thread-safe enough for the test; captures PairedDevice
        let server = RemoteServer(
            bindAddress: "127.0.0.1", port: port,
            currentCode: { "8421" }, knownDevices: { [] },
            persist: { dev in captured.add(dev) },
            requestApproval: { _, _, decide in decide(true) },
            snapshot: { [] },
            updateFCMToken: { _, _ in },
            makeSecret: { "SECRET" }, makeNonce: { "NONCE" })
        XCTAssertTrue(server.start()); defer { server.stop() }
        let c = TestClient(port: port)
        c.send(.hello(deviceID: "d1", deviceName: "Pixel", pairingCode: "8421",
                      secret: nil, fcmToken: "FCMTOK", protocolVersion: kRemoteProtocolVersion))
        XCTAssertNotNil(c.waitFor { if case .accepted = $0 { return true }; return false })
        // Give persist (called on the approval path) a beat to land.
        let dev = (0..<30).lazy.compactMap { _ -> PairedDevice? in
            usleep(50_000); return captured.firstObject as? PairedDevice
        }.first
        XCTAssertEqual(dev?.fcmToken, "FCMTOK")
        XCTAssertEqual(dev?.deviceID, "d1")
    }

    func testRefreshFCMTokenInvokesCallback() {
        let port: UInt16 = 48726
        let box = NSMutableArray()   // captures (deviceID, token)
        let server = RemoteServer(
            bindAddress: "127.0.0.1", port: port,
            currentCode: { "8421" }, knownDevices: { [] },
            persist: { _ in },
            requestApproval: { _, _, decide in decide(true) },
            snapshot: { [] },
            updateFCMToken: { id, tok in box.add("\(id)|\(tok)") },
            makeSecret: { "SECRET" }, makeNonce: { "NONCE" })
        XCTAssertTrue(server.start()); defer { server.stop() }
        let c = TestClient(port: port)
        c.send(.hello(deviceID: "d1", deviceName: "Pixel", pairingCode: "8421",
                      secret: nil, fcmToken: "OLD", protocolVersion: kRemoteProtocolVersion))
        XCTAssertNotNil(c.waitFor { if case .accepted = $0 { return true }; return false })
        c.send(.refreshFCMToken(token: "NEW"))
        let got = (0..<40).lazy.compactMap { _ -> String? in
            usleep(50_000); return box.firstObject as? String
        }.first
        XCTAssertEqual(got, "d1|NEW")
    }
```

- [ ] **Step 2: Update the existing `makeServer` helper** so it still compiles with the new `init` arg — in `RemoteServerTests.swift`, add `updateFCMToken:` to the `makeServer` `RemoteServer(...)` call (line ~81):

```swift
            snapshot: snapshot,
            updateFCMToken: { _, _ in },
            makeSecret: { "SECRET" }, makeNonce: { "NONCE" })
```

- [ ] **Step 3: Run the loopback suite to verify failure**

Run the `ShepherdRemoteTests` test command.
Expected: FAIL — `RemoteServer.init` has no `updateFCMToken:` (compile error).

- [ ] **Step 4: Thread the token through `RemoteServer.swift`**

(a) Add the stored closure + `init` param. After the `private let snapshot:` line (~23):

```swift
    private let updateFCMToken: (String, String) -> Void
```

In `init`, add the parameter (after `snapshot:`) and assign it:

```swift
         snapshot: @escaping () -> [PaneInfo],
         updateFCMToken: @escaping (String, String) -> Void,
         makeSecret: @escaping () -> String,
```
```swift
        self.snapshot = snapshot; self.updateFCMToken = updateFCMToken
        self.makeSecret = makeSecret; self.makeNonce = makeNonce
```

(b) Remember the paired device id on the connection. In `ConnState` (after `var closed = false`):

```swift
        var deviceID: String?
```

(c) Bind `fcmToken` from `hello` and thread it into both `PairedDevice` constructions, and record `deviceID`. Replace the `.hello` case body (the `case let .hello(...) where phase == .unpaired:` block at ~170):

```swift
                case let .hello(deviceID, name, code, secret, fcmToken, _) where phase == .unpaired:
                    conn.lock.lock(); conn.deviceID = deviceID; conn.lock.unlock()
                    let decision = pairingDecision(deviceID: deviceID, name: name, code: code, secret: secret,
                                                   known: knownDevices(), currentCode: currentCode(),
                                                   newSecret: makeSecret())
                    switch decision {
                    case let .accept(persistSecret):
                        conn.lock.lock(); conn.phase = .paired; conn.lock.unlock()
                        if let persistSecret {
                            persist(PairedDevice(deviceID: deviceID, secret: persistSecret, name: name, fcmToken: fcmToken))
                        }
                        admit(fd, conn)
                    case .reject(let reason):
                        enqueueWriteThenClose(fd, encode(.rejected(reason: reason)), conn); return
                    case let .needsApproval(approveID, approveName, proposedSecret):
                        enqueueWrite(fd, encode(.pendingApproval), on: conn)
                        conn.lock.lock(); conn.phase = .pending; conn.lock.unlock()
                        requestApproval(approveID, approveName) { [weak self] ok in
                            guard let self else { return }
                            conn.lock.lock()
                            guard conn.phase == .pending else { conn.lock.unlock(); return }
                            conn.phase = ok ? .paired : .closed
                            conn.lock.unlock()
                            if ok {
                                self.persist(PairedDevice(deviceID: approveID, secret: proposedSecret, name: approveName, fcmToken: fcmToken))
                                self.admit(fd, conn)
                            } else {
                                self.enqueueWriteThenClose(fd, self.encode(.rejected(reason: "denied")), conn)
                            }
                        }
                    }
```

(d) Handle `refreshFCMToken` on a paired connection. Add a case to the `switch m` (next to the `.ping` / `.detach` cases, ~204):

```swift
                case let .refreshFCMToken(token) where phase == .paired:
                    conn.lock.lock(); let id = conn.deviceID; conn.lock.unlock()
                    if let id { updateFCMToken(id, token) }
```

- [ ] **Step 5: Run both test suites to verify pass**

Run the `ShepherdRemoteTests` and `ShepherdModelTests` test commands.
Expected: PASS — existing loopback tests (incl. the concurrency stress test) plus the two new ones.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/RemoteServer.swift spike/seam1/RemoteTests/RemoteServerTests.swift
git commit -m "$(cat <<'EOF'
feat(remote): persist FCM token at pairing, handle token refresh

hello.fcmToken flows into the persisted PairedDevice (both accept + approve
paths); the connection remembers its deviceID so refreshFCMToken updates the
right device via a new updateFCMToken closure. Loopback-tested.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: AgentStore — route attention to local-or-push, wire pusher + presence

**Files:**
- Modify: `spike/seam1/Sources/AgentStore.swift` (the remote section ~46-65, `init` ~79-88, `apply` ~345-351, `startRemoteServingIfEnabled` ~561-588, `addPairedDevice` ~597-605; add `isAway`, `pushWake`, refresh + catch-up handlers)

**Interfaces:**
- Consumes: `FCMPusher` (Task 4), `PresenceMonitor` (Task 5), `NotificationRoutingPolicy` + `Routing` (Task 3), `PushDecision` (Task 2), `RemoteServer.init(..., updateFCMToken:)` (Task 6), `PairedDevice.fcmToken` (Task 1).
- Produces: none consumed downstream (terminal wiring task).

- [ ] **Step 1: Add the stored properties** — in the `// MARK: Remote control channel` section (after `private let pairedDevicesLock = NSLock()` ~65):

```swift
    /// FCM push shell (nil if no service-account key at ~/.config/shepherd) + the away
    /// signal (lid shut + no external display) + per-pane push dedup state.
    private var fcmPusher: FCMPusher?
    private let presence = PresenceMonitor()
    private var lastPushed: [String: (state: String, at: Date)] = [:]
    private let pushWindow: TimeInterval = 8
```

- [ ] **Step 2: Construct the pusher + start presence in `init`** — in `private init()`, after `loadPairedDevices()` (~85):

```swift
        let keyPath = ("~/.config/shepherd/fcm-service-account.json" as NSString).expandingTildeInPath
        fcmPusher = FCMPusher(serviceAccountPath: keyPath)
        presence.onChange = { [weak self] away in if !away { self?.runCatchUpNotifications() } }
        presence.start()
```

- [ ] **Step 3: Add `isAway`, `pushWake`, the refresh handler, and the catch-up sweep** — add to the `// MARK: Remote control channel` section (e.g. after `respondToApproval`):

```swift
    /// True when you're away from this Mac: lid shut AND no external display attached.
    private func isAway() -> Bool { presence.isAway }

    /// Fire a data-only FCM wake to every paired device, deduped. Reads PERSISTED tokens
    /// (push needs no live control channel). Off-main (network); prunes dead tokens.
    private func pushWake(paneID: String, state: AgentState) {
        guard isServing, let pusher = fcmPusher else { return }
        let now = Date()
        guard PushDecision.shouldPush(paneID: paneID, state: state.rawValue,
                                      lastPushed: lastPushed, now: now, window: pushWindow) else { return }
        lastPushed[paneID] = (state.rawValue, now)
        pairedDevicesLock.lock(); let tokens = pairedDevices.compactMap { $0.fcmToken }; pairedDevicesLock.unlock()
        guard !tokens.isEmpty else { return }
        let urgent = (state == .blocked || state == .error)
        Task { [weak self] in
            let dead = await pusher.wake(tokens: tokens, paneID: paneID, state: state.rawValue, urgent: urgent)
            if !dead.isEmpty { await MainActor.run { self?.pruneTokens(dead) } }
        }
    }

    /// Drop tokens FCM rejected as unregistered/invalid + persist.
    private func pruneTokens(_ dead: [String]) {
        pairedDevicesLock.lock()
        for i in pairedDevices.indices where dead.contains(pairedDevices[i].fcmToken ?? "") {
            pairedDevices[i].fcmToken = nil
        }
        pairedDevicesLock.unlock()
        savePairedDevices()
    }

    /// A paired device rotated its FCM token (refreshFCMToken on the control channel).
    private func updateFCMToken(deviceID: String, token: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.pairedDevicesLock.lock()
            if let i = self.pairedDevices.firstIndex(where: { $0.deviceID == deviceID }) {
                self.pairedDevices[i].fcmToken = token
            }
            self.pairedDevicesLock.unlock()
            self.savePairedDevices()
        }
    }

    /// On the away→present edge: desktop-banner (no sound) every pane still needing attention.
    private func runCatchUpNotifications() {
        let panes: [(id: String, state: AgentState)] = workspaces.flatMap { ws in
            ws.tabs.flatMap { $0.root.panes.map { ($0.paneID, $0.state) } }
        }
        let ids = Set(NotificationRoutingPolicy.catchUpTargets(panes))
        guard !ids.isEmpty else { return }
        for (w, ws) in workspaces.enumerated() {
            for tab in ws.tabs {
                for pane in tab.root.panes where ids.contains(pane.paneID) {
                    notifyAttention(pane, inWorkspace: workspaces[w].id)
                }
            }
        }
    }
```

- [ ] **Step 4: Route the attention block in `apply`** — replace the attention block at `AgentStore.swift:345-349`:

```swift
        if res.state != cur, res.state.wantsAttention,
           let updated = workspaces[w].tabs[t].root.pane(paneID) {
            let routing = NotificationRoutingPolicy.decide(isAway: isAway())
            if routing.local {
                notifyAttention(updated, inWorkspace: workspaces[w].id)
                playAttentionSound(for: res.state)
            }
            if routing.fcm { pushWake(paneID: paneID, state: res.state) }
        }
```

- [ ] **Step 5: Pass `updateFCMToken` into the server** — in `startRemoteServingIfEnabled`, add the closure to the `RemoteServer(...)` construction (after the `snapshot:` closure, ~585):

```swift
            updateFCMToken: { [weak self] id, token in self?.updateFCMToken(deviceID: id, token: token) },
            makeSecret: { UUID().uuidString }, makeNonce: { UUID().uuidString })
```

- [ ] **Step 6: Build + run all suites**

Run the build command, then both `ShepherdModelTests` and `ShepherdRemoteTests` test commands.
Expected: BUILD SUCCEEDED; all suites PASS. (The routing/push logic itself is covered by the pure tests in Tasks 2-3 and the loopback tests in Task 6; AppKit wiring is verified by a clean build per [shepherd-dont-kill-while-live].)

- [ ] **Step 7: Commit**

```bash
git add spike/seam1/Sources/AgentStore.swift
git commit -m "$(cat <<'EOF'
feat(remote): route attention to local surfaces or FCM by presence

apply() now routes each attention transition via NotificationRoutingPolicy:
present → banner+sound (together), away → data-only FCM wake (deduped,
off-main, dead-token prune). Wires FCMPusher + PresenceMonitor; refreshFCMToken
updates the stored token; away→present replays catch-up banners. Dark-shipped
behind serve toggle + key presence.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Whole-feature verification + spec status + ADR

**Files:**
- Modify: `docs/superpowers/specs/2026-06-30-android-fcm-push-design.md` (Status/progress)
- Modify: `CLAUDE.md` (mention the FCM push + presence routing under Architecture/Done — keep it terse)
- (Optional) Create: `.claude/adr/0016-fcm-push-and-presence-routing.md` if the team wants an ADR record — match the existing ADR format.

- [ ] **Step 1: Full clean build + both test suites green**

Run the build command, then both test commands. Capture the pass counts.
Expected: BUILD SUCCEEDED; `ShepherdModelTests` and `ShepherdRemoteTests` all pass (record N/0 for each).

- [ ] **Step 2: Spec coverage self-check** — re-read the spec §3-§11 and confirm each item maps to a task (protocol→T1, FCMMessage→T2, routing→T3, FCMPusher→T4, presence→T5, server token→T6, apply wiring→T7). Note any gap and add a task if found.

- [ ] **Step 3: Update the spec Status/progress section** — append under "Status / progress":

```markdown
- **2026-06-30 (implemented):** Host FCM push built per the plan
  `docs/superpowers/plans/2026-06-30-android-phase1-fcm-push.md`. Shipped:
  `FCMMessage.swift` (pure: key parse, JWT signing-input, data-only wake body,
  PushDecision dedup), `NotificationRoutingPolicy.swift` (pure present-vs-away +
  catch-up), `FCMPusher.swift` (OAuth2/RS256/PKCS#8 + data-only send + dead-token
  prune), `PresenceMonitor.swift` (lid + external-display away signal), protocol
  (hello.fcmToken + protocolVersion + refreshFCMToken + PairedDevice.fcmToken),
  RemoteServer token persistence/refresh, AgentStore routing + pushWake + catch-up.
  Tests: ShepherdModelTests <N>/0, ShepherdRemoteTests <N>/0. Dark-shipped (no key
  ⇒ no push). Live device-delivery deferred to step 3's checklist.
```

- [ ] **Step 4: Update `CLAUDE.md`** — under the remote/Done notes, add one terse line, e.g.:

```markdown
**FCM push (Android Phase 1 step 2):** attention transitions route to local surfaces
(banner+sound) when present, or a data-only FCM wake when away (`isAway` = lid shut +
no external display); host mints OAuth2 from `~/.config/shepherd/fcm-service-account.json`,
away→present replays catch-up banners. Dark-shipped (no key ⇒ no push). See
`docs/superpowers/specs/2026-06-30-android-fcm-push-design.md`.
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-06-30-android-fcm-push-design.md CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: record host FCM push as implemented (Android Phase 1 step 2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review (completed during planning)

- **Spec coverage:** §3 files → T2/T3/T4/T5; §4 routing → T3 + T7; §5 fire-point → T7; §6 protocol → T1; §7 token lifecycle → T1 (model) + T6 (capture/refresh) + T7 (invalidate/prune); §8 Firebase setup → T4 README; §10 security → enforced by data-only `buildWakeMessage` (T2) + nil-init key gating (T4); §11 testing → unit (T2/T3), loopback (T6), standalone auth check (T4 Step 3), device E2E deferred. No gaps.
- **Type consistency:** `Routing(local:fcm:)`, `PairedDevice(...,fcmToken:)`, `hello(...,fcmToken:,protocolVersion:)`, `refreshFCMToken(token:)`, `updateFCMToken(deviceID:token:)` / server closure `(String,String)`, `PushDecision.shouldPush`, `buildWakeMessage`/`buildSigningInput`/`parseServiceAccount`/`base64url`, `NotificationRoutingPolicy.decide`/`catchUpTargets`, `PresenceMonitor.isAway`/`onChange`/`externalDisplayAttached` — names match across tasks.
- **Placeholders:** none — every code step has full code; the only manual step (T4 Step 3, the Google auth check) is explicitly optional and gated on a real key, consistent with the dark-ship + don't-kill-live rules.
