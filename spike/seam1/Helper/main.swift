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
    // n==0 is EOF; n<0 is closed too, unless it's a transient EINTR/EAGAIN. On macOS
    // a pty read after the far end closes returns -1/EIO (not 0), so we must treat
    // that as closed or the loop spins instead of tearing down.
    func closed(_ n: Int) -> Bool { n == 0 || (n < 0 && errno != EINTR && errno != EAGAIN) }

    let hup = Int16(POLLHUP | POLLERR | POLLNVAL)
    var pfds = [pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0),
                pollfd(fd: master,       events: Int16(POLLIN), revents: 0)]
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
        pfds[0].revents = 0; pfds[1].revents = 0
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
