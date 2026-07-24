# In-app Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shepherd checks GitHub Releases daily, shows an "update available" pill at the bottom of the sidebar (and a Settings "Check for Updates" panel), then downloads + swaps + relaunches itself in place — with restart-now / restart-when-idle, skip-this-version, and an auto-check toggle.

**Architecture:** Hand-rolled native updater. Pure model files (`Version`, `IdlePolicy`, the parse/choose/script bits of `UpdateService`/`UpdateInstaller`) are unit-tested with no AppKit; the IO (URLSession/Process), the `@MainActor UpdateController` state machine, and the SwiftUI chrome are thin shells over them. Trust anchor is HTTPS from the public `eshaanshah1/shepherd` repo — no auth token, no `gh`.

**Tech Stack:** Swift 5, SwiftUI/AppKit, Foundation `URLSession`/`Process`, libghostty C API (`ghostty_surface_needs_confirm_quit`), XCTest, xcodegen, GitHub Actions.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-24-auto-update-design.md`.
- All app sources live in `spike/seam1/Sources/`; tests in `spike/seam1/Tests/`.
- **`xcodegen generate` after adding/removing any source file** (run in `spike/seam1/`), or the file isn't compiled.
- A new compiled **source** must be added to the target's explicit `sources:` list in `project.yml` (both the `Shepherd` app target picks up `Sources/` via glob, but the **test target lists files explicitly**).
- Build/verify (from `spike/seam1/`):
  ```sh
  xcodegen generate
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
    -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
    CLANG_MODULE_CACHE_PATH=./build/ModuleCache build
  ```
  Unit tests:
  ```sh
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd \
    -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
    CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
    -only-testing:ShepherdModelTests test
  ```
- **Do not `killall`/relaunch the running app** — verify by compile + unit tests; runtime checks (the real swap/relaunch) are the user's to run.
- SourceKit "cannot find type" noise is stale; `xcodebuild` is ground truth.
- libghostty C calls happen on the main thread.
- UI colors come from `Theme.swift`; sidebar SwiftUI controls stay `.focusable(false)`.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Repo: `eshaanshah1/shepherd` (public). Release assets: `Shepherd.zip` (ditto archive) + `Shepherd.dmg`. Version tags look like `v0.4.0`.

---

## File Structure

**Create:**
- `Sources/Version.swift` — pure semver parse/compare, `AppVersion.current`, `shouldSurface(available:skipped:)`.
- `Sources/IdlePolicy.swift` — pure per-pane restart-gate decision.
- `Sources/UpdateService.swift` — GitHub release JSON parse/choose (pure) + `checkForUpdate`/`download` (IO).
- `Sources/UpdateInstaller.swift` — pure swap-script text + `install()` (IO).
- `Sources/UpdateController.swift` — `@MainActor ObservableObject` state machine + cadence + skip + toggle + countdown (app-only).
- `Sources/UpdatePillView.swift` — the sidebar-footer pill + its popover.
- `Tests/VersionTests.swift`, `Tests/IdlePolicyTests.swift`, `Tests/UpdateServiceTests.swift`, `Tests/UpdateInstallerTests.swift`.

**Modify:**
- `Sources/Ghostty.swift` — `GhosttyApp.paneIDsRunningProcess()`.
- `Sources/GhosttyTerminal.swift` — `GhosttySurfaceView.hasForegroundProcess`.
- `Sources/AgentStore.swift` — `allPanesIdle()`.
- `Sources/SidebarView.swift` — mount the pill above the archived footer.
- `Sources/SettingsView.swift` — "Software Update" section in `GeneralSettings`.
- `Sources/ShepherdApp.swift` — create/inject `UpdateController`, kick off `startIfEligible()`.
- `spike/seam1/project.yml` — add new sources to the test target; local version sentinel `0.0.0-dev`.
- `.github/workflows/release.yml` — stamp the real version into the built bundle.

---

## Task 1: Version model (pure)

**Files:**
- Create: `spike/seam1/Sources/Version.swift`
- Create: `spike/seam1/Tests/VersionTests.swift`
- Modify: `spike/seam1/project.yml` (add `Version.swift` to `ShepherdModelTests.sources`)

**Interfaces:**
- Produces:
  - `struct Version: Comparable, Equatable, CustomStringConvertible { init?(_ raw: String); let major, minor, patch: Int; let isPrerelease: Bool }`
  - `enum AppVersion { static var current: Version }`
  - `func shouldSurface(available: Version, skipped: Version?) -> Bool`

- [ ] **Step 1: Write the failing test**

Create `spike/seam1/Tests/VersionTests.swift`:
```swift
import XCTest
@testable import Shepherd

final class VersionTests: XCTestCase {
    func testParsesWithAndWithoutVPrefix() {
        XCTAssertEqual(Version("v0.4.0"), Version("0.4.0"))
        XCTAssertEqual(Version("1.2.3")?.description, "1.2.3")
    }

    func testInvalidReturnsNil() {
        XCTAssertNil(Version("garbage"))
        XCTAssertNil(Version(""))
    }

    func testOrdering() {
        XCTAssertLessThan(Version("0.4.0")!, Version("0.4.1")!)
        XCTAssertLessThan(Version("0.4.0")!, Version("0.5.0")!)
        XCTAssertLessThan(Version("0.9.0")!, Version("1.0.0")!)
    }

    func testPrereleaseSortsBelowRelease() {
        XCTAssertTrue(Version("0.0.0-dev")!.isPrerelease)
        XCTAssertLessThan(Version("1.2.3-dev")!, Version("1.2.3")!)
        XCTAssertLessThan(Version("0.0.0-dev")!, Version("0.1.0")!)
    }

    func testShouldSurface() {
        XCTAssertTrue(shouldSurface(available: Version("0.5.0")!, skipped: nil))
        XCTAssertFalse(shouldSurface(available: Version("0.5.0")!, skipped: Version("0.5.0")!))
        XCTAssertTrue(shouldSurface(available: Version("0.6.0")!, skipped: Version("0.5.0")!))
    }
}
```

- [ ] **Step 2: Add the file to the test target and confirm the test fails to build**

Edit `spike/seam1/project.yml`: under `ShepherdModelTests` → `sources`, add a line after `- path: Sources/StopPolicy.swift`:
```yaml
      - path: Sources/Version.swift
```
Then:
```sh
cd spike/seam1 && xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -derivedDataPath ./build \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  -only-testing:ShepherdModelTests test
```
Expected: BUILD FAILS (`cannot find 'Version' in scope`).

- [ ] **Step 3: Write the implementation**

Create `spike/seam1/Sources/Version.swift`:
```swift
import Foundation

