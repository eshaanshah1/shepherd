import Darwin
import Foundation

// shepherdd — Shepherd's PTY helper.
//
// `pty [-- <program> [args…]]`: run <program> (default: the login shell) on a
// fresh inner PTY and copy bytes between that PTY and our own stdio (the outer
// PTY libghostty handed us). Transparent: input in, output out, exit status and
// window size preserved. Output flows through Tee so a later milestone can fan
// it out to a replay buffer + the network without restructuring this loop.

// MARK: - Output tap

// Streams the inner PTY's output to the app's pty-data socket and injects bytes
// received back from it into the inner PTY. Strictly best-effort: if
// $SHEPHERD_PTY_SOCK is unset, the dial fails, or the socket dies, the tap stays
// disabled (sock == -1) and the helper behaves byte-identically to M0 — the local
// terminal is never blocked or broken by the tap.
final class Tee {
    static let shared = Tee()
    private var sock: Int32 = -1

    func connect(paneID: String, cols: Int, rows: Int) {
        guard let path = ProcessInfo.processInfo.environment["SHEPHERD_PTY_SOCK"], !path.isEmpty else { return }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0); guard fd >= 0 else { return }
        var addr = sockaddr_un(); addr.sun_family = sa_family_t(AF_UNIX)
        _ = path.withCString { strncpy(&addr.sun_path.0, $0, MemoryLayout.size(ofValue: addr.sun_path) - 1) }
        let ok = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) == 0 } }
        guard ok else { close(fd); return }
        // Non-blocking: output() runs inline in the pump hot path, so a wedged-but-open
        // socket must never stall the local terminal — a full send buffer drops the burst.
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK)
        // {"ptyHello":{"paneID":"…","cols":N,"rows":N}} — must match RemoteProtocol.DataMessage.
        let json = "{\"ptyHello\":{\"paneID\":\"\(paneID)\",\"cols\":\(cols),\"rows\":\(rows)}}"
        let jd = Array(json.utf8); var len = UInt32(jd.count).bigEndian
        var frame = [UInt8](); withUnsafeBytes(of: &len) { frame.append(contentsOf: $0) }; frame.append(contentsOf: jd)
        _ = frame.withUnsafeBytes { write(fd, $0.baseAddress, frame.count) }
        sock = fd
    }

    var fd: Int32 { sock }

    // Tear the tap down: close the socket and mark it dead so output() no-ops and the
    // pump can retire its poll slot. Idempotent — called on EOF/POLLHUP of the tap fd.
    func disable() {
        guard sock >= 0 else { return }
        close(sock)
        sock = -1
    }

    func output(_ buf: UnsafePointer<UInt8>, count: Int) {
        guard sock >= 0 else { return }
        var off = 0
        while off < count {
            let w = write(sock, buf + off, count - off)
            if w < 0 {
                if errno == EINTR { continue }
                // EAGAIN/EWOULDBLOCK: send buffer full. Drop the rest of this burst
                // rather than spin — the app-side replay ring + reattach recover.
                return
            }
            off += w
        }
    }
}

// MARK: - winsize handling

var gMaster: Int32 = -1
// Self-pipe: the SIGWINCH handler only writes a wake byte (async-signal-safe); the
// pump drains it and reconciles the size in the main loop. Signals coalesce, so the
// handler MUST NOT read/copy the size itself — a burst (or a lone display-change
// resize) would leave the inner PTY stuck on a stale size. Reconciling in the loop
// always reads the CURRENT outer size, so it converges on the final value.
var gWinchPipe: (read: Int32, write: Int32) = (-1, -1)
var gLastWS = winsize()
// While a remote viewer drives the size (a `.resize` frame arrived from the app), the outer
// PTY's SIGWINCH must NOT stomp the remote grid — else any Mac-side layout change would snap
// the pane back to the desktop size mid-session. `.releaseSize` clears this on the last detach.
var gAppDriven = false

