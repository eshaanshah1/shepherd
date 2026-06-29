# Remote Control M0 — PTY Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `shepherdd pty`, a bundled helper that transparently wraps a pane's program in its own PTY, and route panes through it behind a machine-level serve toggle — proving local panes stay byte-identical (and Claude hooks still fire) through our inserted PTY layer, with **no networking yet**.

**Architecture:** libghostty's public API exposes no live PTY tap, so to ever stream a pane we must own its PTY ourselves. We do that via the surface-config `command` field (`ghostty.h:447`): when serving, a pane's program becomes `shepherdd pty`, a `forkpty`-based wrapper that runs the user's login shell on an inner PTY and copies bytes between that inner PTY and the outer PTY libghostty handed it. The output copy passes through a `Tee` seam that is a **no-op in M0** (M2 plugs the replay ring-buffer + network in there). This milestone is the riskiest *local-behavior* change in the whole remote feature; it is validated in isolation before any remote code exists.

**Tech Stack:** Swift 5 + `import Darwin` + a tiny C bridging header (`forkpty` / `ioctl` winsize shims, since Swift can't call variadic `ioctl`); xcodegen targets; XCTest driving the built helper through a test-owned PTY.

## Global Constraints

- Deployment target **macOS 13.0**; `SWIFT_VERSION` **5.0** (copied from `project.yml`).
- **Run `xcodegen generate` after any file add/remove or `project.yml` change** — otherwise new files/targets are not compiled (CLAUDE.md gotcha).
- Build (Debug, no signing) from `spike/seam1`:
  `xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build`
- Products land in `spike/seam1/build/Build/Products/Debug/`.
- Ad-hoc sign before running the app: `codesign --force --deep --sign - <Shepherd.app>`.
- **`SourceKit lies in this repo`** — trust `xcodebuild`, ignore editor "cannot find type" noise (CLAUDE.md).
- Pure-model code lives in `Sources/` and is added to a test target's explicit `sources:` list; `ShepherdModelTests` stays pure (no Process/PTY) — helper integration tests go in a **separate** target.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Work on branch `remote-control-design-spec` (already checked out) or a fresh branch off it; never commit straight to `master`.

---

## File Structure

- **Create `spike/seam1/Helper/main.swift`** — the entire `shepherdd` CLI (arg parse + `pty` subcommand: `forkpty`, pump loop, winsize, exit-status, the `Tee` no-op seam). One file, one responsibility: be a transparent PTY wrapper. Sibling of `Sources/` so the app target's `- path: Sources` glob does NOT compile it.
- **Create `spike/seam1/Helper/shepherdd-Bridging.h`** — C shims the helper's Swift needs: `forkpty` (via `<util.h>`) and `sh_get_winsize` / `sh_set_winsize` static-inline wrappers around variadic `ioctl`.
- **Create `spike/seam1/HelperTests/ShepherddPtyTests.swift`** — XCTest that builds-then-spawns the helper through a test-owned PTY and asserts byte fidelity, isatty, winsize, exit status, input. Lives OUTSIDE `Tests/` so `ShepherdModelTests`' `- path: Tests` glob ignores it.
- **Create `spike/seam1/HelperTests/PtyShim.h`** — bridging header for the test target: `openpty` + `pty_set_winsize` shim.
- **Create `spike/seam1/Sources/RemoteWiring.swift`** — pure function `remoteSurfaceCommand(serving:helperPath:) -> String?`. Auto-included in the app via the Sources glob; added to `ShepherdModelTests` for a unit test.
- **Create `spike/seam1/Tests/RemoteWiringTests.swift`** — pure unit test for the wiring decision (globbed by `ShepherdModelTests`).
- **Modify `spike/seam1/project.yml`** — add the `shepherdd` tool target and the `ShepherdHelperTests` test target (Task 1); add the app's `copy: executables` dependency on `shepherdd` and `RemoteWiring.swift` to `ShepherdModelTests` sources (Task 3).
- **Modify `spike/seam1/Sources/AgentStore.swift`** — add `isServing` (UserDefaults-backed) and `helperPath` (Task 3).
- **Modify `spike/seam1/Sources/GhosttyTerminal.swift:108-112`** — set `cfg.command` to the helper when serving (Task 3).

---

### Task 1: `shepherdd pty` PTY-wrapping core + integration tests

**Files:**
- Create: `spike/seam1/Helper/main.swift`
- Create: `spike/seam1/Helper/shepherdd-Bridging.h`
- Create: `spike/seam1/HelperTests/ShepherddPtyTests.swift`
- Create: `spike/seam1/HelperTests/PtyShim.h`
- Modify: `spike/seam1/project.yml` (add `shepherdd` + `ShepherdHelperTests` targets)

**Interfaces:**
- Produces: a built executable `shepherdd` (in the Debug Products dir). CLI:
  `shepherdd pty [-- <program> [args…]]` — runs `<program>` (default: `$SHELL` as a login shell) on a fresh PTY; copies stdin→inner and inner→stdout; exits with the child's status. Output passes through `Tee.shared.output(_:count:)` (no-op in M0).

- [ ] **Step 1: Write the bridging header**

Create `spike/seam1/Helper/shepherdd-Bridging.h`:

```c
#ifndef SHEPHERDD_BRIDGING_H
#define SHEPHERDD_BRIDGING_H

#include <util.h>        // forkpty
#include <sys/ioctl.h>
#include <termios.h>     // struct winsize

// Swift cannot call the variadic ioctl(2); expose the two calls we need.
static inline int sh_get_winsize(int fd, struct winsize *ws) { return ioctl(fd, TIOCGWINSZ, ws); }
static inline int sh_set_winsize(int fd, const struct winsize *ws) { return ioctl(fd, TIOCSWINSZ, ws); }

#endif
```

- [ ] **Step 2: Write the helper**

Create `spike/seam1/Helper/main.swift`:

```swift
import Darwin
import Foundation

// shepherdd — Shepherd's PTY helper.
//
// `pty [-- <program> [args…]]`: run <program> (default: the login shell) on a
// fresh inner PTY and copy bytes between that PTY and our own stdio (the outer
// PTY libghostty handed us). Transparent: input in, output out, exit status and
// window size preserved. Output flows through Tee so a later milestone can fan
// it out to a replay buffer + the network without restructuring this loop.

// MARK: - Output tap (no-op until M2)

final class Tee {
    static let shared = Tee()
    func output(_ buf: UnsafePointer<UInt8>, count: Int) { /* M2: ring buffer + network */ }
}

// MARK: - winsize handling

var gMaster: Int32 = -1
func installWinchForwarder() {
    signal(SIGWINCH) { _ in
        var ws = winsize()
        if sh_get_winsize(STDIN_FILENO, &ws) == 0 { _ = sh_set_winsize(gMaster, &ws) }
    }
}

// MARK: - child

func execProgram(_ program: [String]) {
    // forkpty already wired the child's stdio to the new PTY and made it the
    // session leader; we only exec.
    var argv0 = program[0]
    if program.count == 1 {
        // Default shell launches as a login shell (leading '-'), like a normal
        // terminal's first pane.
        argv0 = "-" + (program[0] as NSString).lastPathComponent
    }
    let parts = [argv0] + program.dropFirst()
    var c: [UnsafeMutablePointer<CChar>?] = parts.map { strdup($0) }
    c.append(nil)
    c.withUnsafeMutableBufferPointer { buf in _ = execv(program[0], buf.baseAddress) }
}

// MARK: - parent pump

func pump(master: Int32) {
    let cap = 65536
    let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: cap)
    defer { buf.deallocate() }

    func writeAll(_ fd: Int32, _ n: Int) {
        var off = 0
        while off < n {
            let w = write(fd, buf + off, n - off)
            if w < 0 { if errno == EINTR || errno == EAGAIN { continue }; return }
            off += w
        }
    }

    var pfds = [pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0),
                pollfd(fd: master,       events: Int16(POLLIN), revents: 0)]
    while true {
        if poll(&pfds, nfds_t(pfds.count), -1) < 0 { if errno == EINTR { continue }; break }

        if pfds[0].revents & Int16(POLLIN) != 0 {
            let n = read(STDIN_FILENO, buf, cap)
            if n > 0 { writeAll(master, n) } else if n == 0 { break }
        }
        if pfds[1].revents & Int16(POLLIN) != 0 {
            let n = read(master, buf, cap)
            if n > 0 { writeAll(STDOUT_FILENO, n); Tee.shared.output(buf, count: n) }
            else if n == 0 { break }
        }
        if pfds[1].revents & Int16(POLLHUP | POLLERR) != 0 {
            let n = read(master, buf, cap)            // drain the last output the child wrote
            if n > 0 { writeAll(STDOUT_FILENO, n); Tee.shared.output(buf, count: n) } else { break }
        }
        pfds[0].revents = 0; pfds[1].revents = 0
    }
}

func exitCode(from status: Int32) -> Int32 {
    if (status & 0x7f) == 0 { return (status >> 8) & 0xff }   // WIFEXITED → WEXITSTATUS
    return 128 + (status & 0x7f)                              // killed by signal
}

// MARK: - pty subcommand

func runPty(_ program: [String]) -> Int32 {
    var ws = winsize()
    _ = sh_get_winsize(STDIN_FILENO, &ws)                     // mirror the outer size (zeroed if not a tty)
    var master: Int32 = 0
    let pid = forkpty(&master, nil, nil, &ws)
    if pid < 0 { perror("shepherdd: forkpty"); return 71 }
    if pid == 0 { execProgram(program); perror("shepherdd: exec"); _exit(127) }

    gMaster = master
    installWinchForwarder()
    pump(master: master)

    var status: Int32 = 0
    while waitpid(pid, &status, 0) < 0 && errno == EINTR {}
    return exitCode(from: status)
}

func loginShell() -> String {
    if let s = ProcessInfo.processInfo.environment["SHELL"], !s.isEmpty { return s }
    if let pw = getpwuid(getuid()), let sh = pw.pointee.pw_shell { return String(cString: sh) }
    return "/bin/zsh"
}

// MARK: - entry

let argv = Array(CommandLine.arguments.dropFirst())
guard argv.first == "pty" else {
    FileHandle.standardError.write(Data("usage: shepherdd pty [-- <program> [args…]]\n".utf8))
    exit(64)
}
let program: [String]
if let dash = argv.firstIndex(of: "--"), dash + 1 < argv.count {
    program = Array(argv[(dash + 1)...])
} else {
    program = [loginShell()]
}
exit(runPty(program))
```

- [ ] **Step 3: Write the test bridging header**

Create `spike/seam1/HelperTests/PtyShim.h`:

```c
#ifndef PTY_SHIM_H
#define PTY_SHIM_H

#include <util.h>        // openpty
#include <sys/ioctl.h>
#include <termios.h>

static inline int pty_set_winsize(int fd, const struct winsize *ws) { return ioctl(fd, TIOCSWINSZ, ws); }

#endif
```

- [ ] **Step 4: Write the failing integration test**

Create `spike/seam1/HelperTests/ShepherddPtyTests.swift`:

```swift
import XCTest
import Darwin

/// Drives the built `shepherdd` binary through a PTY this test owns, asserting
/// the wrapper is byte-transparent and tty-faithful.
final class ShepherddPtyTests: XCTestCase {

    private func helperURL() -> URL {
        // The tool product lands beside this test bundle in the Products dir.
        Bundle(for: type(of: self)).bundleURL
            .deletingLastPathComponent()
            .appendingPathComponent("shepherdd")
    }

    /// Runs `shepherdd <args>`, optionally feeding `input`, with the given pane
    /// size. Returns (stdout-as-string, exit-code).
    private func run(_ args: [String], input: String = "",
                     cols: UInt16 = 80, rows: UInt16 = 24,
                     timeout: TimeInterval = 8) -> (String, Int32) {
        var master: Int32 = 0, slave: Int32 = 0
        var ws = winsize(ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0)
        XCTAssertEqual(openpty(&master, &slave, nil, nil, &ws), 0, "openpty")

        let proc = Process()
        proc.executableURL = helperURL()
        proc.arguments = args
        let slaveHandle = FileHandle(fileDescriptor: slave, closeOnDealloc: false)
        proc.standardInput = slaveHandle
        proc.standardOutput = slaveHandle
        proc.standardError = slaveHandle
        do { try proc.run() } catch { XCTFail("launch \(helperURL().path): \(error)"); return ("", -1) }
        close(slave)                                  // the helper owns the slave now

        if !input.isEmpty { _ = input.withCString { write(master, $0, strlen($0)) } }

        // Read master until the helper exits and the pty drains (EIO == EOF here).
        var out = Data()
        let deadline = Date().addingTimeInterval(timeout)
        var buf = [UInt8](repeating: 0, count: 4096)
        while Date() < deadline {
            var pfd = pollfd(fd: master, events: Int16(POLLIN), revents: 0)
            let r = poll(&pfd, 1, 200)
            if r > 0 {
                let n = read(master, &buf, buf.count)
                if n > 0 { out.append(contentsOf: buf[0..<n]) } else { break }   // 0/-1 (EIO) → done
            } else if !proc.isRunning && r == 0 { break }
        }
        proc.waitUntilExit()
        close(master)
        return (String(decoding: out, as: UTF8.self), proc.terminationStatus)
    }

    func testPassesChildOutputThrough() {
        let (out, code) = run(["pty", "--", "/bin/echo", "shepherd-marker"])
        XCTAssertTrue(out.contains("shepherd-marker"), "got: \(out)")
        XCTAssertEqual(code, 0)
    }

    func testChildSeesARealTTY() {
        let (out, _) = run(["pty", "--", "/bin/sh", "-c", "test -t 0 && echo ISATTY"])
        XCTAssertTrue(out.contains("ISATTY"), "child stdin was not a tty; got: \(out)")
    }

    func testInitialWindowSizePropagates() {
        let (out, _) = run(["pty", "--", "/bin/sh", "-c", "stty size"], cols: 123, rows: 45)
        XCTAssertTrue(out.contains("45 123"), "stty size mismatch; got: \(out)")
    }

    func testExitStatusPropagates() {
        let (_, code) = run(["pty", "--", "/bin/sh", "-c", "exit 7"])
        XCTAssertEqual(code, 7)
    }

    func testInputReachesChild() {
        let (out, _) = run(["pty", "--", "/bin/sh", "-c", "read x; echo got:$x"], input: "hi\n")
        XCTAssertTrue(out.contains("got:hi"), "input not delivered; got: \(out)")
    }
}
```

- [ ] **Step 5: Add both targets to `project.yml`**

In `spike/seam1/project.yml`, under `targets:` add the helper tool and the helper-test bundle (leave `Shepherd` and `ShepherdModelTests` unchanged):

```yaml
  shepherdd:
    type: tool
    platform: macOS
    settings:
      base:
        PRODUCT_NAME: shepherdd
        SWIFT_OBJC_BRIDGING_HEADER: Helper/shepherdd-Bridging.h
    sources:
      - path: Helper
  ShepherdHelperTests:
    type: bundle.unit-test
    platform: macOS
    settings:
      base:
        SWIFT_OBJC_BRIDGING_HEADER: HelperTests/PtyShim.h
    sources:
      - path: HelperTests
    dependencies:
      - target: shepherdd
```

- [ ] **Step 6: Regenerate the project and run the test to verify it fails**

```bash
cd spike/seam1 && xcodegen generate
xcodebuild test -project Shepherd.xcodeproj -scheme ShepherdHelperTests \
  -destination 'platform=macOS' -derivedDataPath ./build \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache 2>&1 | tail -25
```
Expected: builds the `shepherdd` target and the test bundle, then tests **PASS**. (This step doubles as build verification of the helper; if the helper failed to compile the test scheme wouldn't build. To see a genuine red-first, you may temporarily stub `runPty` to `return 0` before Step 2 — optional.)

- [ ] **Step 7: Run the test to verify it passes**

Run the Step 6 command. Expected: `Test Suite 'ShepherddPtyTests' passed`, 5 tests, 0 failures.

- [ ] **Step 8: Commit**

```bash
git add spike/seam1/Helper spike/seam1/HelperTests spike/seam1/project.yml
git commit -m "feat(remote): shepherdd pty — transparent PTY-wrapping helper (M0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Dynamic window-resize propagation

**Files:**
- Modify: `spike/seam1/Helper/main.swift` (already has `installWinchForwarder` from Task 1 — this task adds the test that proves it)
- Modify: `spike/seam1/HelperTests/ShepherddPtyTests.swift`

**Interfaces:**
- Consumes: the `shepherdd pty` CLI and the `installWinchForwarder()` SIGWINCH handler from Task 1.
- Produces: nothing new; verifies live resizes on the outer PTY reach the inner child.

- [ ] **Step 1: Write the failing test**

Append to `ShepherddPtyTests.swift`:

```swift
extension ShepherddPtyTests {
    func testLiveResizePropagatesToChild() {
        var master: Int32 = 0, slave: Int32 = 0
        var ws = winsize(ws_row: 24, ws_col: 80, ws_xpixel: 0, ws_ypixel: 0)
        XCTAssertEqual(openpty(&master, &slave, nil, nil, &ws), 0, "openpty")

        let proc = Process()
        proc.executableURL = helperURL()
        // Re-emit our size whenever the window changes, for ~3s.
        proc.arguments = ["pty", "--", "/bin/sh", "-c", "trap 'stty size' WINCH; sleep 3"]
        let h = FileHandle(fileDescriptor: slave, closeOnDealloc: false)
        proc.standardInput = h; proc.standardOutput = h; proc.standardError = h
        do { try proc.run() } catch { XCTFail("launch: \(error)"); return }
        close(slave)

        // Let the child install its trap, then resize the OUTER pty. The kernel
        // SIGWINCHes the helper (slave fg proc); the helper forwards to the inner
        // pty, which SIGWINCHes the child → its trap prints the new size.
        usleep(700_000)
        var bigger = winsize(ws_row: 45, ws_col: 123, ws_xpixel: 0, ws_ypixel: 0)
        XCTAssertEqual(pty_set_winsize(master, &bigger), 0, "resize")

        var out = Data(); var buf = [UInt8](repeating: 0, count: 4096)
        let deadline = Date().addingTimeInterval(4)
        while Date() < deadline {
            var pfd = pollfd(fd: master, events: Int16(POLLIN), revents: 0)
            if poll(&pfd, 1, 200) > 0 {
                let n = read(master, &buf, buf.count)
                if n > 0 { out.append(contentsOf: buf[0..<n]); if String(decoding: out, as: UTF8.self).contains("45 123") { break } }
                else { break }
            }
        }
        proc.terminate(); proc.waitUntilExit(); close(master)
        XCTAssertTrue(String(decoding: out, as: UTF8.self).contains("45 123"),
                      "resize did not reach child; got: \(String(decoding: out, as: UTF8.self))")
    }
}
```

- [ ] **Step 2: Run it to confirm it passes** (the handler already exists from Task 1)

```bash
cd spike/seam1
xcodebuild test -project Shepherd.xcodeproj -scheme ShepherdHelperTests \
  -destination 'platform=macOS' -derivedDataPath ./build \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  -only-testing:ShepherdHelperTests/ShepherddPtyTests/testLiveResizePropagatesToChild 2>&1 | tail -15
```
Expected: PASS. If it fails, the SIGWINCH handler in `main.swift` is wrong — fix `installWinchForwarder` (it must `sh_get_winsize(STDIN_FILENO)` then `sh_set_winsize(gMaster)`), not the test.

- [ ] **Step 3: Commit**

```bash
git add spike/seam1/HelperTests/ShepherddPtyTests.swift
git commit -m "test(remote): verify live window-resize reaches the wrapped child (M0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Serve toggle + route panes through the helper

**Files:**
- Create: `spike/seam1/Sources/RemoteWiring.swift`
- Create: `spike/seam1/Tests/RemoteWiringTests.swift`
- Modify: `spike/seam1/Sources/AgentStore.swift` (add `isServing` + `helperPath`)
- Modify: `spike/seam1/Sources/GhosttyTerminal.swift:108-112` (set `cfg.command` when serving)
- Modify: `spike/seam1/project.yml` (app `copy: executables` dep on `shepherdd`; add `RemoteWiring.swift` to `ShepherdModelTests`)

**Interfaces:**
- Consumes: the built+embedded `shepherdd` binary; the existing `dup(_:)` allocator and `cfg` in `GhosttyTerminal.makeSurface` (`GhosttyTerminal.swift:108`).
- Produces:
  - `func remoteSurfaceCommand(serving: Bool, helperPath: String) -> String?` — returns `"<helperPath> pty"` when serving, else `nil`.
  - `AgentStore.shared.isServing: Bool` (UserDefaults key `shepherd.remote.serving`) and `AgentStore.shared.helperPath: String` (the bundled `shepherdd`).

- [ ] **Step 1: Write the failing unit test for the wiring decision**

Create `spike/seam1/Tests/RemoteWiringTests.swift`:

```swift
import XCTest

final class RemoteWiringTests: XCTestCase {
    func testNotServingMeansNoCommandOverride() {
        XCTAssertNil(remoteSurfaceCommand(serving: false, helperPath: "/x/shepherdd"))
    }

    func testServingRoutesThroughHelperPtySubcommand() {
        let cmd = remoteSurfaceCommand(serving: true, helperPath: "/x/Contents/MacOS/shepherdd")
        XCTAssertEqual(cmd, "/x/Contents/MacOS/shepherdd pty")
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd spike/seam1 && xcodegen generate
xcodebuild test -project Shepherd.xcodeproj -scheme ShepherdModelTests \
  -destination 'platform=macOS' -derivedDataPath ./build \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  -only-testing:ShepherdModelTests/RemoteWiringTests 2>&1 | tail -15
```
Expected: FAIL — `cannot find 'remoteSurfaceCommand' in scope` (after we add the file to the test target in Step 4 it will compile and fail on assertion until Step 3's file exists; if it fails to even build the scheme because the file isn't in the target yet, do Step 3 and Step 4 together then re-run).

- [ ] **Step 3: Write the pure wiring function**

Create `spike/seam1/Sources/RemoteWiring.swift`:

```swift
import Foundation

/// The libghostty surface `command` for a pane, given whether this machine is
/// serving. When serving, panes run through the bundled `shepherdd pty` wrapper
/// (so their PTY is ours to stream later); otherwise libghostty forks the shell
/// itself and we return nil (no override).
///
/// `helperPath` is assumed free of spaces (it lives in the app bundle). If that
/// ever changes, switch the wiring to libghostty's `initial_input` handshake.
func remoteSurfaceCommand(serving: Bool, helperPath: String) -> String? {
    serving ? "\(helperPath) pty" : nil
}
```

- [ ] **Step 4: Add `RemoteWiring.swift` to the test target and re-run**

In `project.yml`, append to `ShepherdModelTests.sources`:

```yaml
      - path: Sources/RemoteWiring.swift
```

Then:

```bash
cd spike/seam1 && xcodegen generate
xcodebuild test -project Shepherd.xcodeproj -scheme ShepherdModelTests \
  -destination 'platform=macOS' -derivedDataPath ./build \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  -only-testing:ShepherdModelTests/RemoteWiringTests 2>&1 | tail -15
```
Expected: PASS (2 tests).

- [ ] **Step 5: Add `isServing` + `helperPath` to `AgentStore`**

In `spike/seam1/Sources/AgentStore.swift`, near the other stored/computed properties (e.g. just after `let socketPath: String` at line 29), add:

```swift
    /// Machine-level "serve panes through the helper" switch. Off by default;
    /// flip with `defaults write com.shepherd.Shepherd shepherd.remote.serving -bool YES`
    /// (a real Settings toggle lands in M4). Read at pane-creation time, so it
    /// affects panes opened after it changes.
    var isServing: Bool { UserDefaults.standard.bool(forKey: "shepherd.remote.serving") }

    /// The bundled `shepherdd` helper, beside the app executable in Contents/MacOS.
    let helperPath: String = Bundle.main.executableURL?
        .deletingLastPathComponent()
        .appendingPathComponent("shepherdd").path ?? "shepherdd"
```

- [ ] **Step 6: Route the surface through the helper when serving**

In `spike/seam1/Sources/GhosttyTerminal.swift`, inside `makeSurface`, immediately before the `return envVars.withUnsafeMutableBufferPointer { … }` block (currently line 108), add:

```swift
        if let cmd = remoteSurfaceCommand(serving: AgentStore.shared.isServing,
                                          helperPath: AgentStore.shared.helperPath) {
            cfg.command = dup(cmd)
        }
```

- [ ] **Step 7: Embed `shepherdd` into the app bundle**

In `project.yml`, in the `Shepherd` target's `dependencies:`, add (right after the `GhosttyKit.xcframework` entry):

```yaml
      - target: shepherdd
        copy:
          destination: executables
```

- [ ] **Step 8: Regenerate, build the app, verify it compiles and bundles the helper**

```bash
cd spike/seam1 && xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -15
ls -l build/Build/Products/Debug/Shepherd.app/Contents/MacOS/shepherdd
```
Expected: build succeeds; `shepherdd` is listed inside `Contents/MacOS/`.

- [ ] **Step 9: Commit**

```bash
git add spike/seam1/Sources/RemoteWiring.swift spike/seam1/Tests/RemoteWiringTests.swift \
        spike/seam1/Sources/AgentStore.swift spike/seam1/Sources/GhosttyTerminal.swift \
        spike/seam1/project.yml
git commit -m "feat(remote): serve toggle routes panes through shepherdd pty (M0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: End-to-end verification — byte-identical panes + live hooks through the helper

This task has no new code; it proves M0's core claim in the real app. (libghostty's `command`-string parsing is undocumented in the vendored header — Step 2 is also where we confirm it splits `"<path> pty"` into argv rather than mis-running it.)

**Files:** none (verification + notes only).

- [ ] **Step 1: Build, sign, and launch with serving OFF (baseline)**

```bash
cd spike/seam1
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build >/dev/null
APP=build/Build/Products/Debug/Shepherd.app
codesign --force --deep --sign - "$APP"
defaults write com.shepherd.Shepherd shepherd.remote.serving -bool NO
killall Shepherd 2>/dev/null; until ! pgrep -x Shepherd >/dev/null; do sleep 0.2; done
open "$APP"
```
In a pane run `ps -o command -p $$` — expect your normal shell (no `shepherdd`). Confirm normal typing/scrolling.

- [ ] **Step 2: Flip serving ON, relaunch, confirm panes run through the helper**

```bash
defaults write com.shepherd.Shepherd shepherd.remote.serving -bool YES
killall Shepherd; until ! pgrep -x Shepherd >/dev/null; do sleep 0.2; done
open "$APP"
```
In a **new** pane:
- Run `tty` and `echo $SHELL; ps axo pid,ppid,command | grep -E "shepherdd|$$" | grep -v grep` → the shell's parent process is `shepherdd pty`.
- Confirm full fidelity: `vi` opens and redraws; arrow keys, `Ctrl-C`, resizing the window (drag) all behave exactly as with serving off; `stty size` matches the pane.
- Expected: byte-identical behavior; the only difference is the `shepherdd` parent in the process tree.

- [ ] **Step 3: Confirm Claude hooks still fire through the helper**

In a serving pane, `tail -f /tmp/shepherd-events.log` in one split and run `claude` in another; submit a prompt. Expected: the pane's sidebar dot transitions `idle → working → need-to-check`, and the log shows the transitions — proving `SHEPHERD_SOCK`/`SHEPHERD_TAB_ID` pass through `execv` to the agent and hooks reach the socket unchanged.

- [ ] **Step 4: Reset the toggle and record the result**

```bash
defaults write com.shepherd.Shepherd shepherd.remote.serving -bool NO
```
Append a one-line note to the plan or the M1 spec section confirming: panes are byte-identical and hooks fire through `shepherdd pty`; libghostty splits the `command` string into argv as assumed (or, if not, note the observed parsing so M1 can adjust the wiring). No commit needed unless notes were added to a tracked file — if so:

```bash
git commit -am "docs(remote): record M0 end-to-end verification result

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (M0 slice of `2026-06-29-remote-control-design.md` §11):**
- "`shepherdd pty` helper wired as the surface command behind the serve toggle" → Tasks 1 + 3. ✓
- "no network" → confirmed; `Tee` is an explicit no-op seam. ✓
- "prove local panes behave byte-identically through the inserted PTY layer" → Task 4 Steps 1–2. ✓
- Hooks still fire (env passes through) → Task 4 Step 3 (implied by §8 "the helper passes it through so hooks fire normally"). ✓
- Winsize fidelity (§7 resize) → Tasks 1 (initial) + 2 (dynamic). ✓
- `RemoteProtocol.swift` (framing/messages/pairing/ring-buffer) is intentionally **deferred** to M1/M2 where it is exercised — M0 keeps to the helper + wiring (YAGNI; noted in the plan intro and §12 alignment). No gap: those items are not in the M0 milestone line.

**Placeholder scan:** no TBD/TODO/"handle errors"/"similar to" — every code step is complete; the one `Tee` no-op is deliberate and documented as the M2 seam.

**Type consistency:** `remoteSurfaceCommand(serving:helperPath:)`, `AgentStore.isServing`, `AgentStore.helperPath`, `Tee.shared.output(_:count:)`, `installWinchForwarder()`, `runPty(_:)`, `gMaster`, `sh_get_winsize`/`sh_set_winsize`, `pty_set_winsize` — names are used identically across all tasks and the C shims match their Swift call sites.