/// A tolerant semver: `major.minor.patch` with an optional `-suffix` (any
/// dash-suffixed build, e.g. `-dev`, counts as a prerelease and sorts *below*
/// the same numeric release). Accepts an optional leading `v`.
struct Version: Comparable, Equatable, CustomStringConvertible {
    let major: Int
    let minor: Int
    let patch: Int
    let isPrerelease: Bool

    init?(_ raw: String) {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if s.hasPrefix("v") || s.hasPrefix("V") { s.removeFirst() }
        let pre = s.contains("-")
        let core = s.split(separator: "-", maxSplits: 1).first.map(String.init) ?? s
        let parts = core.split(separator: ".").map { Int($0) }
        guard parts.count >= 1, parts.count <= 3, !parts.contains(nil) else { return nil }
        major = parts[0]!
        minor = parts.count > 1 ? parts[1]! : 0
        patch = parts.count > 2 ? parts[2]! : 0
        isPrerelease = pre
    }

    var description: String { "\(major).\(minor).\(patch)" + (isPrerelease ? "-pre" : "") }

    static func < (a: Version, b: Version) -> Bool {
        if a.major != b.major { return a.major < b.major }
        if a.minor != b.minor { return a.minor < b.minor }
        if a.patch != b.patch { return a.patch < b.patch }
        // same numeric core: a prerelease is older than the final release
        if a.isPrerelease != b.isPrerelease { return a.isPrerelease }
        return false
    }
}

/// The running app's version, read from the bundle. Falls back to a dev
/// sentinel so a mis-stamped build never claims to be a real release.
enum AppVersion {
    static var current: Version {
        let raw = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
        return raw.flatMap(Version.init) ?? Version("0.0.0-dev")!
    }
}