func applyResize(cols: Int, rows: Int) {
    gAppDriven = true
    var ws = winsize(ws_row: UInt16(rows), ws_col: UInt16(cols), ws_xpixel: 0, ws_ypixel: 0)
    gLastWS = ws
    _ = sh_set_winsize(gMaster, &ws)
}

/// The last remote viewer left: resume sizing from the outer PTY and snap to its CURRENT size.
func releaseLocalSize() {
    gAppDriven = false
    reconcileWinsize()
}

/// Copy the outer (STDIN) winsize onto the inner master, skipping the ioctl when it
/// hasn't actually changed so we don't spam the child with redundant SIGWINCHs.
func reconcileWinsize() {
    if gAppDriven { return }   // a remote viewer owns the size — don't stomp it with the outer grid
    var ws = winsize()
    guard sh_get_winsize(STDIN_FILENO, &ws) == 0 else { return }
    if ws.ws_row == gLastWS.ws_row, ws.ws_col == gLastWS.ws_col,
       ws.ws_xpixel == gLastWS.ws_xpixel, ws.ws_ypixel == gLastWS.ws_ypixel { return }
    gLastWS = ws
    _ = sh_set_winsize(gMaster, &ws)
}

func installWinchForwarder() {
    var fds: [Int32] = [-1, -1]
    guard pipe(&fds) == 0 else { return }
    for fd in fds { _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK) }
    gWinchPipe = (fds[0], fds[1])
    signal(SIGWINCH) { _ in
        var b: UInt8 = 1
        _ = write(gWinchPipe.write, &b, 1)   // wake the pump; reconcile happens there
    }
}

// MARK: - raw mode on the outer (controlling) tty

var gOrigOuter = termios()
var gOuterWasRaw = false

// libghostty hands us the outer PTY in cooked+ECHO+ISIG mode. The shell does its
// own echo/line-editing on the INNER pty, so the outer must be a transparent raw
// conduit — otherwise input is double-echoed and line-cooked (breaking arrows,
// bracketed paste, Ctrl-C, syntax highlighting). Save the original; restore on exit.
func makeOuterRaw() {
    guard isatty(STDIN_FILENO) != 0 else { return }
    if tcgetattr(STDIN_FILENO, &gOrigOuter) != 0 { return }
    var raw = gOrigOuter
    cfmakeraw(&raw)
    if tcsetattr(STDIN_FILENO, TCSANOW, &raw) == 0 { gOuterWasRaw = true }
}

