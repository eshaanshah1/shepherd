import Foundation
#if canImport(Darwin)
import Darwin
#endif

// Shepherd spike — socket-probe
//
// Proves seams 2 & 3 of the spike WITHOUT the GUI: it binds the unix socket that
// Shepherd will own, receives {"tab_id","event"} JSON from the Claude Code plugin
// (or from a manual test), maps each event to a Shepherd agent state, and prints a
// live board.
//
//   $ swift run socket-probe              # listens on $SHEPHERD_SOCK (default /tmp/shepherd.sock)
//
// NOTE: the focus → idle transition is the GUI's job (driven by which tab is
// focused), so it is not exercised here. This probe only shows the agent-driven
// half of the state machine.

setbuf(stdout, nil)   // unbuffered: events show immediately, even when piped

let sockPath = ProcessInfo.processInfo.environment["SHEPHERD_SOCK"] ?? "/tmp/shepherd.sock"

// Mirror of AgentState.from(event:) in SPEC §2. Returns nil for "no state change".
func state(for event: String) -> String? {
    switch event {
    case "SessionStart":                                  return "idle"
    case "UserPromptSubmit", "PreToolUse", "PostToolUse": return "working"
    case "Notification":                                  return "blocked"
    case "Stop":                                          return "need-to-check"
    default:                                              return nil   // SessionEnd => removal
    }
}

var board: [String: String] = [:]   // tab_id -> state

func printBoard() {
    print("── agents ───────────────────────────")
    if board.isEmpty {
        print("  (none)")
    } else {
        for tab in board.keys.sorted() {
            let label = tab.padding(toLength: 14, withPad: " ", startingAt: 0)
            print("  \(label)\(board[tab] ?? "?")")
        }
    }
    print("─────────────────────────────────────\n")
}

// Fresh socket file each run.
unlink(sockPath)

let fd = socket(AF_UNIX, SOCK_STREAM, 0)
guard fd >= 0 else { perror("socket"); exit(1) }

var addr = sockaddr_un()
addr.sun_family = sa_family_t(AF_UNIX)
sockPath.withCString { cstr in
    withUnsafeMutablePointer(to: &addr.sun_path.0) { dst in
        _ = strncpy(dst, cstr, MemoryLayout.size(ofValue: addr.sun_path) - 1)
    }
}

let size = socklen_t(MemoryLayout<sockaddr_un>.size)
let bound = withUnsafePointer(to: &addr) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, size) }
}
guard bound == 0 else { perror("bind"); exit(1) }
guard listen(fd, 16) == 0 else { perror("listen"); exit(1) }

print("shepherd socket-probe listening on \(sockPath)")
print("waiting for Claude hook events…  (Ctrl-C to stop)\n")
printBoard()

while true {
    let client = accept(fd, nil, nil)
    if client < 0 { continue }
    defer { close(client) }

    var buf = [UInt8](repeating: 0, count: 8192)
    let n = read(client, &buf, buf.count)
    guard n > 0 else { continue }

    let raw = String(decoding: buf[0..<n], as: UTF8.self)
        .trimmingCharacters(in: .whitespacesAndNewlines)

    guard
        let data = raw.data(using: .utf8),
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let tab = obj["tab_id"] as? String,
        let event = obj["event"] as? String
    else {
        print("  ?? unparsed: \(raw)")
        continue
    }

    if event == "SessionEnd" {
        board[tab] = nil
        print("  [\(tab)] SessionEnd → removed")
    } else if let s = state(for: event) {
        board[tab] = s
        print("  [\(tab)] \(event) → \(s)")
    } else {
        print("  [\(tab)] \(event) (no state change)")
    }
    printBoard()
}