/// Should an available update be surfaced *automatically*, given the version the
/// user last chose to skip? Anything strictly newer than a skipped version (or
/// nothing skipped) surfaces; the exact skipped version stays hidden.
func shouldSurface(available: Version, skipped: Version?) -> Bool {
    guard let skipped else { return true }
    return available > skipped
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run the `-only-testing:ShepherdModelTests test` command from Step 2.
Expected: PASS (`VersionTests` green).

- [ ] **Step 5: Commit**

```sh
cd /Users/eshaannileshshah/Home/dev/tools/shepherd
git add spike/seam1/Sources/Version.swift spike/seam1/Tests/VersionTests.swift spike/seam1/project.yml
git commit -m "$(cat <<'EOF'
feat(update): semver Version model + skip decision

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Idle policy (pure) + surface plumbing

**Files:**
- Create: `spike/seam1/Sources/IdlePolicy.swift`
- Create: `spike/seam1/Tests/IdlePolicyTests.swift`
- Modify: `spike/seam1/Sources/GhosttyTerminal.swift` (add `hasForegroundProcess`)
- Modify: `spike/seam1/Sources/Ghostty.swift` (add `paneIDsRunningProcess()`)
- Modify: `spike/seam1/Sources/AgentStore.swift` (add `allPanesIdle()`)
- Modify: `spike/seam1/project.yml` (add `IdlePolicy.swift` to `ShepherdModelTests.sources`)

**Interfaces:**
- Consumes: `AgentState` (cases `shell/working/blocked/needsCheck/idle/error`).
- Produces:
  - `enum IdlePolicy { static func paneBlocksRestart(state: AgentState, shellHasForegroundProcess: Bool) -> Bool; static func allIdle(_ panes: [(state: AgentState, shellHasForegroundProcess: Bool)]) -> Bool }`
  - `var GhosttySurfaceView.hasForegroundProcess: Bool`
  - `func GhosttyApp.paneIDsRunningProcess() -> Set<String>`
  - `func AgentStore.allPanesIdle() -> Bool`

- [ ] **Step 1: Write the failing test**

Create `spike/seam1/Tests/IdlePolicyTests.swift`:
```swift
import XCTest
@testable import Shepherd

final class IdlePolicyTests: XCTestCase {
    func testAgentStatesGateCorrectly() {
        // A live agent still running/waiting blocks a restart.
        XCTAssertTrue(IdlePolicy.paneBlocksRestart(state: .working, shellHasForegroundProcess: false))
        XCTAssertTrue(IdlePolicy.paneBlocksRestart(state: .blocked, shellHasForegroundProcess: false))
        // A finished/idle/errored agent does NOT block — sessions resume on relaunch.
        XCTAssertFalse(IdlePolicy.paneBlocksRestart(state: .idle, shellHasForegroundProcess: true))
        XCTAssertFalse(IdlePolicy.paneBlocksRestart(state: .needsCheck, shellHasForegroundProcess: true))
        XCTAssertFalse(IdlePolicy.paneBlocksRestart(state: .error, shellHasForegroundProcess: true))
    }

    func testShellPaneGatedByForegroundProcess() {
        XCTAssertTrue(IdlePolicy.paneBlocksRestart(state: .shell, shellHasForegroundProcess: true))
        XCTAssertFalse(IdlePolicy.paneBlocksRestart(state: .shell, shellHasForegroundProcess: false))
    }

    func testAllIdle() {
        XCTAssertTrue(IdlePolicy.allIdle([(.idle, false), (.shell, false), (.needsCheck, true)]))
        XCTAssertFalse(IdlePolicy.allIdle([(.idle, false), (.working, false)]))
        XCTAssertFalse(IdlePolicy.allIdle([(.shell, true)]))
        XCTAssertTrue(IdlePolicy.allIdle([]))
    }
}
```

- [ ] **Step 2: Add to test target and confirm build failure**

Edit `spike/seam1/project.yml`: under `ShepherdModelTests` → `sources`, add:
```yaml
      - path: Sources/IdlePolicy.swift
```
Run the `-only-testing:ShepherdModelTests test` command (Task 1 Step 2).
Expected: BUILD FAILS (`cannot find 'IdlePolicy'`).

- [ ] **Step 3: Write the pure policy**

Create `spike/seam1/Sources/IdlePolicy.swift`:
```swift
import Foundation

/// Decides whether the app may auto-restart to install an update. "Idle" means:
/// no agent is actively working or waiting on the user, and no plain shell pane
/// has a live foreground command. A *finished* agent (idle/need-to-check/error)
/// never blocks — its Claude session and the layout are restored on relaunch, so
/// a restart is safe. Mirrors the pure-decision pattern of SleepPolicy/StopPolicy.
enum IdlePolicy {
    static func paneBlocksRestart(state: AgentState, shellHasForegroundProcess: Bool) -> Bool {
        switch state {
        case .working, .blocked: return true
        case .shell:             return shellHasForegroundProcess
        case .idle, .needsCheck, .error: return false
        }
    }

    static func allIdle(_ panes: [(state: AgentState, shellHasForegroundProcess: Bool)]) -> Bool {
        !panes.contains { paneBlocksRestart(state: $0.state, shellHasForegroundProcess: $0.shellHasForegroundProcess) }
    }
}
```

- [ ] **Step 4: Run tests, confirm the pure policy passes**

Run the `-only-testing:ShepherdModelTests test` command.
Expected: PASS.

- [ ] **Step 5: Add the surface plumbing (app target, not unit-tested)**

In `spike/seam1/Sources/GhosttyTerminal.swift`, add a computed property to `GhosttySurfaceView` (near the `private var surface: ghostty_surface_t?` declaration around line 38):
```swift
    /// True when this surface has a running foreground command that isn't the
    /// idle shell (libghostty's own quit-confirmation signal). Main thread only.
    var hasForegroundProcess: Bool {
        guard let surface else { return false }
        return ghostty_surface_needs_confirm_quit(surface)
    }
```

In `spike/seam1/Sources/Ghostty.swift`, add a method to `GhosttyApp` right after `func unregister(...)` (around line 17):
```swift
    /// Pane ids whose live surface is running a foreground command. Main thread only.
    func paneIDsRunningProcess() -> Set<String> {
        var running = Set<String>()
        for v in surfaceViews.allObjects where v.hasForegroundProcess { running.insert(v.paneID) }
        return running
    }
```

In `spike/seam1/Sources/AgentStore.swift`, add a method (place it near the workspace-spanning helpers, after `currentWorkspace` around line 203):
```swift
    /// Is every pane across every workspace idle enough to restart for an update?
    /// Combines tracked agent state with libghostty's foreground-process signal
    /// for plain shell panes (IdlePolicy).
    func allPanesIdle() -> Bool {
        let running = GhosttyApp.shared.paneIDsRunningProcess()
        let inputs = workspaces.flatMap { $0.tabs }.flatMap { $0.root.panes }.map {
            (state: $0.state, shellHasForegroundProcess: running.contains($0.id))
        }
        return IdlePolicy.allIdle(inputs)
    }
```

- [ ] **Step 6: Build the app target, confirm it compiles**

```sh
cd spike/seam1 && xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache build
```
Expected: BUILD SUCCEEDED.

- [ ] **Step 7: Commit**

```sh
cd /Users/eshaannileshshah/Home/dev/tools/shepherd
git add spike/seam1/Sources/IdlePolicy.swift spike/seam1/Tests/IdlePolicyTests.swift \
  spike/seam1/Sources/GhosttyTerminal.swift spike/seam1/Sources/Ghostty.swift \
  spike/seam1/Sources/AgentStore.swift spike/seam1/project.yml
git commit -m "$(cat <<'EOF'
feat(update): idle-gate policy + libghostty foreground-process probe

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: UpdateService (release check + download)

**Files:**
- Create: `spike/seam1/Sources/UpdateService.swift`
- Create: `spike/seam1/Tests/UpdateServiceTests.swift`
- Modify: `spike/seam1/project.yml` (add `UpdateService.swift` to `ShepherdModelTests.sources`)

**Interfaces:**
- Consumes: `Version`, `AppVersion` (Task 1).
- Produces:
  - `struct UpdateAvailable: Equatable { let version: Version; let tag: String; let notes: String; let zipURL: URL }`
  - `enum UpdateService { static func parseRelease(_ data: Data) -> (tag: String, notes: String, zipURL: URL)?; static func chooseUpdate(current: Version, releaseData: Data) -> UpdateAvailable?; static func checkForUpdate(current: Version) async -> UpdateAvailable?; static func download(_ update: UpdateAvailable, progress: @escaping (Double) -> Void) async throws -> String }`

- [ ] **Step 1: Write the failing test**

Create `spike/seam1/Tests/UpdateServiceTests.swift`:
```swift
import XCTest
@testable import Shepherd

final class UpdateServiceTests: XCTestCase {
    private func releaseJSON(tag: String, hasZip: Bool = true) -> Data {
        var assets = #"{"name":"Shepherd.dmg","browser_download_url":"https://example.com/Shepherd.dmg"}"#
        if hasZip {
            assets += "," + #"{"name":"Shepherd.zip","browser_download_url":"https://example.com/Shepherd.zip"}"#
        }
        return """
        {"tag_name":"\(tag)","body":"## Notes\\nfixed things","assets":[\(assets)]}
        """.data(using: .utf8)!
    }

    func testParsesTagNotesAndZipAsset() {
        let r = UpdateService.parseRelease(releaseJSON(tag: "v0.5.0"))
        XCTAssertEqual(r?.tag, "v0.5.0")
        XCTAssertEqual(r?.notes.contains("fixed things"), true)
        XCTAssertEqual(r?.zipURL.absoluteString, "https://example.com/Shepherd.zip")
    }

    func testMissingZipAssetReturnsNil() {
        XCTAssertNil(UpdateService.parseRelease(releaseJSON(tag: "v0.5.0", hasZip: false)))
    }

    func testChoosesOnlyNewer() {
        XCTAssertNotNil(UpdateService.chooseUpdate(current: Version("0.4.0")!, releaseData: releaseJSON(tag: "v0.5.0")))
        XCTAssertNil(UpdateService.chooseUpdate(current: Version("0.5.0")!, releaseData: releaseJSON(tag: "v0.5.0")))
        XCTAssertNil(UpdateService.chooseUpdate(current: Version("0.6.0")!, releaseData: releaseJSON(tag: "v0.5.0")))
    }

    func testChosenUpdateCarriesFields() {
        let u = UpdateService.chooseUpdate(current: Version("0.4.0")!, releaseData: releaseJSON(tag: "v0.5.0"))
        XCTAssertEqual(u?.version, Version("0.5.0"))
        XCTAssertEqual(u?.tag, "v0.5.0")
        XCTAssertEqual(u?.zipURL.absoluteString, "https://example.com/Shepherd.zip")
    }
}
```

- [ ] **Step 2: Add to test target, confirm build failure**

Edit `project.yml`: add under `ShepherdModelTests.sources`:
```yaml
      - path: Sources/UpdateService.swift
```
Run `-only-testing:ShepherdModelTests test`. Expected: BUILD FAILS (`cannot find 'UpdateService'`).

- [ ] **Step 3: Write the implementation**

Create `spike/seam1/Sources/UpdateService.swift`:
```swift
import Foundation

struct UpdateAvailable: Equatable {
    let version: Version
    let tag: String
    let notes: String
    let zipURL: URL
}

/// Checks the public repo's latest GitHub Release and downloads/unpacks its
/// `Shepherd.zip`. Pure parsing (`parseRelease`/`chooseUpdate`) is unit-tested;
/// `checkForUpdate`/`download` are the URLSession/Process shell.
enum UpdateService {
    static let releaseAPI = URL(string: "https://api.github.com/repos/eshaanshah1/shepherd/releases/latest")!
    static let zipAssetName = "Shepherd.zip"

    private struct Release: Decodable {
        let tag_name: String
        let body: String?
        let assets: [Asset]
        struct Asset: Decodable { let name: String; let browser_download_url: String }
    }

    /// Decode the release JSON and locate the `Shepherd.zip` asset. Returns nil
    /// if the JSON is malformed or the zip asset is absent.
    static func parseRelease(_ data: Data) -> (tag: String, notes: String, zipURL: URL)? {
        guard let r = try? JSONDecoder().decode(Release.self, from: data),
              let asset = r.assets.first(where: { $0.name == zipAssetName }),
              let url = URL(string: asset.browser_download_url) else { return nil }
        return (r.tag_name, r.body ?? "", url)
    }

    /// The release as an `UpdateAvailable` iff its version is strictly newer than `current`.
    static func chooseUpdate(current: Version, releaseData: Data) -> UpdateAvailable? {
        guard let parsed = parseRelease(releaseData),
              let v = Version(parsed.tag), v > current else { return nil }
        return UpdateAvailable(version: v, tag: parsed.tag, notes: parsed.notes, zipURL: parsed.zipURL)
    }

    /// Hit the GitHub API and return a newer update, or nil (no update / any failure).
    static func checkForUpdate(current: Version) async -> UpdateAvailable? {
        var req = URLRequest(url: releaseAPI)
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("Shepherd", forHTTPHeaderField: "User-Agent")
        req.timeoutInterval = 15
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return chooseUpdate(current: current, releaseData: data)
    }

    enum UpdateError: Error { case download, unpack, verify }

    /// Stream the zip to a temp file (progress 0…1), unpack with `ditto`, and
    /// `codesign --verify` the unpacked bundle. Returns the unpacked .app path.
    static func download(_ update: UpdateAvailable, progress: @escaping (Double) -> Void) async throws -> String {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("shepherd-update-\(update.tag)", isDirectory: true)
        try? FileManager.default.removeItem(at: tmp)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        let zipPath = tmp.appendingPathComponent("Shepherd.zip")

        // Stream download with progress against Content-Length.
        let (bytes, resp) = try await URLSession.shared.bytes(from: update.zipURL)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw UpdateError.download }
        let total = resp.expectedContentLength
        FileManager.default.createFile(atPath: zipPath.path, contents: nil)
        let handle = try FileHandle(forWritingTo: zipPath)
        defer { try? handle.close() }
        var buf = Data(); var received: Int64 = 0
        for try await byte in bytes {
            buf.append(byte); received += 1
            if buf.count >= 64 * 1024 { try handle.write(contentsOf: buf); buf.removeAll(keepingCapacity: true) }
            if total > 0 { progress(min(1.0, Double(received) / Double(total))) }
        }
        if !buf.isEmpty { try handle.write(contentsOf: buf) }
        try handle.close()

        // Unpack (ditto preserves the bundle's symlinks/permissions).
        let unpackDir = tmp.appendingPathComponent("unpacked", isDirectory: true)
        try FileManager.default.createDirectory(at: unpackDir, withIntermediateDirectories: true)
        guard run("/usr/bin/ditto", ["-x", "-k", zipPath.path, unpackDir.path]) == 0 else { throw UpdateError.unpack }
        let appPath = unpackDir.appendingPathComponent("Shepherd.app").path
        guard FileManager.default.fileExists(atPath: appPath) else { throw UpdateError.unpack }

        // Corruption check only (ad-hoc signature; no identity guarantee).
        guard run("/usr/bin/codesign", ["--verify", "--deep", appPath]) == 0 else { throw UpdateError.verify }
        return appPath
    }

    @discardableResult
    private static func run(_ tool: String, _ args: [String]) -> Int32 {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = args
        p.standardOutput = Pipe(); p.standardError = Pipe()
        do { try p.run() } catch { return -1 }
        p.waitUntilExit()
        return p.terminationStatus
    }
}
```

- [ ] **Step 4: Run tests, confirm pass**

Run `-only-testing:ShepherdModelTests test`. Expected: PASS (`UpdateServiceTests` green).

- [ ] **Step 5: Commit**

```sh
cd /Users/eshaannileshshah/Home/dev/tools/shepherd
git add spike/seam1/Sources/UpdateService.swift spike/seam1/Tests/UpdateServiceTests.swift spike/seam1/project.yml
git commit -m "$(cat <<'EOF'
feat(update): GitHub release check + zip download/unpack/verify

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: UpdateInstaller (swap-and-relaunch)

**Files:**
- Create: `spike/seam1/Sources/UpdateInstaller.swift`
- Create: `spike/seam1/Tests/UpdateInstallerTests.swift`
- Modify: `spike/seam1/project.yml` (add `UpdateInstaller.swift` to `ShepherdModelTests.sources`)

**Interfaces:**
- Produces:
  - `enum UpdateInstaller { static func swapScript(pid: Int32, newBundle: String, installedPath: String, logPath: String) -> String; static func install(newBundle: String, installedPath: String) }`

- [ ] **Step 1: Write the failing test**

Create `spike/seam1/Tests/UpdateInstallerTests.swift`:
```swift
import XCTest
@testable import Shepherd

final class UpdateInstallerTests: XCTestCase {
    func testSwapScriptContainsRequiredSteps() {
        let s = UpdateInstaller.swapScript(
            pid: 4242,
            newBundle: "/tmp/unpacked/Shepherd.app",
            installedPath: "/Applications/Shepherd.app",
            logPath: "/tmp/shepherd-update.log")
        XCTAssertTrue(s.contains("kill -0 4242"))                       // waits for the app to quit
        XCTAssertTrue(s.contains("ditto \"/tmp/unpacked/Shepherd.app\" \"/Applications/Shepherd.app\""))
        XCTAssertTrue(s.contains("xattr -dr com.apple.quarantine \"/Applications/Shepherd.app\""))
        XCTAssertTrue(s.contains("open \"/Applications/Shepherd.app\""))
        XCTAssertTrue(s.contains("/tmp/shepherd-update.log"))
    }

    func testSwapScriptOverwriteIsAfterWait() {
        let s = UpdateInstaller.swapScript(pid: 1, newBundle: "/a/Shepherd.app",
                                           installedPath: "/b/Shepherd.app", logPath: "/tmp/x.log")
        let waitIdx = s.range(of: "kill -0 1")!.lowerBound
        let dittoIdx = s.range(of: "ditto \"/a/Shepherd.app\"")!.lowerBound
        XCTAssertLessThan(waitIdx, dittoIdx)  // never overwrite before the app has exited
    }
}
```

- [ ] **Step 2: Add to test target, confirm build failure**

Edit `project.yml`: add under `ShepherdModelTests.sources`:
```yaml
      - path: Sources/UpdateInstaller.swift
```
Run `-only-testing:ShepherdModelTests test`. Expected: BUILD FAILS (`cannot find 'UpdateInstaller'`).

- [ ] **Step 3: Write the implementation**

Create `spike/seam1/Sources/UpdateInstaller.swift`:
```swift
import Foundation
import AppKit

/// Installs a downloaded update by launching a detached bash script that waits
/// for this app to quit, overwrites the installed bundle, strips quarantine
/// (the app is ad-hoc signed / not notarized), and relaunches. The destructive
/// overwrite is the LAST step, so any earlier failure leaves the old app intact.
enum UpdateInstaller {
    /// Pure: the detached script's text. Unit-tested.
    static func swapScript(pid: Int32, newBundle: String, installedPath: String, logPath: String) -> String {
        """
        #!/bin/bash
        exec >> "\(logPath)" 2>&1
        echo "[$(date)] waiting for pid \(pid) to exit"
        while kill -0 \(pid) 2>/dev/null; do sleep 0.2; done
        echo "[$(date)] swapping bundle"
        rm -rf "\(installedPath)"
        ditto "\(newBundle)" "\(installedPath)" || { echo "ditto failed"; exit 1; }
        xattr -dr com.apple.quarantine "\(installedPath)" 2>/dev/null
        echo "[$(date)] relaunching"
        open "\(installedPath)"
        """
    }

    /// Write the script and launch it detached; the caller then terminates the app.
    static func install(newBundle: String, installedPath: String) {
        let pid = ProcessInfo.processInfo.processIdentifier
        let logPath = "/tmp/shepherd-update.log"
        let scriptPath = (NSTemporaryDirectory() as NSString).appendingPathComponent("shepherd-swap.sh")
        let script = swapScript(pid: pid, newBundle: newBundle, installedPath: installedPath, logPath: logPath)
        try? script.write(toFile: scriptPath, atomically: true, encoding: .utf8)

        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [scriptPath]
        // Detach so it outlives this process (which is about to terminate).
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try? p.run()
    }
}
```

- [ ] **Step 4: Run tests, confirm pass**

Run `-only-testing:ShepherdModelTests test`. Expected: PASS.

- [ ] **Step 5: Commit**

```sh
cd /Users/eshaannileshshah/Home/dev/tools/shepherd
git add spike/seam1/Sources/UpdateInstaller.swift spike/seam1/Tests/UpdateInstallerTests.swift spike/seam1/project.yml
git commit -m "$(cat <<'EOF'
feat(update): detached swap-and-relaunch installer

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: UpdateController (state machine + cadence + skip + toggle + countdown)

**Files:**
- Create: `spike/seam1/Sources/UpdateController.swift`

**Interfaces:**
- Consumes: `AppVersion`, `Version`, `shouldSurface` (Task 1); `AgentStore.allPanesIdle()` (Task 2); `UpdateService`, `UpdateAvailable` (Task 3); `UpdateInstaller` (Task 4).
- Produces (bound by UI in Tasks 7/8):
  - `@MainActor final class UpdateController: ObservableObject { static let shared: UpdateController }`
  - `enum UpdatePhase: Equatable { case idle, checking, available(UpdateAvailable), downloading(Double), readyToRestart(UpdateAvailable), restarting, upToDate, error(String) }`
  - `@Published var phase; @Published var restartWhenIdle: Bool; @Published var countdown: Int?`
  - `var autoCheckEnabled: Bool { get set }`; `var hasSidebarPill: Bool { get }`
  - `func startIfEligible(); func checkNow() async; func beginDownload(); func skipCurrent(); func restartNow(); func armRestartWhenIdle(); func cancelRestart(); func dismissTransient()`

This is an app-only orchestration file (timers + `@MainActor` + AppKit); it is not unit-tested — its pure dependencies already are. Verify by building the app target.

- [ ] **Step 1: Write the implementation**

Create `spike/seam1/Sources/UpdateController.swift`:
```swift
import Foundation
import AppKit
import Combine

enum UpdatePhase: Equatable {
    case idle
    case checking
    case available(UpdateAvailable)
    case downloading(Double)
    case readyToRestart(UpdateAvailable)
    case restarting
    case upToDate
    case error(String)
}

/// Owns the update lifecycle the UI binds to: daily cadence, the skip-this-
/// version filter, the auto-check toggle, background download, and the
/// restart-now / restart-when-idle countdown. Dormant unless the running build
/// is an eligible release in a writable /Applications location.
@MainActor
final class UpdateController: ObservableObject {
    static let shared = UpdateController()

    @Published private(set) var phase: UpdatePhase = .idle
    @Published private(set) var restartWhenIdle = false
    @Published private(set) var countdown: Int? = nil

    private let lastCheckKey = "shepherd.update.lastCheck"
    private let skippedKey = "shepherd.update.skippedVersion"
    private let autoKey = "shepherd.update.autoCheckEnabled"

    private var readyBundlePath: String?
    private var dailyTimer: Timer?
    private var countdownTimer: Timer?
    private var cancellables = Set<AnyCancellable>()

    private init() {}

    // MARK: eligibility

    /// Live only for a real release build running from a writable /Applications
    /// bundle. Dev builds (`-dev` sentinel / `.dev` bundle id) and non-/Applications
    /// copies stay dormant.
    var isEligible: Bool {
        guard !AppMode.isDev, !AppVersion.current.isPrerelease else { return false }
        let path = Bundle.main.bundlePath
        return path.hasPrefix("/Applications/") && FileManager.default.isWritableFile(atPath: path)
    }

    var autoCheckEnabled: Bool {
        get { (UserDefaults.standard.object(forKey: autoKey) as? Bool) ?? true }
        set {
            UserDefaults.standard.set(newValue, forKey: autoKey)
            objectWillChange.send()
            if newValue { startDailyTimerIfNeeded(); Task { await maybeAutoCheck() } }
            else { dailyTimer?.invalidate(); dailyTimer = nil; if isAutomaticPhase { phase = .idle } }
        }
    }

    private var isAutomaticPhase: Bool {
        switch phase { case .available, .downloading, .readyToRestart: return true; default: return false }
    }

    /// Whether the sidebar-footer pill should be shown for the current phase
    /// (checking / up-to-date are Settings-only, transient states).
    var hasSidebarPill: Bool {
        switch phase {
        case .available, .downloading, .readyToRestart, .restarting: return true
        default: return false
        }
    }

    private var skippedVersion: Version? {
        (UserDefaults.standard.string(forKey: skippedKey)).flatMap(Version.init)
    }

    // MARK: launch

    func startIfEligible() {
        guard isEligible else { return }
        observeActivity()
        startDailyTimerIfNeeded()
        Task { await maybeAutoCheck() }
    }

    private func startDailyTimerIfNeeded() {
        guard isEligible, autoCheckEnabled, dailyTimer == nil else { return }
        dailyTimer = Timer.scheduledTimer(withTimeInterval: 6 * 3600, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.maybeAutoCheck() }
        }
    }

    private func maybeAutoCheck() async {
        guard isEligible, autoCheckEnabled else { return }
        let last = UserDefaults.standard.double(forKey: lastCheckKey)
        let elapsed = Date().timeIntervalSince1970 - last
        guard last == 0 || elapsed > 24 * 3600 else { return }
        await check(manual: false)
    }

    // MARK: checking

    func checkNow() async { await check(manual: true) }

    private func check(manual: Bool) async {
        guard isEligible else { return }
        if !manual && !autoCheckEnabled { return }
        phase = .checking
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: lastCheckKey)
        guard let update = await UpdateService.checkForUpdate(current: AppVersion.current) else {
            phase = manual ? .upToDate : .idle
            return
        }
        if !manual && !shouldSurface(available: update.version, skipped: skippedVersion) {
            phase = .idle
            return
        }
        phase = .available(update)
    }

    // MARK: download

    func beginDownload() {
        guard case .available(let update) = phase else { return }
        phase = .downloading(0)
        Task {
            do {
                let path = try await UpdateService.download(update) { [weak self] p in
                    Task { @MainActor in self?.updateProgress(p) }
                }
                self.readyBundlePath = path
                self.phase = .readyToRestart(update)
            } catch {
                self.phase = .error("Download failed")
                // fall back so the user can retry from the pill/panel
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 2_500_000_000)
                    if case .error = self.phase { self.phase = .available(update) }
                }
            }
        }
    }

    private func updateProgress(_ p: Double) {
        if case .downloading = phase { phase = .downloading(p) }
    }

    // MARK: skip / dismiss

    func skipCurrent() {
        if case .available(let u) = phase { UserDefaults.standard.set(u.version.description, forKey: skippedKey) }
        if case .readyToRestart(let u) = phase { UserDefaults.standard.set(u.version.description, forKey: skippedKey) }
        cancelRestart()
        phase = .idle
    }

    func dismissTransient() { if phase == .upToDate { phase = .idle } }

    // MARK: restart

    func restartNow() { beginCountdown() }

    func armRestartWhenIdle() {
        restartWhenIdle = true
        if AgentStore.shared.allPanesIdle() { beginCountdown() }
    }

    private func observeActivity() {
        AgentStore.shared.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                DispatchQueue.main.async { self?.onActivityChanged() }
            }
            .store(in: &cancellables)
    }

    private func onActivityChanged() {
        guard restartWhenIdle, countdown == nil,
              case .readyToRestart = phase,
              AgentStore.shared.allPanesIdle() else { return }
        beginCountdown()
    }

    private func beginCountdown() {
        guard case .readyToRestart = phase, countdown == nil else { return }
        countdown = 10
        countdownTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tickCountdown() }
        }
    }

    private func tickCountdown() {
        guard let c = countdown else { return }
        if c <= 1 { install() } else { countdown = c - 1 }
    }

    func cancelRestart() {
        countdownTimer?.invalidate(); countdownTimer = nil
        countdown = nil
        restartWhenIdle = false
    }

    private func install() {
        countdownTimer?.invalidate(); countdownTimer = nil
        countdown = nil
        guard case .readyToRestart = phase, let path = readyBundlePath else { return }
        phase = .restarting
        UpdateInstaller.install(newBundle: path, installedPath: Bundle.main.bundlePath)
        NSApp.terminate(nil)
    }
}
```

- [ ] **Step 2: Build the app target, confirm it compiles**

```sh
cd spike/seam1 && xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache build
```
Expected: BUILD SUCCEEDED.

- [ ] **Step 3: Commit**

```sh
cd /Users/eshaannileshshah/Home/dev/tools/shepherd
git add spike/seam1/Sources/UpdateController.swift spike/seam1/project.yml
git commit -m "$(cat <<'EOF'
feat(update): UpdateController state machine + cadence + skip/toggle

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Wire the controller into the app lifecycle

**Files:**
- Modify: `spike/seam1/Sources/ShepherdApp.swift`

**Interfaces:**
- Consumes: `UpdateController.shared` (Task 5).
- Produces: `UpdateController` in the SwiftUI environment for both `WindowGroup` and `Settings`; `startIfEligible()` fired once on launch.

- [ ] **Step 1: Inject + start the controller**

In `spike/seam1/Sources/ShepherdApp.swift`:

(a) After line 7 (`@StateObject private var sleep = SleepGuard.shared`), add — mirrors the proven `SleepGuard.shared` pattern:
```swift
    @StateObject private var updater = UpdateController.shared
```

(b) In `init()`, after line 14 (`_ = SleepGuard.shared …`), add:
```swift
        Task { @MainActor in UpdateController.shared.startIfEligible() }
```
(Start via `.shared`, not the `@StateObject` wrapper — the wrapper must not be read from `init()`.)

(c) In the `WindowGroup` content (lines 30–33), add `.environmentObject(updater)` on `ContentView()` right after the existing store injection:
```swift
            ContentView()
                .environmentObject(AgentStore.shared)
                .environmentObject(updater)
                .frame(minWidth: 900, minHeight: 560)
                .preferredColorScheme(.dark)
```

(d) In the `Settings` scene (lines 91–93), add `.environmentObject(updater)` after the existing store injection:
```swift
            SettingsView()
                .environmentObject(AgentStore.shared)
                .environmentObject(updater)
                .preferredColorScheme(Theme.mode == .dark ? .dark : .light)
```

- [ ] **Step 2: Build, confirm it compiles**

```sh
cd spike/seam1 && xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache build
```
Expected: BUILD SUCCEEDED.

- [ ] **Step 3: Commit**

```sh
cd /Users/eshaannileshshah/Home/dev/tools/shepherd
git add spike/seam1/Sources/ShepherdApp.swift
git commit -m "$(cat <<'EOF'
feat(update): start UpdateController on launch + inject into environment

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Sidebar update pill + popover

**Files:**
- Create: `spike/seam1/Sources/UpdatePillView.swift`
- Modify: `spike/seam1/Sources/SidebarView.swift`

**Interfaces:**
- Consumes: `UpdateController` (env object), `UpdatePhase`, `Theme`, `.font(.ui(...))`.

- [ ] **Step 1: Write the pill view**

Create `spike/seam1/Sources/UpdatePillView.swift`:
```swift
import SwiftUI

/// The quiet "update available" pill pinned at the bottom of the sidebar, plus
/// its popover (release notes + Download & Install, then Restart choices). Close
/// (×) = skip this version. Hidden when the controller is idle/checking/up-to-date.
struct UpdatePillView: View {
    @EnvironmentObject var updater: UpdateController
    @State private var showPopover = false

    var body: some View {
        if let label = pillLabel {
            HStack(spacing: 8) {
                Image(systemName: pillIcon)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.needsCheck)
                Text(label)
                    .font(.ui(11, .medium))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                Spacer(minLength: 4)
                if canSkip {
                    Button(action: { updater.skipCurrent() }) {
                        Image(systemName: "xmark")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(Theme.textDim)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .focusable(false)
                    .help("Skip this version")
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(Theme.surface2)
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.hairline, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
            .onTapGesture { showPopover = true }
            .popover(isPresented: $showPopover, arrowEdge: .top) { UpdatePopover().environmentObject(updater) }
            .focusable(false)
        }
    }

    private var pillLabel: String? {
        switch updater.phase {
        case .available(let u): return "Update available (\(u.tag))"
        case .downloading(let p): return "Updating… \(Int(p * 100))%"
        case .readyToRestart: return updater.restartWhenIdle ? "Will restart when idle" : "Update ready"
        case .restarting: return "Restarting…"
        default: return nil
        }
    }
    private var pillIcon: String {
        if case .downloading = updater.phase { return "arrow.down.circle" }
        return "arrow.up.circle"
    }
    private var canSkip: Bool {
        if case .available = updater.phase { return true }
        if case .readyToRestart = updater.phase { return true }
        return false
    }
}

/// The pill's popover: notes + primary action for the current phase.
struct UpdatePopover: View {
    @EnvironmentObject var updater: UpdateController

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            switch updater.phase {
            case .available(let u):
                header("Shepherd \(u.tag)")
                notes(u.notes)
                Button("Download & Install") { updater.beginDownload() }
            case .downloading(let p):
                header("Downloading…")
                ProgressView(value: p).frame(width: 240)
            case .readyToRestart(let u):
                header("Shepherd \(u.tag) is ready")
                if let c = updater.countdown {
                    Text("Restarting in \(c)s…").font(.ui(12)).foregroundStyle(Theme.textSecondary)
                    Button("Cancel") { updater.cancelRestart() }
                } else {
                    HStack(spacing: 8) {
                        Button("Restart now") { updater.restartNow() }
                        Button("Restart when idle") { updater.armRestartWhenIdle() }
                    }
                }
            default:
                EmptyView()
            }
        }
        .padding(16)
        .frame(maxWidth: 300, alignment: .leading)
        .background(Theme.raised)
    }

    private func header(_ t: String) -> some View {
        Text(t).font(.ui(13, .semibold)).foregroundStyle(Theme.textPrimary)
    }
    private func notes(_ body: String) -> some View {
        ScrollView {
            Text(body.isEmpty ? "No release notes." : body)
                .font(.ui(11)).foregroundStyle(Theme.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }.frame(maxHeight: 160)
    }
}
```

- [ ] **Step 2: Mount the pill in the sidebar**

In `spike/seam1/Sources/SidebarView.swift`, add the `updater` env object to `SidebarView` near the existing `@EnvironmentObject var store: AgentStore` (line 5):
```swift
    @EnvironmentObject var updater: UpdateController
```
In `var body` (lines 21–49), insert the pill just before the archived-footer block so it always shows when there's an update. Replace:
```swift
            if !store.archivedWorktrees.isEmpty {
                Divider().overlay(Theme.hairline)
                footer
            }
```
with:
```swift
            if updater.hasSidebarPill {
                Divider().overlay(Theme.hairline)
                UpdatePillView()
            }
            if !store.archivedWorktrees.isEmpty {
                Divider().overlay(Theme.hairline)
                footer
            }
```

- [ ] **Step 3: Build, confirm it compiles**

```sh
cd spike/seam1 && xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache build
```
Expected: BUILD SUCCEEDED. (`updater` resolves because Task 6 injects it into the window's environment.)

- [ ] **Step 4: Commit**

```sh
cd /Users/eshaannileshshah/Home/dev/tools/shepherd
git add spike/seam1/Sources/UpdatePillView.swift spike/seam1/Sources/SidebarView.swift
git commit -m "$(cat <<'EOF'
feat(update): sidebar-footer update pill + popover (skip / restart choices)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Settings "Software Update" section

**Files:**
- Modify: `spike/seam1/Sources/SettingsView.swift`

**Interfaces:**
- Consumes: `UpdateController` (env object), `AppVersion.current`, `SettingsField`, `SettingsButton`, `SettingsToggle`.

- [ ] **Step 1: Add the section to GeneralSettings**

In `spike/seam1/Sources/SettingsView.swift`, add an env object to `GeneralSettings` (near its `@ObservedObject private var sleep = SleepGuard.shared`, line 492):
```swift
    @EnvironmentObject private var updater: UpdateController
```

In `GeneralSettings.body`, add a new `SettingsField` as the **first** child of the outer `VStack` (before the "Stay awake" field, line 502):
```swift
            SettingsField(label: "Software update",
                          footnote: "Shepherd \(AppVersion.current.description) · checks GitHub for new releases.") {
                HStack(spacing: 10) {
                    SettingsButton(title: checkTitle, systemImage: "arrow.triangle.2.circlepath") {
                        Task { await updater.checkNow() }
                    }
                    if case .upToDate = updater.phase {
                        Text("You're up to date").font(.ui(12)).foregroundStyle(Theme.textSecondary)
                    }
                }
                SettingsToggle(label: "Automatically check for updates",
                               isOn: Binding(get: { updater.autoCheckEnabled },
                                             set: { updater.autoCheckEnabled = $0 }))
                updateFoundPanel
            }
```

Add these computed helpers inside `GeneralSettings` (near the bottom, alongside `commitBase()`):
```swift
    private var checkTitle: String {
        if case .checking = updater.phase { return "Checking…" }
        return "Check for Updates"
    }

    @ViewBuilder private var updateFoundPanel: some View {
        switch updater.phase {
        case .available(let u), .readyToRestart(let u):
            VStack(alignment: .leading, spacing: 8) {
                Text("Shepherd \(u.tag) is available")
                    .font(.ui(13, .semibold)).foregroundStyle(Theme.textPrimary)
                ScrollView {
                    Text(u.notes.isEmpty ? "No release notes." : u.notes)
                        .font(.ui(11)).foregroundStyle(Theme.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }.frame(maxHeight: 140)
                if case .readyToRestart = updater.phase {
                    if let c = updater.countdown {
                        HStack(spacing: 8) {
                            Text("Restarting in \(c)s…").font(.ui(12)).foregroundStyle(Theme.textSecondary)
                            SettingsButton(title: "Cancel") { updater.cancelRestart() }
                        }
                    } else {
                        HStack(spacing: 8) {
                            SettingsButton(title: "Restart now", prominent: true) { updater.restartNow() }
                            SettingsButton(title: "Restart when idle") { updater.armRestartWhenIdle() }
                        }
                    }
                } else {
                    SettingsButton(title: "Update", systemImage: "arrow.down.circle", prominent: true) {
                        updater.beginDownload()
                    }
                }
            }
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.surface2))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.hairline, lineWidth: 1))
        case .downloading(let p):
            ProgressView(value: p).frame(maxWidth: 260)
        default:
            EmptyView()
        }
    }