func restoreOuter() {
    if gOuterWasRaw { _ = tcsetattr(STDIN_FILENO, TCSANOW, &gOrigOuter); gOuterWasRaw = false }
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
    // Write an arbitrary byte array to `fd` (decoded app→helper input isn't in `buf`).
    func writeBytes(_ fd: Int32, _ bytes: [UInt8]) {
        var off = 0
        bytes.withUnsafeBufferPointer { p in
            guard let base = p.baseAddress else { return }
            while off < bytes.count {
                let w = write(fd, base + off, bytes.count - off)
                if w < 0 { if errno == EINTR || errno == EAGAIN { continue }; return }
                off += w
            }
        }
    }
    // App→helper bytes are framed (HelperFrame): accumulate + decode across reads.
    var appInBuf = [UInt8]()
    // n==0 is EOF; n<0 is closed too, unless it's a transient EINTR/EAGAIN. On macOS
    // a pty read after the far end closes returns -1/EIO (not 0), so we must treat
    // that as closed or the loop spins instead of tearing down.
    func closed(_ n: Int) -> Bool { n == 0 || (n < 0 && errno != EINTR && errno != EAGAIN) }

    let hup = Int16(POLLHUP | POLLERR | POLLNVAL)
    let tap = Tee.shared.fd
    var pfds = [pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0),
                pollfd(fd: master,       events: Int16(POLLIN), revents: 0)]
    let tapIdx = tap >= 0 ? pfds.count : -1
    if tap >= 0 { pfds.append(pollfd(fd: tap, events: Int16(POLLIN), revents: 0)) }
    // The SIGWINCH self-pipe read end: a wake byte here means "outer resized, reconcile".
    let winch = gWinchPipe.read
    let winchIdx = pfds.count
    if winch >= 0 { pfds.append(pollfd(fd: winch, events: Int16(POLLIN), revents: 0)) }
    while true {
        if poll(&pfds, nfds_t(pfds.count), -1) < 0 { if errno == EINTR { continue }; break }

        // outer (libghostty) → inner shell
        if pfds[0].revents & Int16(POLLIN) != 0 {
            let n = read(STDIN_FILENO, buf, cap)
            if n > 0 { writeAll(master, n) } else if closed(n) { break }
        }
        if pfds[0].revents & hup != 0 { break }       // pane/window closed by libghostty

        // inner shell → outer (+ tee)
        if pfds[1].revents & Int16(POLLIN) != 0 {
            let n = read(master, buf, cap)
            if n > 0 { writeAll(STDOUT_FILENO, n); Tee.shared.output(buf, count: n) }
            else if closed(n) { break }
        }
        if pfds[1].revents & hup != 0 {
            while true {                              // drain the child's final output
                let n = read(master, buf, cap)
                if n > 0 { writeAll(STDOUT_FILENO, n); Tee.shared.output(buf, count: n) } else { break }
            }
            break
        }

        // phone input (via the tap socket) → inner shell. Best-effort: on EOF/error or
        // hangup, retire the tap (close it + drop its poll slot to fd = -1, which poll
        // ignores) so a dead tap can't busy-spin poll(). The local terminal is untouched.
        if tapIdx >= 0, pfds[tapIdx].fd >= 0 {
            var dead = pfds[tapIdx].revents & hup != 0
            if !dead, pfds[tapIdx].revents & Int16(POLLIN) != 0 {
                let n = read(tap, buf, cap)
                if n > 0 {
                    appInBuf.append(contentsOf: UnsafeBufferPointer(start: buf, count: n))
                    for f in decodeHelperFrames(&appInBuf) {
                        if f.isResize { applyResize(cols: f.cols, rows: f.rows) }
                        else if f.isRelease { releaseLocalSize() }
                        else { writeBytes(master, f.bytes) }
                    }
                } else if closed(n) { dead = true }
            }
            if dead { Tee.shared.disable(); pfds[tapIdx].fd = -1 }
        }

        // SIGWINCH woke us (a burst coalesces into one byte): drain the pipe and
        // reconcile the inner PTY to the outer's CURRENT size — reading it here, not
        // in the async handler, is what makes a lone display-change resize stick.
        if winch >= 0, pfds[winchIdx].revents & Int16(POLLIN) != 0 {
            var drain = [UInt8](repeating: 0, count: 64)
            while read(winch, &drain, drain.count) > 0 {}
            reconcileWinsize()
        }

        pfds[0].revents = 0; pfds[1].revents = 0
        if pfds.count > 2 { pfds[2].revents = 0 }
    }
}

func exitCode(from status: Int32) -> Int32 {
    if (status & 0x7f) == 0 { return (status >> 8) & 0xff }   // WIFEXITED → WEXITSTATUS
    return 128 + (status & 0x7f)                              // killed by signal
}

func reapChild(_ pid: pid_t) -> Int32 {
    // The pump ended. If the child already exited this just reaps it. If our outer
    // tty closed (the pane was killed) the child is still alive with nothing telling
    // it to stop — so hang up its process group like a real terminal would, then
    // escalate to SIGKILL. We must never leak the shell.
    _ = kill(-pid, SIGHUP)
    var status: Int32 = 0
    for _ in 0..<50 {                                 // ~500ms grace for SIGHUP
        let r = waitpid(pid, &status, WNOHANG)
        if r == pid { return exitCode(from: status) }
        if r < 0 && errno != EINTR { return 0 }       // already reaped / gone
        usleep(10_000)
    }
    _ = kill(-pid, SIGKILL)
    while waitpid(pid, &status, 0) < 0 && errno == EINTR {}
    return exitCode(from: status)
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
    gLastWS = ws                                              // forkpty already seeded the child at this size
    let paneID = ProcessInfo.processInfo.environment["SHEPHERD_TAB_ID"] ?? ""
    Tee.shared.connect(paneID: paneID, cols: Int(ws.ws_col), rows: Int(ws.ws_row))
    makeOuterRaw()
    installWinchForwarder()
    pump(master: master)
    restoreOuter()
    return reapChild(pid)
}

