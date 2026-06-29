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
