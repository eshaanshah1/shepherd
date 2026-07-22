# Shepherd Control CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local unix control socket + `shepherd` CLI that lets Claude Code (and any shell script) drive a running Shepherd — discover/create/edit/delete workspaces, tabs, and panes; split/focus/zoom; change config; `tell` a pane text; and `view` a pane's output.

**Architecture:** An always-on `@MainActor` `ControlServer` listens on a well-known unix socket (`~/.shepherd/control.sock`, also injected as `$SHEPHERD_CTL_SOCK` into every pane). It speaks a dead-simple request→response JSON protocol (one request per connection, client half-closes its write side, server replies then closes — no framing). Structural mutations reuse the existing `AgentStore.applyRemoteCommand(_:)` and store methods (the same code that powers remote workspaces). Pure logic (handle assignment, transcript parsing, ANSI stripping, config-file editing) lives in small unit-tested Swift files. The `shepherdd` helper binary gains a thin JSON client (`runControl`) and is exposed on PATH as `shepherd`.

**Tech Stack:** Swift, AppKit/libghostty (app), POSIX unix sockets, `xcodegen` + `xcodebuild`, XCTest.

## Global Constraints

- **libghostty C API calls happen on the main thread.** All store access is `@MainActor` (`AgentStore` is `@MainActor final class ... ObservableObject`, singleton `AgentStore.shared`).
- **Run `xcodegen generate` (in `spike/seam1/`) after adding/removing any source file**, or the file isn't compiled. New `Sources/*.swift` are auto-globbed into the **app** target; new pure sources under test must ALSO be added to the explicit `ShepherdModelTests` `sources:` list in `project.yml`. Helper sources under `Helper/` are auto-globbed into `shepherdd`.
- **SourceKit lies in this repo** — trust `xcodebuild`, not editor "cannot find type" diagnostics.
- **Do not kill/relaunch the running Shepherd.** The user runs it as their daily terminal. The automated gate for every task is: `xcodebuild ... build` succeeds and `xcodebuild ... test` passes. Runtime verification is handed to the user as a documented command; never `killall`/`open` in a step.
- **Commit messages end with:** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Code comments:** only the non-obvious "why", one line max; never narrate the diff.
- **The `$SHEPHERD_TAB_ID` env var value is the pane id** (name unchanged for plugin compat).
- **`AgentState` raw values:** `shell`, `working`, `blocked`, `need-to-check` (case `needsCheck`), `idle`, `error`.

### Build & test commands (used verbatim in steps)

```bash
# from spike/seam1/
XCB="xcodebuild -project Shepherd.xcodeproj -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache"

# regenerate after any file add/remove
xcodegen generate

# build the app
$XCB -scheme Shepherd build

# run the model unit tests
$XCB -scheme Shepherd -only-testing:ShepherdModelTests test
```

### Control protocol (reference for all tasks)

One JSON object per connection, no length framing.

- **Request** (client → server), then client `shutdown(fd, SHUT_WR)`:
  ```json
  { "cmd": "<verb>", "<field>": <value>, ... }
  ```
- **Response** (server → client), then server closes:
  ```json
  { "ok": true,  "data": <any> }
  { "ok": false, "error": "<message>" }
  ```

Targets in requests are **handles** (`ws1`/`t1`/`p1`) or raw UUIDs; the server resolves both. Handle kinds: `ws`, `t`, `p`.

---

## Task 1: HandleRegistry (pure)

Stable-per-lifetime short handles (`ws1`/`t1`/`p1`) ↔ UUIDs, minted monotonically so a number never aliases two entities within a run.

**Files:**
- Create: `spike/seam1/Sources/HandleRegistry.swift`
- Test: `spike/seam1/Tests/HandleRegistryTests.swift`
- Modify: `spike/seam1/project.yml` (add to `ShepherdModelTests` sources)

**Interfaces:**
- Produces:
  - `enum HandleKind: String { case workspace = "ws", tab = "t", pane = "p" }`
  - `final class HandleRegistry`
    - `func handle(for uuid: String, kind: HandleKind) -> String`
    - `func uuid(for handle: String) -> String?`
    - `func prune(live: Set<String>)`

- [ ] **Step 1: Write the failing test**