func loginShell() -> String {
    if let s = ProcessInfo.processInfo.environment["SHELL"], !s.isEmpty { return s }
    if let pw = getpwuid(getuid()), let sh = pw.pointee.pw_shell { return String(cString: sh) }
    return "/bin/zsh"
}

// MARK: - attach subcommand (client side)
//
// `attach`: connect to a Shepherd host's TCP control-channel port, open a per-pane data
// channel, and be a DUMB bidirectional raw pipe between that socket and our stdio (which the
// client's libghostty drives). Handshake: send DataMessage.dataHello, await dataReady, then
// raw duplex. Host/port/nonce/pane arrive via env (SHEPHERD_ATTACH_*), never argv (no `ps`
// leak). Live resize is NOT handled here — it rides the in-app control channel (a mirror
// pane's surface size change → RemoteClient sends `resize`). Initial size ships in dataHello.

/// Dial `host:port` (IP or MagicDNS name) over TCP; returns a connected fd or -1.
func dialTCP(_ host: String, _ port: UInt16) -> Int32 {
    var hints = addrinfo(ai_flags: 0, ai_family: AF_UNSPEC, ai_socktype: SOCK_STREAM,
                         ai_protocol: 0, ai_addrlen: 0, ai_canonname: nil, ai_addr: nil, ai_next: nil)
    var res: UnsafeMutablePointer<addrinfo>?
    guard getaddrinfo(host, String(port), &hints, &res) == 0, let head = res else { return -1 }
    defer { freeaddrinfo(res) }
    var ptr: UnsafeMutablePointer<addrinfo>? = head
    while let ai = ptr {
        let fd = socket(ai.pointee.ai_family, ai.pointee.ai_socktype, ai.pointee.ai_protocol)
        if fd >= 0 {
            if Darwin.connect(fd, ai.pointee.ai_addr, ai.pointee.ai_addrlen) == 0 {
                var on: Int32 = 1
                setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &on, socklen_t(MemoryLayout<Int32>.size))
                setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
                return fd
            }
            close(fd)
        }
        ptr = ai.pointee.ai_next
    }
    return -1
}

/// `[u32 BE len][json]` — one framed control/data message, matching RemoteProtocol's codec.
func writeFramedJSON(_ fd: Int32, _ json: String) {
    let jd = Array(json.utf8); var len = UInt32(jd.count).bigEndian
    var frame = [UInt8](); withUnsafeBytes(of: &len) { frame.append(contentsOf: $0) }; frame.append(contentsOf: jd)
    var off = 0
    frame.withUnsafeBytes { p in
        guard let base = p.baseAddress else { return }
        while off < frame.count {
            let w = write(fd, base + off, frame.count - off)
            if w < 0 { if errno == EINTR { continue }; return }
            off += w
        }
    }
}

/// Read exactly `count` bytes, or nil on EOF/error — used to consume the single response
/// frame without over-reading into the raw stream that follows.
func readExactly(_ fd: Int32, _ count: Int) -> [UInt8]? {
    var out = [UInt8](); out.reserveCapacity(count)
    var buf = [UInt8](repeating: 0, count: count)
    while out.count < count {
        let n = read(fd, &buf, count - out.count)
        if n <= 0 { if n < 0 && errno == EINTR { continue }; return nil }
        out.append(contentsOf: buf[0..<n])
    }
    return out
}

