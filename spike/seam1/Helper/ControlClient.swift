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

    if verb == "wait" { return runWait(Array(argv.dropFirst()), sockPath: sockPath) }

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
    case "ping":   return ["cmd": "ping"]
    case "ls":     return ["cmd": "ls"]
    case "whoami": return ["cmd": "whoami", "pane": ProcessInfo.processInfo.environment["SHEPHERD_TAB_ID"] ?? ""]
    case "state":  guard let p = rest.first else { return nil }; return ["cmd": "state", "pane": p]

    case "workspace":
        guard let sub = rest.first else { return nil }
        switch sub {
        case "new":    return ["cmd": "workspace-new"]
        case "rename": guard rest.count >= 3 else { return nil }; return ["cmd": "workspace-rename", "workspace": rest[1], "name": rest[2]]
        case "switch": guard rest.count >= 2 else { return nil }; return ["cmd": "workspace-switch", "workspace": rest[1]]
        case "rm":     guard rest.count >= 2 else { return nil }; return ["cmd": "workspace-rm", "workspace": rest[1], "force": rest.contains("--force")]
        default: return nil
        }
    case "tab":
        guard let sub = rest.first else { return nil }
        switch sub {
        case "new":    return rest.count >= 2 ? ["cmd": "tab-new", "workspace": rest[1]] : ["cmd": "tab-new"]
        case "rename": guard rest.count >= 3 else { return nil }; return ["cmd": "tab-rename", "tab": rest[1], "name": rest[2]]
        case "switch": guard rest.count >= 2 else { return nil }; return ["cmd": "tab-switch", "tab": rest[1]]
        case "close":  guard rest.count >= 2 else { return nil }; return ["cmd": "tab-close", "tab": rest[1], "force": rest.contains("--force"), "archive": rest.contains("--archive")]
        default: return nil
        }
    case "pane":
        guard let sub = rest.first, rest.count >= 2 else { return nil }
        switch sub {
        case "split": return ["cmd": "split", "pane": rest[1], "axis": rest.contains("--down") ? "column" : "row"]
        case "close": return ["cmd": "pane-close", "pane": rest[1], "force": rest.contains("--force")]
        default: return nil
        }
    case "split": guard let p = rest.first else { return nil }; return ["cmd": "split", "pane": p, "axis": rest.contains("--down") ? "column" : "row"]
    case "focus": guard let p = rest.first else { return nil }; return ["cmd": "focus", "pane": p]
    case "zoom":  guard let p = rest.first else { return nil }; return ["cmd": "zoom", "pane": p]

    case "tell":
        guard rest.count >= 2 else { return nil }
        return ["cmd": "tell", "pane": rest[0], "text": rest[1], "enter": !rest.contains("--no-enter")]

    case "view":
        guard let p = rest.first else { return nil }
        var req: [String: Any] = ["cmd": "view", "pane": p]
        if let i = rest.firstIndex(of: "--lines"), i + 1 < rest.count, let n = Int(rest[i + 1]) { req["lines"] = n }
        if rest.contains("--raw") { req["raw"] = true }
        return req

    case "config":
        guard let sub = rest.first else { return nil }
        switch sub {
        case "get":  guard rest.count >= 2 else { return nil }; return ["cmd": "config-get", "key": rest[1]]
        case "set":  guard rest.count >= 3 else { return nil }; return ["cmd": "config-set", "key": rest[1], "value": rest[2]]
        case "list": return ["cmd": "config-list"]
        default: return nil
        }

    default:       return nil
    }
}

/// Response formatter. Extended in later tasks.
func printData(verb: String, data: Any?) {
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
    if verb == "view", let d = data as? [String: Any] { print(d["text"] as? String ?? ""); return }
    if verb == "config", let d = data as? [String: Any] {
        if let items = d["items"] as? [[String: Any]] {
            for it in items { print("\(it["key"] as? String ?? "")\t= \(it["value"] as? String ?? "")\t(\(it["backend"] as? String ?? ""))") }
        } else if let v = d["value"] { print(v is NSNull ? "" : "\(v)") }
        return
    }
    // Handle-returning verbs print a bare, scriptable token instead of JSON:
    // tab new / split → the new pane; workspace new → the workspace; state → the
    // state word; whoami → "pane tab workspace". Silent (NSNull) verbs fall through.
    if let d = data as? [String: Any] {
        switch verb {
        case "tab", "split", "pane": if let p = d["pane"] as? String { print(p); return }
        case "workspace":            if let w = d["workspace"] as? String { print(w); return }
        case "whoami":               print([d["pane"], d["tab"], d["workspace"]].compactMap { $0 as? String }.joined(separator: " ")); return
        case "state":                if let s = d["state"] as? String { print(s); return }
        default: break
        }
    }
    if let s = data as? String { print(s) }
    else if let data, !(data is NSNull),
            let out = try? JSONSerialization.data(withJSONObject: data, options: [.prettyPrinted]) {
        print(String(decoding: out, as: UTF8.self))
    }
}

/// Block until a pane reaches a target state, polling the `state` verb so the
/// server stays non-blocking. Exit 0 = matched (prints the state), 2 = timeout.
func runWait(_ rest: [String], sockPath: String) -> Int32 {
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

func roundTrip(sockPath: String, request: [String: Any]) -> [String: Any]? {
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
    return ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])
}