```

- [ ] **Step 2: Build, confirm it compiles**

```sh
cd spike/seam1 && xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache build
```
Expected: BUILD SUCCEEDED. (Settings receives `updater` via Task 6's `Settings { … .environmentObject(updater) }`.)

- [ ] **Step 3: Commit**

```sh
cd /Users/eshaannileshshah/Home/dev/tools/shepherd
git add spike/seam1/Sources/SettingsView.swift
git commit -m "$(cat <<'EOF'
feat(update): Settings "Software update" section (check / notes / toggle)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Correct version number (local sentinel + CI stamp)

**Files:**
- Modify: `spike/seam1/project.yml` (both targets' `CFBundleShortVersionString`)
- Modify: `.github/workflows/release.yml` (stamp the real version before signing)

**Interfaces:** none (build config). Verification is by inspection + the app-target build.

- [ ] **Step 1: Set the local dev sentinel**

In `spike/seam1/project.yml`, change **both** occurrences of:
```yaml
        CFBundleShortVersionString: "0.0.1"
```
to:
```yaml
        CFBundleShortVersionString: "0.0.0-dev"
```
(one under `Shepherd.info.properties`, one under `ShepherdDev.info.properties`). This makes every local/dev build report a prerelease so `UpdateController.isEligible` is false locally (belt-and-suspenders with the `.dev` bundle-id and non-/Applications checks).

- [ ] **Step 2: Stamp the real version in CI**

In `.github/workflows/release.yml`, in the **"Ad-hoc sign & package"** step, insert the version stamp **before** the `codesign` line (signing must happen after the plist edit). Change:
```bash
          APP="./build/Build/Products/$CONFIGURATION/Shepherd.app"
          codesign --force --deep --sign - "$APP"
```
to:
```bash
          APP="./build/Build/Products/$CONFIGURATION/Shepherd.app"
          SHORT="${VERSION#v}"
          /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $SHORT" "$APP/Contents/Info.plist"
          /usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${GITHUB_RUN_NUMBER:-1}" "$APP/Contents/Info.plist"
          codesign --force --deep --sign - "$APP"
```
(`VERSION` is already exported in that step's `env:`. `${VERSION#v}` strips a leading `v` so the bundle carries a clean semver like `0.4.0`.)

- [ ] **Step 3: Verify locally (build reports the sentinel)**

```sh
cd spike/seam1 && xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache build
/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" \
  ./build/Build/Products/Debug/Shepherd.app/Contents/Info.plist
```
Expected: BUILD SUCCEEDED and the print shows `0.0.0-dev` (a local build is correctly non-updatable; CI overwrites this with the tag).

- [ ] **Step 4: Commit**

```sh
cd /Users/eshaannileshshah/Home/dev/tools/shepherd
git add spike/seam1/project.yml .github/workflows/release.yml
git commit -m "$(cat <<'EOF'
fix(release): stamp real version into the build; local dev sentinel

The built app reported a hardcoded 0.0.1; the release now stamps the tag
into CFBundleShortVersionString so the updater can compare versions.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

- [ ] **Full unit-test run:**
  ```sh
  cd spike/seam1 && xcodegen generate
  xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -derivedDataPath ./build \
    CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
    -only-testing:ShepherdModelTests test
  ```
  Expected: PASS — `VersionTests`, `IdlePolicyTests`, `UpdateServiceTests`, `UpdateInstallerTests` all green.
- [ ] **Full app build:** the Debug build command → BUILD SUCCEEDED.
- [ ] **Runtime (deferred to the user):** on a real release build installed in `/Applications`, confirm the pill appears when a newer release exists, download+swap+relaunch works, restart-when-idle waits for a busy pane, skip suppresses the same version, and the Settings toggle/button behave. Per the don't-kill-while-live rule, do NOT killall/relaunch the daily app to test this.

## Docs to update on completion (not a code task)

- `CLAUDE.md` — add the auto-update feature under "Done": new files (`Version`/`IdlePolicy`/`UpdateService`/`UpdateInstaller`/`UpdateController`/`UpdatePillView`), the `shepherd.update.*` UserDefaults keys, the version-stamping change, and the `/tmp/shepherd-update.log` gotcha. (Consider a short ADR for the hand-rolled-vs-Sparkle decision.)