/// Read the one handshake response frame; true iff it's a `dataReady` (else rejected/closed).
func awaitDataReady(_ fd: Int32) -> Bool {
    guard let lenB = readExactly(fd, 4) else { return false }
    let len = (Int(lenB[0]) << 24) | (Int(lenB[1]) << 16) | (Int(lenB[2]) << 8) | Int(lenB[3])
    guard len > 0, len <= 1 << 20, let body = readExactly(fd, len) else { return false }
    return String(decoding: body, as: UTF8.self).contains("\"dataReady\"")
}

/// Raw duplex pump: STDIN→socket (keystrokes/paste), socket→STDOUT (PTY bytes). Exits on
/// either side's EOF/hangup. No framing — the data channel is raw after dataReady.
func attachPump(_ sock: Int32) {
    let cap = 65536
    let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: cap); defer { buf.deallocate() }
    func writeAll(_ fd: Int32, _ n: Int) {
        var off = 0
        while off < n { let w = write(fd, buf + off, n - off); if w < 0 { if errno == EINTR || errno == EAGAIN { continue }; return }; off += w }
    }
    let hup = Int16(POLLHUP | POLLERR | POLLNVAL)
    var pfds = [pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0),
                pollfd(fd: sock, events: Int16(POLLIN), revents: 0)]
    while true {
        if poll(&pfds, 2, -1) < 0 { if errno == EINTR { continue }; break }
        if pfds[0].revents & Int16(POLLIN) != 0 { let n = read(STDIN_FILENO, buf, cap); if n > 0 { writeAll(sock, n) } else { break } }
        if pfds[0].revents & hup != 0 { break }
        if pfds[1].revents & Int16(POLLIN) != 0 { let n = read(sock, buf, cap); if n > 0 { writeAll(STDOUT_FILENO, n) } else { break } }
        if pfds[1].revents & hup != 0 { break }
        pfds[0].revents = 0; pfds[1].revents = 0
    }
}

func runAttach() -> Int32 {
    let env = ProcessInfo.processInfo.environment
    guard let host = env["SHEPHERD_ATTACH_HOST"], !host.isEmpty,
          let portS = env["SHEPHERD_ATTACH_PORT"], let port = UInt16(portS),
          let nonce = env["SHEPHERD_ATTACH_NONCE"], let pane = env["SHEPHERD_ATTACH_PANE"] else {
        FileHandle.standardError.write(Data("shepherdd attach: missing SHEPHERD_ATTACH_* env\n".utf8)); return 64
    }
    var ws = winsize(); _ = sh_get_winsize(STDIN_FILENO, &ws)
    let sock = dialTCP(host, port)
    guard sock >= 0 else {
        FileHandle.standardError.write(Data("shepherdd attach: cannot reach \(host):\(port)\n".utf8)); return 69
    }
    // {"dataHello":{"sessionNonce":"…","paneID":"…","cols":N,"rows":N}} — DataMessage.dataHello.
    writeFramedJSON(sock, "{\"dataHello\":{\"sessionNonce\":\"\(nonce)\",\"paneID\":\"\(pane)\",\"cols\":\(Int(ws.ws_col)),\"rows\":\(Int(ws.ws_row))}}")
    guard awaitDataReady(sock) else {
        FileHandle.standardError.write(Data("shepherdd attach: host rejected pane \(pane)\n".utf8)); close(sock); return 1
    }
    makeOuterRaw()
    attachPump(sock)
    restoreOuter()
    shutdown(sock, SHUT_RDWR); close(sock)
    return 0
}

// MARK: - entry

let argv = Array(CommandLine.arguments.dropFirst())
switch argv.first {
case "pty":
    let program: [String]
    if let dash = argv.firstIndex(of: "--"), dash + 1 < argv.count {
        program = Array(argv[(dash + 1)...])
    } else {
        program = [loginShell()]
    }
    exit(runPty(program))
case "attach":
    exit(runAttach())
default:
    FileHandle.standardError.write(Data("usage: shepherdd (pty [-- <program> …] | attach)\n".utf8))
    exit(64)
}