Create `spike/seam1/Tests/HandleRegistryTests.swift`:
```swift
import XCTest
@testable import Shepherd

final class HandleRegistryTests: XCTestCase {
    func testMintsSequentialPerKind() {
        let r = HandleRegistry()
        XCTAssertEqual(r.handle(for: "uuid-a", kind: .pane), "p1")
        XCTAssertEqual(r.handle(for: "uuid-b", kind: .pane), "p2")
        XCTAssertEqual(r.handle(for: "ws-a", kind: .workspace), "ws1")
        XCTAssertEqual(r.handle(for: "t-a", kind: .tab), "t1")
    }

    func testHandleIsStableForSameUUID() {
        let r = HandleRegistry()
        let h = r.handle(for: "uuid-a", kind: .pane)
        XCTAssertEqual(r.handle(for: "uuid-a", kind: .pane), h)
    }

    func testReverseResolves() {
        let r = HandleRegistry()
        let h = r.handle(for: "uuid-a", kind: .pane)
        XCTAssertEqual(r.uuid(for: h), "uuid-a")
        XCTAssertNil(r.uuid(for: "p999"))
    }

    func testPruneDropsDeadAndNeverReusesNumber() {
        let r = HandleRegistry()
        XCTAssertEqual(r.handle(for: "uuid-a", kind: .pane), "p1")
        r.prune(live: [])                       // uuid-a is gone
        XCTAssertNil(r.uuid(for: "p1"))
        XCTAssertEqual(r.handle(for: "uuid-b", kind: .pane), "p2")   // not p1 again
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd spike/seam1 && xcodegen generate` (after Step 3's yml edit you'll regen again; for now the file doesn't compile). Expected: build failure "cannot find 'HandleRegistry' in scope".

- [ ] **Step 3: Write the implementation**

Create `spike/seam1/Sources/HandleRegistry.swift`:
```swift
import Foundation

enum HandleKind: String { case workspace = "ws", tab = "t", pane = "p" }

/// Short, human-ish handles (ws1/t1/p1) mapped to opaque UUIDs. Handles are
/// stable while an entity lives and minted monotonically, so a number is never
/// reused for a different entity within one run.
final class HandleRegistry {
    private var toHandle: [String: String] = [:]   // uuid  -> handle
    private var toUUID: [String: String] = [:]      // handle -> uuid
    private var counters: [HandleKind: Int] = [:]

    func handle(for uuid: String, kind: HandleKind) -> String {
        if let h = toHandle[uuid] { return h }
        let n = (counters[kind] ?? 0) + 1
        counters[kind] = n
        let h = "\(kind.rawValue)\(n)"
        toHandle[uuid] = h
        toUUID[h] = uuid
        return h
    }

    func uuid(for handle: String) -> String? { toUUID[handle] }

    func prune(live: Set<String>) {
        for (uuid, h) in toHandle where !live.contains(uuid) {
            toHandle[uuid] = nil
            toUUID[h] = nil
        }
    }
}
```

- [ ] **Step 4: Add to `ShepherdModelTests` sources in `project.yml`**

In `spike/seam1/project.yml`, inside `ShepherdModelTests: sources:`, add before `- path: Tests`:
```yaml
      - path: Sources/HandleRegistry.swift
```

- [ ] **Step 5: Regenerate and run the test**

Run:
```bash
cd spike/seam1 && xcodegen generate
XCB="xcodebuild -project Shepherd.xcodeproj -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache"
$XCB -scheme Shepherd -only-testing:ShepherdModelTests test 2>&1 | tail -20
```
Expected: `Test Suite 'HandleRegistryTests' passed`.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/HandleRegistry.swift spike/seam1/Tests/HandleRegistryTests.swift spike/seam1/project.yml
git commit -m "feat(control): pure HandleRegistry for ws/t/p short handles

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: TranscriptReader (pure)

Parse Claude session-transcript JSONL into clean user/assistant turns (the `recall` rules), for `view` on an agent pane.

**Files:**
- Create: `spike/seam1/Sources/TranscriptReader.swift`
- Test: `spike/seam1/Tests/TranscriptReaderTests.swift`
- Modify: `spike/seam1/project.yml` (`ShepherdModelTests` sources)

**Interfaces:**
- Produces:
  - `struct TranscriptTurn: Equatable { let role: String; let text: String }`
  - `enum TranscriptReader`
    - `static func turns(fromJSONL lines: [String], limit: Int) -> [TranscriptTurn]`
    - `static func sessionFile(sessionID: String, projectsDir: String) -> String?`

- [ ] **Step 1: Write the failing test**

Create `spike/seam1/Tests/TranscriptReaderTests.swift`:
```swift
import XCTest
@testable import Shepherd

final class TranscriptReaderTests: XCTestCase {
    func testKeepsUserAndAssistantSkipsToolNoise() {
        let lines = [
            #"{"type":"user","message":{"role":"user","content":"run the tests"}}"#,
            #"{"type":"assistant","message":{"content":[{"type":"text","text":"Running now."}]}}"#,
            #"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"x"}]}}"#,   // tool result -> skipped
            #"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}}"#,                 // no text -> skipped
            #"{"type":"assistant","message":{"content":[{"type":"text","text":"12 passing."}]}}"#,
        ]
        let turns = TranscriptReader.turns(fromJSONL: lines, limit: 10)
        XCTAssertEqual(turns, [
            TranscriptTurn(role: "user", text: "run the tests"),
            TranscriptTurn(role: "assistant", text: "Running now."),
            TranscriptTurn(role: "assistant", text: "12 passing."),
        ])
    }

    func testSkipsReminderOnlyAndCommandStubs() {
        let lines = [
            #"{"type":"user","message":{"role":"user","content":"<system-reminder>hi</system-reminder>"}}"#,
            #"{"type":"user","message":{"role":"user","content":"<local-command-stdout>x</local-command-stdout>"}}"#,
            #"{"type":"user","message":{"role":"user","content":"real message"}}"#,
        ]
        XCTAssertEqual(TranscriptReader.turns(fromJSONL: lines, limit: 10),
                       [TranscriptTurn(role: "user", text: "real message")])
    }

    func testLimitReturnsLastN() {
        let lines = (1...5).map { #"{"type":"user","message":{"role":"user","content":"m\#($0)"}}"# }
        let turns = TranscriptReader.turns(fromJSONL: lines, limit: 2)
        XCTAssertEqual(turns.map(\.text), ["m4", "m5"])
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run the ModelTests command. Expected: FAIL "cannot find 'TranscriptReader' in scope".

- [ ] **Step 3: Write the implementation**

Create `spike/seam1/Sources/TranscriptReader.swift`:
```swift
import Foundation

struct TranscriptTurn: Equatable { let role: String; let text: String }

/// Parses Claude Code session JSONL into clean user/assistant turns, dropping
/// tool calls/results, hook/reminder stubs, and command-echo stubs. Mirrors the
/// `recall` CLI's filtering; reimplemented here so Shepherd stays self-contained.
enum TranscriptReader {
    static func turns(fromJSONL lines: [String], limit: Int) -> [TranscriptTurn] {
        var out: [TranscriptTurn] = []
        for line in lines {
            let t = line.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !t.isEmpty, let data = t.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let type = obj["type"] as? String,
                  let msg = obj["message"] as? [String: Any]
            else { continue }
            if type == "user", let text = userText(msg) {
                out.append(TranscriptTurn(role: "user", text: text))
            } else if type == "assistant", let text = assistantText(msg) {
                out.append(TranscriptTurn(role: "assistant", text: text))
            }
        }
        return limit > 0 && out.count > limit ? Array(out.suffix(limit)) : out
    }

    private static func userText(_ msg: [String: Any]) -> String? {
        guard let content = msg["content"] as? String else { return nil }  // tool_result content is an array -> skipped
        let text = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if text.hasPrefix("<local-command-stdout>") { return nil }
        let stripped = text.replacingOccurrences(
            of: "<[^>]+>.*?</[^>]+>", with: "", options: [.regularExpression]
        ).trimmingCharacters(in: .whitespacesAndNewlines)
        return stripped.isEmpty ? nil : text
    }

    private static func assistantText(_ msg: [String: Any]) -> String? {
        guard let blocks = msg["content"] as? [[String: Any]] else { return nil }
        let parts = blocks.compactMap { b -> String? in
            guard b["type"] as? String == "text",
                  let t = (b["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !t.isEmpty else { return nil }
            return t
        }
        return parts.isEmpty ? nil : parts.joined(separator: "\n\n")
    }

    /// Locate `<sessionID>.jsonl` under `<projectsDir>/*/`. Returns the first match.
    static func sessionFile(sessionID: String, projectsDir: String) -> String? {
        let fm = FileManager.default
        guard let projects = try? fm.contentsOfDirectory(atPath: projectsDir) else { return nil }
        for proj in projects {
            let candidate = (projectsDir as NSString)
                .appendingPathComponent(proj)
                .appending("/\(sessionID).jsonl")
            if fm.fileExists(atPath: candidate) { return candidate }
        }
        return nil
    }
}
```

- [ ] **Step 4: Add to `ShepherdModelTests` sources in `project.yml`**

Add `- path: Sources/TranscriptReader.swift` before `- path: Tests`.

- [ ] **Step 5: Regenerate and run the test**

Run `xcodegen generate` then the ModelTests command. Expected: `TranscriptReaderTests passed`.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/TranscriptReader.swift spike/seam1/Tests/TranscriptReaderTests.swift spike/seam1/project.yml
git commit -m "feat(control): pure TranscriptReader for agent-pane view

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: AnsiText (pure)

Strip ANSI escapes and tail N lines, for `view` on a shell pane (ring bytes).

**Files:**
- Create: `spike/seam1/Sources/AnsiText.swift`
- Test: `spike/seam1/Tests/AnsiTextTests.swift`
- Modify: `spike/seam1/project.yml` (`ShepherdModelTests` sources)

**Interfaces:**
- Produces:
  - `enum AnsiText`
    - `static func strip(_ s: String) -> String`
    - `static func tailLines(_ s: String, _ n: Int) -> String`

- [ ] **Step 1: Write the failing test**

Create `spike/seam1/Tests/AnsiTextTests.swift`:
```swift
import XCTest
@testable import Shepherd

final class AnsiTextTests: XCTestCase {
    func testStripsCSIColor() {
        XCTAssertEqual(AnsiText.strip("\u{1B}[31mred\u{1B}[0m done"), "red done")
    }
    func testStripsOSCTitle() {
        XCTAssertEqual(AnsiText.strip("\u{1B}]0;my title\u{07}hello"), "hello")
    }
    func testTailLines() {
        XCTAssertEqual(AnsiText.tailLines("a\nb\nc\nd", 2), "c\nd")
        XCTAssertEqual(AnsiText.tailLines("only", 5), "only")
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run ModelTests command. Expected: FAIL "cannot find 'AnsiText'".

- [ ] **Step 3: Write the implementation**

Create `spike/seam1/Sources/AnsiText.swift`:
```swift
import Foundation

enum AnsiText {
    private static let csi = try! NSRegularExpression(pattern: "\u{1B}\\[[0-9;?]*[ -/]*[@-~]")
    private static let osc = try! NSRegularExpression(pattern: "\u{1B}\\][^\u{07}\u{1B}]*(?:\u{07}|\u{1B}\\\\)")
    private static let other = try! NSRegularExpression(pattern: "\u{1B}[@-Z\\\\-_]")

    static func strip(_ s: String) -> String {
        var out = s
        for re in [osc, csi, other] {
            let range = NSRange(out.startIndex..., in: out)
            out = re.stringByReplacingMatches(in: out, range: range, withTemplate: "")
        }
        return out
    }

    static func tailLines(_ s: String, _ n: Int) -> String {
        guard n > 0 else { return "" }
        let lines = s.split(separator: "\n", omittingEmptySubsequences: false)
        return lines.suffix(n).joined(separator: "\n")
    }
}
```

- [ ] **Step 4: Add to `ShepherdModelTests` sources**

Add `- path: Sources/AnsiText.swift` before `- path: Tests`.

- [ ] **Step 5: Regenerate and run the test**

`xcodegen generate` then ModelTests command. Expected: `AnsiTextTests passed`.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/AnsiText.swift spike/seam1/Tests/AnsiTextTests.swift spike/seam1/project.yml
git commit -m "feat(control): pure AnsiText strip+tail for shell-pane view

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: ControlConfigFile (pure)

Get/set a key in the ghostty-syntax `~/.config/shepherd/config`. Shepherd keys (`theme`, `worktree-base`) ride `# shepherd: key = value` comment lines; other keys are bare ghostty `key = value` lines.

**Files:**
- Create: `spike/seam1/Sources/ControlConfigFile.swift`
- Test: `spike/seam1/Tests/ControlConfigFileTests.swift`
- Modify: `spike/seam1/project.yml` (`ShepherdModelTests` sources)

**Interfaces:**
- Produces:
  - `enum ControlConfigFile`
    - `static let shepherdKeys: Set<String>` (`["theme", "worktree-base"]`)
    - `static func get(_ key: String, from text: String) -> String?`
    - `static func set(_ key: String, _ value: String, in text: String) -> String`

- [ ] **Step 1: Write the failing test**

Create `spike/seam1/Tests/ControlConfigFileTests.swift`:
```swift
import XCTest
@testable import Shepherd

final class ControlConfigFileTests: XCTestCase {
    func testGetShepherdCommentKey() {
        let text = "font-size = 13\n# shepherd: theme = dark\n"
        XCTAssertEqual(ControlConfigFile.get("theme", from: text), "dark")
    }
    func testGetGhosttyBareKey() {
        XCTAssertEqual(ControlConfigFile.get("font-size", from: "font-size = 13\n"), "13")
    }
    func testSetUpsertsShepherdKeyInPlace() {
        let text = "# shepherd: theme = dark\n"
        let out = ControlConfigFile.set("theme", "light", in: text)
        XCTAssertEqual(ControlConfigFile.get("theme", from: out), "light")
        XCTAssertFalse(out.contains("dark"))
    }
    func testSetAppendsMissingKey() {
        let out = ControlConfigFile.set("theme", "warm", in: "font-size = 13\n")
        XCTAssertEqual(ControlConfigFile.get("theme", from: out), "warm")
        XCTAssertTrue(out.contains("# shepherd: theme = warm"))
    }
    func testSetBareGhosttyKey() {
        let out = ControlConfigFile.set("font-size", "15", in: "font-size = 13\n")
        XCTAssertEqual(ControlConfigFile.get("font-size", from: out), "15")
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run ModelTests. Expected: FAIL "cannot find 'ControlConfigFile'".

- [ ] **Step 3: Write the implementation**

Create `spike/seam1/Sources/ControlConfigFile.swift`:
```swift
import Foundation

/// Reads/writes a single key in the ghostty-syntax Shepherd config file.
/// Shepherd-specific keys live on `# shepherd: key = value` comment lines that
/// libghostty ignores; all other keys are bare ghostty `key = value` lines.
enum ControlConfigFile {
    static let shepherdKeys: Set<String> = ["theme", "worktree-base"]

    static func get(_ key: String, from text: String) -> String? {
        let isShep = shepherdKeys.contains(key)
        for raw in text.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if isShep {
                guard line.hasPrefix("# shepherd:") else { continue }
                let body = line.dropFirst("# shepherd:".count)
                if let (k, v) = split(String(body)), k == key { return v }
            } else {
                guard !line.hasPrefix("#") else { continue }
                if let (k, v) = split(line), k == key { return v }
            }
        }
        return nil
    }

    static func set(_ key: String, _ value: String, in text: String) -> String {
        let isShep = shepherdKeys.contains(key)
        let newLine = isShep ? "# shepherd: \(key) = \(value)" : "\(key) = \(value)"
        var lines = text.components(separatedBy: "\n")
        var replaced = false
        for i in lines.indices {
            let line = lines[i].trimmingCharacters(in: .whitespaces)
            let matches: Bool
            if isShep, line.hasPrefix("# shepherd:") {
                matches = split(String(line.dropFirst("# shepherd:".count)))?.0 == key
            } else if !isShep, !line.hasPrefix("#") {
                matches = split(line)?.0 == key
            } else { matches = false }
            if matches { lines[i] = newLine; replaced = true; break }
        }
        if !replaced {
            if lines.last == "" { lines.insert(newLine, at: lines.count - 1) }
            else { lines.append(newLine) }
        }
        return lines.joined(separator: "\n")
    }

    private static func split(_ s: String) -> (String, String)? {
        guard let eq = s.firstIndex(of: "=") else { return nil }
        let k = s[..<eq].trimmingCharacters(in: .whitespaces)
        let v = s[s.index(after: eq)...].trimmingCharacters(in: .whitespaces)
        return k.isEmpty ? nil : (k, v)
    }
}
```

- [ ] **Step 4: Add to `ShepherdModelTests` sources**

Add `- path: Sources/ControlConfigFile.swift` before `- path: Tests`.

- [ ] **Step 5: Regenerate and run the test**

`xcodegen generate` then ModelTests. Expected: `ControlConfigFileTests passed`.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/ControlConfigFile.swift spike/seam1/Tests/ControlConfigFileTests.swift spike/seam1/project.yml
git commit -m "feat(control): pure ControlConfigFile get/set over shepherd config

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Control socket + CLI client skeleton (`ping` end-to-end)

Stand up the always-on request/response socket in the app, the thin JSON client in `shepherdd`, env injection, and a single working verb (`ping` → `pong`) to prove the whole channel.

**Files:**
- Create: `spike/seam1/Sources/ControlServer.swift`
- Create: `spike/seam1/Helper/ControlClient.swift`
- Modify: `spike/seam1/Sources/AgentStore.swift` (add `ctlSocketPath`, `ctlServer`, start in `init`, add `route`)
- Modify: `spike/seam1/Sources/GhosttyTerminal.swift:206` (inject `SHEPHERD_CTL_SOCK`)
- Modify: `spike/seam1/Helper/main.swift:413` (route control verbs)

**Interfaces:**
- Consumes: `AgentStore.shared` (`@MainActor` singleton).
- Produces:
  - `@MainActor final class ControlServer { init(path: String, route: @escaping ([String: Any]) -> [String: Any]); func start(); func stop() }`
  - `AgentStore.ctlSocketPath: String` (the well-known socket path)
  - `AgentStore.controlRoute(_ req: [String: Any]) -> [String: Any]`
  - Helper: `func runControl(_ argv: [String]) -> Int32`

- [ ] **Step 1: Write `ControlServer.swift`**

Create `spike/seam1/Sources/ControlServer.swift`:
```swift
import Foundation

/// Always-on local control socket. One request per connection: read the client's
/// JSON until it half-closes (SHUT_WR), route it on the main actor, write the
/// JSON response, close. Distinct from the fire-and-forget hook SocketServer —
/// this one replies.
@MainActor
final class ControlServer {
    private let path: String
    private let route: ([String: Any]) -> [String: Any]
    private var fd: Int32 = -1
    private let queue = DispatchQueue(label: "shepherd.control", qos: .userInitiated, attributes: .concurrent)

    init(path: String, route: @escaping ([String: Any]) -> [String: Any]) {
        self.path = path
        self.route = route
    }

    func start() {
        unlink(path)
        fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let maxLen = MemoryLayout.size(ofValue: addr.sun_path) - 1
        path.withCString { cstr in
            withUnsafeMutablePointer(to: &addr.sun_path.0) { _ = strncpy($0, cstr, maxLen) }
        }
        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, size) }
        }
        guard bound == 0 else { close(fd); fd = -1; return }
        chmod(path, 0o600)
        guard listen(fd, 16) == 0 else { close(fd); fd = -1; return }
        let listenFD = fd
        queue.async { [weak self] in self?.acceptLoop(listenFD) }
    }

    private func acceptLoop(_ listenFD: Int32) {
        while true {
            let client = accept(listenFD, nil, nil)
            if client < 0 { if errno == EINTR { continue } else { break } }
            queue.async { [weak self] in self?.handle(client) }
        }
    }

    private func handle(_ client: Int32) {
        defer { close(client) }
        var data = Data()
        var buf = [UInt8](repeating: 0, count: 16 * 1024)
        while true {
            let n = read(client, &buf, buf.count)
            if n > 0 { data.append(contentsOf: buf[0..<n]) }
            else { break }   // client half-closed write, or EOF
        }
        let req = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        // route touches the store -> main actor.
        var resp: [String: Any] = ["ok": false, "error": "internal error"]
        let sem = DispatchSemaphore(value: 0)
        DispatchQueue.main.async {
            resp = MainActor.assumeIsolated { self.route(req ?? [:]) }
            sem.signal()
        }
        sem.wait()
        if let out = try? JSONSerialization.data(withJSONObject: resp) {
            out.withUnsafeBytes { _ = write(client, $0.baseAddress, out.count) }
        }
    }

    func stop() { if fd >= 0 { close(fd); unlink(path); fd = -1 } }
    deinit { if fd >= 0 { close(fd); unlink(path) } }
}
```

- [ ] **Step 2: Wire the server into `AgentStore`**

In `spike/seam1/Sources/AgentStore.swift`, near the other socket props (around `:68`), add:
```swift
    let ctlSocketPath: String = (NSHomeDirectory() as NSString).appendingPathComponent(".shepherd/control.sock")
    private var ctlServer: ControlServer?
```
In `private init()` (around `:149`, after the hook `server?.start()`), add:
```swift
        try? FileManager.default.createDirectory(
            atPath: (ctlSocketPath as NSString).deletingLastPathComponent,
            withIntermediateDirectories: true)
        ctlServer = ControlServer(path: ctlSocketPath) { [weak self] req in
            self?.controlRoute(req) ?? ["ok": false, "error": "store gone"]
        }
        ctlServer?.start()
```
Add the router method (new `// MARK: - Control CLI` section near the end of the class, before the closing brace):
```swift
    func controlRoute(_ req: [String: Any]) -> [String: Any] {
        switch req["cmd"] as? String {
        case "ping": return ["ok": true, "data": "pong"]
        default:      return ["ok": false, "error": "unknown command: \(req["cmd"] as? String ?? "nil")"]
        }
    }
```

- [ ] **Step 3: Inject `SHEPHERD_CTL_SOCK` into panes**

In `spike/seam1/Sources/GhosttyTerminal.swift`, in the local (non-mirror) `envVars` array literal (`:202-206`), add a fourth element after the `SHEPHERD_PTY_SOCK` line:
```swift
        ghostty_env_var_s(key: dup("SHEPHERD_CTL_SOCK"), value: dup(AgentStore.shared.ctlSocketPath)),
```

- [ ] **Step 4: Write the CLI client**

Create `spike/seam1/Helper/ControlClient.swift`:
```swift
import Foundation

/// Thin JSON client for the app's control socket. Builds a request dict from
/// argv, connects, writes it, half-closes, reads the reply, prints, and returns
/// a process exit code (0 = ok, 1 = error).
func runControl(_ argv: [String]) -> Int32 {
    guard let verb = argv.first else {
        FileHandle.standardError.write(Data("shepherd: missing command\n".utf8)); return 64
    }
    let env = ProcessInfo.processInfo.environment
    let sockPath = env["SHEPHERD_CTL_SOCK"].flatMap { $0.isEmpty ? nil : $0 }
        ?? (NSHomeDirectory() as NSString).appendingPathComponent(".shepherd/control.sock")

    guard let req = buildRequest(verb: verb, rest: Array(argv.dropFirst())) else {
        FileHandle.standardError.write(Data("shepherd: bad arguments for \(verb)\n".utf8)); return 64
    }
    guard let reply = roundTrip(sockPath: sockPath, request: req) else {
        FileHandle.standardError.write(Data("shepherd: cannot reach Shepherd (is it running?)\n".utf8)); return 69
    }
    if reply["ok"] as? Bool == true {
        printData(verb: verb, data: reply["data"])
        return 0
    } else {
        let msg = reply["error"] as? String ?? "error"
        FileHandle.standardError.write(Data("shepherd: \(msg)\n".utf8))
        return 1
    }
}

/// Verb -> request dict. Extended in later tasks; ping needs no args.
func buildRequest(verb: String, rest: [String]) -> [String: Any]? {
    switch verb {
    case "ping": return ["cmd": "ping"]
    default:     return nil
    }
}

/// Response formatter. Extended in later tasks.
func printData(verb: String, data: Any?) {
    if let s = data as? String { print(s) }
    else if let data, let out = try? JSONSerialization.data(withJSONObject: data, options: [.prettyPrinted]) {
        print(String(decoding: out, as: UTF8.self))
    }
}

private func roundTrip(sockPath: String, request: [String: Any]) -> [String: Any]? {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let maxLen = MemoryLayout.size(ofValue: addr.sun_path) - 1
    sockPath.withCString { cstr in
        withUnsafeMutablePointer(to: &addr.sun_path.0) { _ = strncpy($0, cstr, maxLen) }
    }
    let size = socklen_t(MemoryLayout<sockaddr_un>.size)
    let ok = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, size) }
    }
    guard ok == 0, let body = try? JSONSerialization.data(withJSONObject: request) else { return nil }
    body.withUnsafeBytes { _ = write(fd, $0.baseAddress, body.count) }
    shutdown(fd, SHUT_WR)
    var data = Data(); var buf = [UInt8](repeating: 0, count: 16 * 1024)
    while true { let n = read(fd, &buf, buf.count); if n > 0 { data.append(contentsOf: buf[0..<n]) } else { break } }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}
```

- [ ] **Step 5: Route control verbs in the helper entry point**

In `spike/seam1/Helper/main.swift`, replace the `default:` arm of the entry `switch` (`:424-426`) with:
```swift
default:
    let name = (CommandLine.arguments.first as NSString?)?.lastPathComponent ?? ""
    if name == "shepherd" || argv.first != nil {
        exit(runControl(argv))
    }
    FileHandle.standardError.write(Data("usage: shepherdd (pty [-- <program> …] | attach | <control-cmd>)\n".utf8))
    exit(64)
```

- [ ] **Step 6: Build and verify compilation**

Run:
```bash
cd spike/seam1 && xcodegen generate
XCB="xcodebuild -project Shepherd.xcodeproj -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache"
$XCB -scheme Shepherd build 2>&1 | tail -20
```
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 7: Verify the model tests still pass**

Run: `$XCB -scheme Shepherd -only-testing:ShepherdModelTests test 2>&1 | tail -10`. Expected: passing.

- [ ] **Step 8: Commit**

```bash
git add spike/seam1/Sources/ControlServer.swift spike/seam1/Helper/ControlClient.swift \
        spike/seam1/Sources/AgentStore.swift spike/seam1/Sources/GhosttyTerminal.swift \
        spike/seam1/Helper/main.swift
git commit -m "feat(control): always-on control socket + shepherdd JSON client (ping)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 9: Hand the user the runtime check (do not run it yourself)**

Tell the user: after they next rebuild + relaunch Shepherd, verify the channel with:
```bash
./build/Build/Products/Debug/shepherdd ping   # expect: pong
```

---

## Task 6: `ls`, `whoami`, `state`

Discovery + self-identification + a single-pane state read (the primitive `wait` polls in Task 11).

**Files:**
- Modify: `spike/seam1/Sources/AgentStore.swift` (extend `controlRoute`; add a `HandleRegistry` instance + snapshot helpers)
- Modify: `spike/seam1/Helper/ControlClient.swift` (`buildRequest`, `printData`)

**Interfaces:**
- Consumes: `HandleRegistry` (Task 1); `AgentStore.workspaces`, `locatePane(_:in:)`, `Pane` fields.
- Produces: control verbs `ls`, `whoami`, `state`; `AgentStore.controlHandles: HandleRegistry`.

- [ ] **Step 1: Add the registry + a tree snapshot to `AgentStore`**

In `AgentStore.swift`, near `ctlServer`, add:
```swift
    let controlHandles = HandleRegistry()
```
Add a helper (in the Control CLI section):
```swift
    /// Full workspace→tab→pane tree as plain dicts, assigning/refreshing handles.
    private func controlSnapshot() -> [[String: Any]] {
        var live = Set<String>()
        let tree = workspaces.map { ws -> [String: Any] in
            live.insert(ws.id)
            let tabsJSON = ws.tabs.map { tab -> [String: Any] in
                live.insert(tab.tabID)
                let panesJSON = tab.root.panes.map { p -> [String: Any] in
                    live.insert(p.paneID)
                    return [
                        "pane": controlHandles.handle(for: p.paneID, kind: .pane),
                        "uuid": p.paneID,
                        "state": p.state.rawValue,
                        "title": p.displayTitle,
                        "cwd": p.cwd ?? "",
                        "sessionID": p.sessionID ?? "",
                    ]
                }
                return [
                    "tab": controlHandles.handle(for: tab.tabID, kind: .tab),
                    "uuid": tab.tabID,
                    "title": tab.displayTitle,
                    "panes": panesJSON,
                ]
            }
            return [
                "workspace": controlHandles.handle(for: ws.id, kind: .workspace),
                "uuid": ws.id,
                "name": ws.displayName,
                "active": ws.id == selectedWorkspaceID,
                "tabs": tabsJSON,
            ]
        }
        controlHandles.prune(live: live)
        return tree
    }

    /// Resolve a handle or raw UUID to a pane UUID that exists.
    private func resolvePane(_ token: String) -> String? {
        let uuid = controlHandles.uuid(for: token) ?? token
        return locatePane(uuid, in: workspaces) != nil ? uuid : nil
    }
    private func resolveWorkspace(_ token: String) -> String? {
        let uuid = controlHandles.uuid(for: token) ?? token
        return workspaces.contains { $0.id == uuid } ? uuid : nil
    }
    private func resolveTab(_ token: String) -> String? {
        let uuid = controlHandles.uuid(for: token) ?? token
        return workspaces.contains { $0.tabs.contains { $0.tabID == uuid } } ? uuid : nil
    }
```
> Note: confirm `Tab.displayTitle` exists; if the property is named differently, use `tab.attentionState()`-adjacent title accessor. Per CLAUDE.md a tab's title derives from its focused pane — if there is no `Tab.displayTitle`, compute it as `tab.root.pane(tab.focusedPaneID)?.displayTitle ?? "Tab"`.

- [ ] **Step 2: Extend `controlRoute`**

Replace the `controlRoute` body's `switch` with:
```swift
        switch req["cmd"] as? String {
        case "ping": return ["ok": true, "data": "pong"]

        case "ls":
            return ["ok": true, "data": ["workspaces": controlSnapshot()]]

        case "whoami":
            guard let token = req["pane"] as? String, !token.isEmpty,
                  let uuid = resolvePane(token), let (w, t) = locatePane(uuid, in: workspaces)
            else { return ["ok": false, "error": "not inside a Shepherd pane"] }
            _ = controlSnapshot()   // ensure handles are minted
            return ["ok": true, "data": [
                "pane": controlHandles.handle(for: uuid, kind: .pane),
                "tab": controlHandles.handle(for: workspaces[w].tabs[t].tabID, kind: .tab),
                "workspace": controlHandles.handle(for: workspaces[w].id, kind: .workspace),
            ]]

        case "state":
            guard let token = req["pane"] as? String, let uuid = resolvePane(token),
                  let p = pane(uuid) else { return ["ok": false, "error": "no such pane"] }
            return ["ok": true, "data": ["state": p.state.rawValue, "reason": p.reason ?? ""]]

        default: return ["ok": false, "error": "unknown command: \(req["cmd"] as? String ?? "nil")"]
        }
```

- [ ] **Step 3: Extend the CLI `buildRequest` and `printData`**

In `Helper/ControlClient.swift`, add cases to `buildRequest`:
```swift
    case "ls":     return ["cmd": "ls"]
    case "whoami": return ["cmd": "whoami", "pane": ProcessInfo.processInfo.environment["SHEPHERD_TAB_ID"] ?? ""]
    case "state":  guard let p = rest.first else { return nil }; return ["cmd": "state", "pane": p]
```
Add a formatter for `ls` in `printData` (before the generic fallback):
```swift
    if verb == "ls", let root = data as? [String: Any], let wss = root["workspaces"] as? [[String: Any]] {
        for ws in wss {
            let star = (ws["active"] as? Bool == true) ? "  (active)" : ""
            print("\(ws["workspace"] as? String ?? "?") \(ws["name"] as? String ?? "")\(star)")
            for tab in ws["tabs"] as? [[String: Any]] ?? [] {
                let panes = (tab["panes"] as? [[String: Any]] ?? []).map {
                    "\($0["pane"] as? String ?? "?") \($0["state"] as? String ?? "")"
                }.joined(separator: "  ")
                print("  \(tab["tab"] as? String ?? "?")  \(tab["title"] as? String ?? "")  \(panes)")
            }
        }
        return
    }
```

- [ ] **Step 4: Build + model tests**

Run `xcodegen generate`, then the app build and ModelTests commands. Expected: `BUILD SUCCEEDED` and tests pass.

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/AgentStore.swift spike/seam1/Helper/ControlClient.swift
git commit -m "feat(control): ls / whoami / state verbs + handle-assigned tree snapshot

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Hand the user the runtime check**

After rebuild+relaunch: `shepherdd ls` (tree), `shepherdd whoami` inside a pane, `shepherdd state p1`.

---

## Task 7: Structural verbs (workspace / tab / pane / split / focus / zoom)

Wire the mutation surface, reusing `applyRemoteCommand` where a `ControlMessage` case exists and store methods otherwise. Mutating verbs return the affected handle(s).

**Files:**
- Modify: `spike/seam1/Sources/AgentStore.swift` (`controlRoute` cases)
- Modify: `spike/seam1/Helper/ControlClient.swift` (`buildRequest`)

**Interfaces:**
- Consumes: `applyRemoteCommand(_:)`; `newWorkspace()`, `renameWorkspace(_:to:)`, `deleteWorkspace(_:)`, `selectWorkspace(_:)`, `newTab(inWorkspace:cwd:sessionID:)`, `select(tabID:inWorkspace:)`, `rename(tabID:to:inWorkspace:)`, `setWorkspaceDirectory(_:to:)`, `newWorktreeTab(inWorkspace:name:)`; `SplitAxis`.

- [ ] **Step 1: Add the structural cases to `controlRoute`**

Insert before `default:`:
```swift
        case "workspace-new":
            let id = newWorkspace()
            return ["ok": true, "data": ["workspace": controlHandles.handle(for: id, kind: .workspace)]]
        case "workspace-rename":
            guard let ws = (req["workspace"] as? String).flatMap(resolveWorkspace),
                  let name = req["name"] as? String else { return ["ok": false, "error": "bad args"] }
            renameWorkspace(ws, to: name); return ["ok": true, "data": NSNull()]
        case "workspace-rm":
            guard let ws = (req["workspace"] as? String).flatMap(resolveWorkspace)
            else { return ["ok": false, "error": "no such workspace"] }
            deleteWorkspace(ws); return ["ok": true, "data": NSNull()]
        case "workspace-switch":
            guard let ws = (req["workspace"] as? String).flatMap(resolveWorkspace)
            else { return ["ok": false, "error": "no such workspace"] }
            selectWorkspace(ws); return ["ok": true, "data": NSNull()]

        case "tab-new":
            let ws = (req["workspace"] as? String).flatMap(resolveWorkspace) ?? selectedWorkspaceID
            let tabID = newTab(inWorkspace: ws)
            _ = controlSnapshot()
            let paneID = workspaces.first { $0.id == ws }?.tabs.first { $0.tabID == tabID }?.root.firstLeafID
            return ["ok": true, "data": [
                "tab": controlHandles.handle(for: tabID, kind: .tab),
                "pane": paneID.map { controlHandles.handle(for: $0, kind: .pane) } ?? "",
            ]]
        case "tab-rename":
            guard let t = (req["tab"] as? String).flatMap(resolveTab), let name = req["name"] as? String,
                  let wsID = workspaces.first(where: { $0.tabs.contains { $0.tabID == t } })?.id
            else { return ["ok": false, "error": "bad args"] }
            rename(tabID: t, to: name, inWorkspace: wsID); return ["ok": true, "data": NSNull()]
        case "tab-switch":
            guard let t = (req["tab"] as? String).flatMap(resolveTab),
                  let wsID = workspaces.first(where: { $0.tabs.contains { $0.tabID == t } })?.id
            else { return ["ok": false, "error": "no such tab"] }
            applyRemoteCommand(.cmdSwitchTab(workspaceID: wsID, tabID: t)); return ["ok": true, "data": NSNull()]

        case "split":
            guard let p = (req["pane"] as? String).flatMap(resolvePane) else { return ["ok": false, "error": "no such pane"] }
            let axis = (req["axis"] as? String) == "column" ? "column" : "row"
            applyRemoteCommand(.cmdSplit(paneID: p, axis: axis))
            _ = controlSnapshot()
            return ["ok": true, "data": ["pane": focusedControlPaneHandle()]]
        case "pane-close":
            guard let p = (req["pane"] as? String).flatMap(resolvePane) else { return ["ok": false, "error": "no such pane"] }
            applyRemoteCommand(.cmdClosePane(paneID: p)); return ["ok": true, "data": NSNull()]
        case "focus":
            guard let p = (req["pane"] as? String).flatMap(resolvePane) else { return ["ok": false, "error": "no such pane"] }
            applyRemoteCommand(.cmdFocusPane(paneID: p)); return ["ok": true, "data": NSNull()]
        case "zoom":
            guard let p = (req["pane"] as? String).flatMap(resolvePane) else { return ["ok": false, "error": "no such pane"] }
            applyRemoteCommand(.cmdZoom(paneID: p)); return ["ok": true, "data": NSNull()]
```
Add the helper near `controlSnapshot`:
```swift
    private func focusedControlPaneHandle() -> String {
        guard let id = selectedTab?.focusedPaneID else { return "" }
        return controlHandles.handle(for: id, kind: .pane)
    }
```
> Note: verify `selectedTab?.focusedPaneID` exists (CLAUDE.md documents `focusedPaneID` on `Tab`). If `selectedTab` is not a property, use the current workspace's selected tab via the existing computed `selectedTab` view referenced throughout `AgentStore`.

- [ ] **Step 2: Add the `buildRequest` cases**

```swift
    case "workspace":
        guard let sub = rest.first else { return nil }
        switch sub {
        case "new":    return ["cmd": "workspace-new"]
        case "rename": guard rest.count >= 3 else { return nil }; return ["cmd": "workspace-rename", "workspace": rest[1], "name": rest[2]]
        case "rm":     guard rest.count >= 2 else { return nil }; return ["cmd": "workspace-rm", "workspace": rest[1]]
        case "switch": guard rest.count >= 2 else { return nil }; return ["cmd": "workspace-switch", "workspace": rest[1]]
        default: return nil
        }
    case "tab":
        guard let sub = rest.first else { return nil }
        switch sub {
        case "new":    return rest.count >= 2 ? ["cmd": "tab-new", "workspace": rest[1]] : ["cmd": "tab-new"]
        case "rename": guard rest.count >= 3 else { return nil }; return ["cmd": "tab-rename", "tab": rest[1], "name": rest[2]]
        case "switch": guard rest.count >= 2 else { return nil }; return ["cmd": "tab-switch", "tab": rest[1]]
        case "close":  guard rest.count >= 2 else { return nil }; return ["cmd": "tab-close", "tab": rest[1]]   // Task 12 adds server side
        default: return nil
        }
    case "pane":
        guard let sub = rest.first, rest.count >= 2 else { return nil }
        switch sub {
        case "split": return ["cmd": "split", "pane": rest[1], "axis": rest.contains("--down") ? "column" : "row"]
        case "close": return ["cmd": "pane-close", "pane": rest[1]]
        default: return nil
        }
    case "focus": guard let p = rest.first else { return nil }; return ["cmd": "focus", "pane": p]
    case "zoom":  guard let p = rest.first else { return nil }; return ["cmd": "zoom", "pane": p]
    case "split": guard let p = rest.first else { return nil }; return ["cmd": "split", "pane": p, "axis": rest.contains("--down") ? "column" : "row"]
```

- [ ] **Step 3: Build + model tests**

`xcodegen generate`, app build, ModelTests. Expected: `BUILD SUCCEEDED`, tests pass.

- [ ] **Step 4: Commit**

```bash
git add spike/seam1/Sources/AgentStore.swift spike/seam1/Helper/ControlClient.swift
git commit -m "feat(control): workspace/tab/pane/split/focus/zoom verbs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Hand the user the runtime check**

`shepherdd workspace new`, `shepherdd tab new`, `shepherdd split p1`, `shepherdd focus p2`, `shepherdd zoom p1`.

---

## Task 8: `tell`

Inject text into a pane's PTY via the existing local surface-injection path; append Enter unless `--no-enter`.

**Files:**
- Modify: `spike/seam1/Sources/AgentStore.swift` (`controlRoute` `tell` case)
- Modify: `spike/seam1/Helper/ControlClient.swift` (`buildRequest`)

**Interfaces:**
- Consumes: `AgentStore.injectText(_:intoPane:)` (`:901`).

- [ ] **Step 1: Add the `tell` case to `controlRoute`**

```swift
        case "tell":
            guard let p = (req["pane"] as? String).flatMap(resolvePane),
                  let text = req["text"] as? String else { return ["ok": false, "error": "bad args"] }
            let payload = (req["enter"] as? Bool == false) ? text : text + "\n"
            injectText(payload, intoPane: p)
            return ["ok": true, "data": NSNull()]
```

- [ ] **Step 2: Add the `buildRequest` case**

```swift
    case "tell":
        guard rest.count >= 2 else { return nil }
        let noEnter = rest.contains("--no-enter")
        let text = rest[1]
        return ["cmd": "tell", "pane": rest[0], "text": text, "enter": !noEnter]
```

- [ ] **Step 3: Build + model tests**

`xcodegen generate`, app build, ModelTests. Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add spike/seam1/Sources/AgentStore.swift spike/seam1/Helper/ControlClient.swift
git commit -m "feat(control): tell — inject text + Enter into a pane PTY

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Hand the user the runtime check**

`shepherdd tell p1 "echo hello"` (runs it); `shepherdd tell p2 "some prompt" --no-enter`.

> Deferred (noted in spec): `--raw` literal-keystroke injection (e.g. a bare Ctrl-C) needs a key-encoding path beyond `injectText`; out of v1 scope.

---

## Task 9: `view`

Target-aware read: agent pane → session-transcript tail (always works); shell pane → ANSI-stripped ring tail (requires serving, since the capture ring only exists then).

**Files:**
- Modify: `spike/seam1/Sources/AgentStore.swift` (`controlRoute` `view` case + `ptyRingSnapshot` helper)
- Modify: `spike/seam1/Sources/PtyBroker.swift` (expose a public ring snapshot)
- Modify: `spike/seam1/Helper/ControlClient.swift` (`buildRequest`, `printData`)

**Interfaces:**
- Consumes: `TranscriptReader` (Task 2), `AnsiText` (Task 3), `Pane.sessionID`, `PtyHub.broker(for:)`.
- Produces: `PtyBroker.snapshotBytes() -> [UInt8]`; `AgentStore.ptyRingSnapshot(paneID:) -> [UInt8]?`.

- [ ] **Step 1: Expose the ring snapshot on `PtyBroker`**

In `spike/seam1/Sources/PtyBroker.swift`, promote the test-only snapshot to a real API (keep `ringSnapshotForTest` delegating to it):
```swift
    func snapshotBytes() -> [UInt8] { lock.lock(); defer { lock.unlock() }; return ring.snapshot() }
```
> Note: match the existing locking used elsewhere in `PtyBroker` (find the lock name near `attachViewer`). If `ringSnapshotForTest()` already locks, have it `return snapshotBytes()`.

- [ ] **Step 2: Add `ptyRingSnapshot` to `AgentStore`**

`ptyHub` is `private` (`:104`); add near the Control CLI section:
```swift
    private func ptyRingSnapshot(paneID: String) -> [UInt8]? {
        ptyHub?.broker(for: paneID)?.snapshotBytes()
    }
```

- [ ] **Step 3: Add the `view` case to `controlRoute`**

```swift
        case "view":
            guard let p = (req["pane"] as? String).flatMap(resolvePane), let pn = pane(p)
            else { return ["ok": false, "error": "no such pane"] }
            let lines = (req["lines"] as? Int) ?? 40
            let forceRaw = (req["raw"] as? Bool) == true
            if !forceRaw, let sid = pn.sessionID, !sid.isEmpty {
                let projects = (NSHomeDirectory() as NSString).appendingPathComponent(".claude/projects")
                guard let file = TranscriptReader.sessionFile(sessionID: sid, projectsDir: projects),
                      let text = try? String(contentsOfFile: file, encoding: .utf8)
                else { return ["ok": true, "data": ["kind": "transcript", "text": "(no transcript yet)"]] }
                let turns = TranscriptReader.turns(fromJSONL: text.components(separatedBy: "\n"), limit: lines)
                let rendered = turns.map { "\($0.role): \($0.text)" }.joined(separator: "\n\n")
                return ["ok": true, "data": ["kind": "transcript", "text": rendered]]
            }
            guard let bytes = ptyRingSnapshot(paneID: p) else {
                return ["ok": false, "error": "no capture for this pane (shell panes need 'serve' enabled)"]
            }
            let raw = String(decoding: bytes, as: UTF8.self)
            let text = forceRaw ? AnsiText.tailLines(raw, lines) : AnsiText.tailLines(AnsiText.strip(raw), lines)
            return ["ok": true, "data": ["kind": forceRaw ? "raw" : "ring", "text": text]]
```

- [ ] **Step 4: CLI `buildRequest` + `printData`**

`buildRequest`:
```swift
    case "view":
        guard let p = rest.first else { return nil }
        var req: [String: Any] = ["cmd": "view", "pane": p]
        if let i = rest.firstIndex(of: "--lines"), i + 1 < rest.count, let n = Int(rest[i + 1]) { req["lines"] = n }
        if rest.contains("--raw") { req["raw"] = true }
        return req
```
`printData` (before the generic fallback):
```swift
    if verb == "view", let d = data as? [String: Any] { print(d["text"] as? String ?? ""); return }
```

- [ ] **Step 5: Build + tests (incl. Remote tests that compile PtyBroker)**

Run `xcodegen generate`, app build, ModelTests, and:
```bash
$XCB -scheme Shepherd -only-testing:ShepherdRemoteTests test 2>&1 | tail -10
```
Expected: all pass (the `PtyBroker` change must not break `ShepherdRemoteTests`).

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/AgentStore.swift spike/seam1/Sources/PtyBroker.swift spike/seam1/Helper/ControlClient.swift
git commit -m "feat(control): view — agent transcript tail / shell ring tail

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Hand the user the runtime check**

`shepherdd view p2 --lines 20` on an agent pane (transcript); on a shell pane with serving on (ring).

> Deferred (spec): `--follow` (single-shot only in v1; a caller can poll `view`), and `--screen` rendered-grid snapshot (needs a libghostty cell-read API).

---

## Task 10: `config`

Unified `get`/`set`/`list` over the file backend (`theme`, `worktree-base`, bare ghostty keys → write file + live reload) and the app backend (`sleep.mode`, `serve.remote`).

**Files:**
- Modify: `spike/seam1/Sources/AgentStore.swift` (`controlRoute` `config` cases + a `configFilePath` + reload trigger)
- Modify: `spike/seam1/Helper/ControlClient.swift` (`buildRequest`, `printData`)

**Interfaces:**
- Consumes: `ControlConfigFile` (Task 4); `GhosttyApp.reloadConfig()` (`Ghostty.swift:87`); `SleepGuard.shared.mode` (`CaffeinateMode`); `AgentStore.isServing` / `setServing(_:)`.
- Produces: control verbs `config-get`, `config-set`, `config-list`.

- [ ] **Step 1: Find how `AgentStore` reaches `GhosttyApp` for reload**

Grep for `reloadConfig` call sites and the `GhosttyApp` instance the app holds (⌘⇧R handler). Record the exact accessor (e.g. `GhosttyApp.shared` or an app-level reference). Use it in Step 2. If reload must run from the App layer, post a `Notification` the ⌘⇧R handler already listens to, or call the same entry the menu command uses.

- [ ] **Step 2: Add config cases to `controlRoute`**

```swift
        case "config-get":
            guard let key = req["key"] as? String else { return ["ok": false, "error": "bad args"] }
            return ["ok": true, "data": ["key": key, "value": configGet(key) ?? NSNull(), "backend": configBackend(key)]]
        case "config-set":
            guard let key = req["key"] as? String, let value = req["value"] as? String
            else { return ["ok": false, "error": "bad args"] }
            guard configSet(key, value) else { return ["ok": false, "error": "unknown config key: \(key)"] }
            return ["ok": true, "data": NSNull()]
        case "config-list":
            return ["ok": true, "data": ["items": configList()]]
```
Add the config backend helpers (Control CLI section):
```swift
    private var configFilePath: String {
        (NSHomeDirectory() as NSString).appendingPathComponent(".config/shepherd/config")
    }
    private func configBackend(_ key: String) -> String {
        ["sleep.mode", "serve.remote"].contains(key) ? "app" : "file"
    }
    private func configGet(_ key: String) -> String? {
        switch key {
        case "sleep.mode":   return SleepGuard.shared.mode.rawValue
        case "serve.remote": return isServing ? "on" : "off"
        default:
            let text = (try? String(contentsOfFile: configFilePath, encoding: .utf8)) ?? ""
            return ControlConfigFile.get(key, from: text)
        }
    }
    private func configSet(_ key: String, _ value: String) -> Bool {
        switch key {
        case "sleep.mode":
            guard let m = CaffeinateMode(rawValue: value) else { return false }
            SleepGuard.shared.mode = m; return true
        case "serve.remote":
            setServing(value == "on" || value == "true"); return true
        default:
            let text = (try? String(contentsOfFile: configFilePath, encoding: .utf8)) ?? ""
            let out = ControlConfigFile.set(key, value, in: text)
            try? FileManager.default.createDirectory(
                atPath: (configFilePath as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
            guard (try? out.write(toFile: configFilePath, atomically: true, encoding: .utf8)) != nil else { return false }
            triggerConfigReload()   // implemented per Step 1's finding
            return true
        }
    }
    private func configList() -> [[String: Any]] {
        var items: [[String: Any]] = [
            ["key": "sleep.mode", "value": SleepGuard.shared.mode.rawValue, "backend": "app"],
            ["key": "serve.remote", "value": isServing ? "on" : "off", "backend": "app"],
        ]
        let text = (try? String(contentsOfFile: configFilePath, encoding: .utf8)) ?? ""
        for key in ["theme", "worktree-base"] {
            items.append(["key": key, "value": ControlConfigFile.get(key, from: text) ?? "", "backend": "file"])
        }
        return items
    }
```
Add `triggerConfigReload()` using Step 1's finding (example if a shared app exists):
```swift
    private func triggerConfigReload() {
        // Wire to the same entry ⌘⇧R uses (found in Step 1). Example:
        // GhosttyApp.shared?.reloadConfig()
    }
```

- [ ] **Step 3: CLI `buildRequest` + `printData`**

`buildRequest`:
```swift
    case "config":
        guard let sub = rest.first else { return nil }
        switch sub {
        case "get":  guard rest.count >= 2 else { return nil }; return ["cmd": "config-get", "key": rest[1]]
        case "set":  guard rest.count >= 3 else { return nil }; return ["cmd": "config-set", "key": rest[1], "value": rest[2]]
        case "list": return ["cmd": "config-list"]
        default: return nil
        }
```
`printData` (before generic fallback):
```swift
    if verb == "config", let d = data as? [String: Any] {
        if let items = d["items"] as? [[String: Any]] {
            for it in items { print("\(it["key"] as? String ?? "")\t= \(it["value"] as? String ?? "")\t(\(it["backend"] as? String ?? ""))") }
        } else if let v = d["value"] { print(v is NSNull ? "" : "\(v)") }
        return
    }
```

- [ ] **Step 4: Build + model tests**

`xcodegen generate`, app build, ModelTests. Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/AgentStore.swift spike/seam1/Helper/ControlClient.swift
git commit -m "feat(control): config get/set/list over file + app backends

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Hand the user the runtime check**

`shepherdd config list`; `shepherdd config set theme light` (chrome + grid repaint, agents survive); `shepherdd config set sleep.mode always`.

---

## Task 11: `wait`

Block until a pane reaches a target state. Implemented **client-side** by polling the `state` verb (Task 6), so the server stays strictly non-blocking.

**Files:**
- Modify: `spike/seam1/Helper/ControlClient.swift` (special-case `wait` before the normal round-trip)

**Interfaces:**
- Consumes: the `state` verb (`{"cmd":"state","pane":...} -> {"state":...}`).

- [ ] **Step 1: Add a `wait` fast-path in `runControl`**

In `Helper/ControlClient.swift`, at the top of `runControl` (right after resolving `sockPath`), add:
```swift
    if verb == "wait" { return runWait(Array(argv.dropFirst()), sockPath: sockPath) }
```
Add the function:
```swift
private func runWait(_ rest: [String], sockPath: String) -> Int32 {
    guard let pane = rest.first else {
        FileHandle.standardError.write(Data("usage: shepherd wait <pane> --state s[,s] [--timeout secs]\n".utf8)); return 64
    }
    var wanted: Set<String> = []
    if let i = rest.firstIndex(of: "--state"), i + 1 < rest.count {
        wanted = Set(rest[i + 1].split(separator: ",").map(String.init))
    }
    if rest.contains("--any-attention") { wanted.formUnion(["blocked", "need-to-check", "error"]) }
    guard !wanted.isEmpty else {
        FileHandle.standardError.write(Data("shepherd: wait needs --state or --any-attention\n".utf8)); return 64
    }
    var timeout = 300.0
    if let i = rest.firstIndex(of: "--timeout"), i + 1 < rest.count, let t = Double(rest[i + 1]) { timeout = t }

    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        guard let reply = roundTrip(sockPath: sockPath, request: ["cmd": "state", "pane": pane]),
              reply["ok"] as? Bool == true, let d = reply["data"] as? [String: Any],
              let s = d["state"] as? String else {
            FileHandle.standardError.write(Data("shepherd: cannot read state\n".utf8)); return 69
        }
        if wanted.contains(s) { print(s); return 0 }
        usleep(200_000)   // 200ms
    }
    FileHandle.standardError.write(Data("shepherd: wait timed out\n".utf8)); return 2
}
```
Change `roundTrip` from `private func` to internal (drop `private`) so `runWait` can call it.

- [ ] **Step 2: Build**

`xcodegen generate`, app build. Expected: `BUILD SUCCEEDED`.

- [ ] **Step 3: Commit**

```bash
git add spike/seam1/Helper/ControlClient.swift
git commit -m "feat(control): wait — client-side poll on pane state (timeout)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Hand the user the runtime check**

`shepherdd wait p2 --state idle --timeout 30`; `shepherdd wait p2 --any-attention`.

---

## Task 12: Safety guard (`--force`) on destructive-with-live-work + `tab-close`

Refuse `pane-close` / `tab-close` / `workspace-rm` when the target holds a live agent (state ≠ `shell`) or an uncommitted worktree, unless `--force`. Add the missing `tab-close` server verb here (routed through the existing `requestCloseTab` archive path when `--archive`).

**Files:**
- Modify: `spike/seam1/Sources/AgentStore.swift` (`controlRoute`: add guards + `tab-close`)
- Modify: `spike/seam1/Helper/ControlClient.swift` (`buildRequest`: pass `--force` / `--archive`)

**Interfaces:**
- Consumes: `Pane.state`, `hasLiveAgent(paneID:)` (`:851`), `requestCloseTab(_:inWorkspace:)` (`:571`), `deleteWorkspace(_:)`.

- [ ] **Step 1: Add a liveness check helper to `AgentStore`**

```swift
    private func paneHasLiveWork(_ paneID: String) -> Bool {
        guard let p = pane(paneID) else { return false }
        return p.state != .shell || (p.sessionID?.isEmpty == false)
    }
    private func workspaceHasLiveWork(_ wsID: String) -> Bool {
        guard let ws = workspaces.first(where: { $0.id == wsID }) else { return false }
        return ws.tabs.contains { $0.root.panes.contains { paneHasLiveWork($0.paneID) } }
    }
```

- [ ] **Step 2: Add guards to the existing destructive cases**

Replace the `pane-close` case body with:
```swift
        case "pane-close":
            guard let p = (req["pane"] as? String).flatMap(resolvePane) else { return ["ok": false, "error": "no such pane"] }
            if paneHasLiveWork(p), req["force"] as? Bool != true {
                return ["ok": false, "error": "pane has a live agent; pass --force to close anyway"]
            }
            applyRemoteCommand(.cmdClosePane(paneID: p)); return ["ok": true, "data": NSNull()]
```
Replace `workspace-rm`:
```swift
        case "workspace-rm":
            guard let ws = (req["workspace"] as? String).flatMap(resolveWorkspace)
            else { return ["ok": false, "error": "no such workspace"] }
            if workspaceHasLiveWork(ws), req["force"] as? Bool != true {
                return ["ok": false, "error": "workspace has live agents; pass --force to delete anyway"]
            }
            deleteWorkspace(ws); return ["ok": true, "data": NSNull()]
```
Add `tab-close`:
```swift
        case "tab-close":
            guard let t = (req["tab"] as? String).flatMap(resolveTab),
                  let wsID = workspaces.first(where: { $0.tabs.contains { $0.tabID == t } })?.id,
                  let tab = workspaces.first(where: { $0.id == wsID })?.tabs.first(where: { $0.tabID == t })
            else { return ["ok": false, "error": "no such tab"] }
            let live = tab.root.panes.contains { paneHasLiveWork($0.paneID) }
            if live, req["force"] as? Bool != true, req["archive"] as? Bool != true {
                return ["ok": false, "error": "tab has live work; pass --force (discard) or --archive"]
            }
            requestCloseTab(t, inWorkspace: wsID)   // presents Archive/Discard for worktrees; honors --archive intent
            return ["ok": true, "data": NSNull()]
```
> Note: confirm whether `requestCloseTab` shows an interactive sheet. If it does and `--force`/`--archive` is set, prefer a direct non-interactive close/archive entry (grep for the function `requestCloseTab` calls after the user picks "Discard"/"Archive" and call that directly). The CLI must never depend on a GUI sheet the caller can't answer.

- [ ] **Step 3: Pass the flags from the CLI**

In `buildRequest`, extend the `pane close`, `tab close`, and `workspace rm` builders to include `"force": rest.contains("--force")` and, for `tab close`, `"archive": rest.contains("--archive")`. Example for `pane`:
```swift
        case "close": return ["cmd": "pane-close", "pane": rest[1], "force": rest.contains("--force")]
```
And in the `tab` builder's `close`:
```swift
        case "close": guard rest.count >= 2 else { return nil }
            return ["cmd": "tab-close", "tab": rest[1], "force": rest.contains("--force"), "archive": rest.contains("--archive")]
```
And in `workspace` `rm`:
```swift
        case "rm": guard rest.count >= 2 else { return nil }; return ["cmd": "workspace-rm", "workspace": rest[1], "force": rest.contains("--force")]
```

- [ ] **Step 4: Build + model tests**

`xcodegen generate`, app build, ModelTests. Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/AgentStore.swift spike/seam1/Helper/ControlClient.swift
git commit -m "feat(control): --force guard on destructive-with-live-work; tab close/archive

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Hand the user the runtime check**

`shepherdd pane close p2` on a live agent → refuses; `--force` closes; `shepherdd tab close t3 --archive`.

---

## Task 13: `shepherd` name on PATH + docs

Expose the binary as `shepherd`, and document the CLI (README + CLAUDE.md pointer + a plugin/skill note so Claude discovers it).

**Files:**
- Create: `scripts/install-shepherd-cli.sh`
- Modify: `README.md` (a "Control CLI" section)
- Modify: `CLAUDE.md` (a short pointer under Architecture)
- Create: `docs/control-cli.md` (verb reference)

**Interfaces:** none (docs + install).

- [ ] **Step 1: Install script**

Create `scripts/install-shepherd-cli.sh`:
```bash
#!/usr/bin/env bash
# Symlink the built shepherdd helper onto PATH as `shepherd`.
set -euo pipefail
APP="${1:-spike/seam1/build/Build/Products/Debug/Shepherd.app}"
BIN="$APP/Contents/Resources/shepherdd"
[ -x "$BIN" ] || BIN="$APP/Contents/MacOS/shepherdd"
mkdir -p "$HOME/.local/bin"
ln -sf "$BIN" "$HOME/.local/bin/shepherd"
echo "linked $HOME/.local/bin/shepherd -> $BIN"
echo "ensure ~/.local/bin is on PATH"
```
Make it executable: `chmod +x scripts/install-shepherd-cli.sh`.
> Note: confirm where the `shepherdd` executable lands in the bundle (the `copy: destination: executables` in `project.yml` puts it under `Contents/Executables/` on some setups) — adjust the `BIN` candidates after checking `find spike/seam1/build/Build/Products/Debug/Shepherd.app -name shepherdd`.

- [ ] **Step 2: Verb reference doc**

Create `docs/control-cli.md` documenting every verb, its args/flags, and the JSON protocol (copy the "Control protocol" section from the spec + a table of verbs from Tasks 6–12). Include the orchestration example from the spec.

- [ ] **Step 3: README + CLAUDE.md pointers**

Add a short "Control CLI" section to `README.md` (what it is, `install-shepherd-cli.sh`, a couple of examples) and a one-paragraph pointer in `CLAUDE.md` under Architecture referencing `docs/control-cli.md` and `Sources/ControlServer.swift`.

- [ ] **Step 4: Commit**

```bash
git add scripts/install-shepherd-cli.sh docs/control-cli.md README.md CLAUDE.md
git commit -m "docs(control): shepherd CLI install script + verb reference

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Hand the user the final acceptance run**

After a rebuild + relaunch + `./scripts/install-shepherd-cli.sh`, exercise the orchestration loop from the spec:
```bash
shepherd ls
p=$(shepherd tab new --json 2>/dev/null || shepherd tab new)   # note the returned pane handle
shepherd tell <pane> "cd ~/repo && claude"
shepherd wait <pane> --state idle --timeout 60
shepherd tell <pane> "run the test suite"
shepherd wait <pane> --any-attention --timeout 900
shepherd view <pane> --lines 60
```

---

## Self-Review

**1. Spec coverage** (each spec section → task):
- Transport / local unix socket / `$SHEPHERD_CTL_SOCK` + fallback → Task 5. ✅
- Reuse `ControlMessage` application → Tasks 7/12 (`applyRemoteCommand`). ✅
- Short stable handles + UUID + `whoami` → Tasks 1, 6. ✅
- `ls` discovery → Task 6. ✅
- Structure (workspace/tab/pane/split/focus/zoom) → Task 7. ✅
- `tell` (raw inject + Enter, `--no-enter`) → Task 8; `--raw` explicitly deferred with rationale. ✅
- `view` target-aware (agent transcript via recall parse / shell ring) → Tasks 2, 3, 9; `--follow`/`--screen` deferred. ✅
- `config` unified file+app namespace + live reload → Tasks 4, 10. ✅
- `wait` orchestration primitive → Task 11. ✅
- Safety: one `--force` guard, no interactive prompts → Task 12. ✅
- `shepherd` on PATH + docs → Task 13. ✅

**2. Placeholder scan:** No "TBD/handle later" left in code steps. Three explicit `> Note:` verification hooks remain where the plan depends on an accessor name the mapping agents didn't fully pin down (`Tab.displayTitle`/`focusedPaneID`, the reload entry `AgentStore` uses, `requestCloseTab`'s interactivity, and the bundle path of `shepherdd`). Each note gives the exact grep + fallback so the implementer resolves it in-task rather than guessing — these are real integration seams, not hidden work.

**3. Type consistency:** Verb request/response field names (`pane`, `tab`, `workspace`, `name`, `axis`, `text`, `enter`, `lines`, `raw`, `force`, `archive`, `key`, `value`) are used identically in each task's `controlRoute` case and its `buildRequest` builder. Handle kinds (`ws`/`t`/`p`) and `AgentState` raw values (`need-to-check` etc.) match the codebase. `roundTrip` visibility is explicitly widened in Task 11 for reuse.

**Known scope note:** shell-pane `view` requires serving (the capture ring only exists then) — documented in Task 9's error message and deferred notes, consistent with the current PTY-broker architecture; agent-pane `view` (the primary use) always works.
