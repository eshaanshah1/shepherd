import Foundation
import AppKit

/// Installs a downloaded update by launching a detached bash script that waits
/// for this app to quit, overwrites the installed bundle, strips quarantine
/// (the app is ad-hoc signed / not notarized), and relaunches. The destructive
/// overwrite is the LAST step, so any earlier failure leaves the old app intact.
enum UpdateInstaller {
    /// Pure: the detached script body. Takes NO interpolated data — pid /
    /// newBundle / installedPath / logPath arrive as positional arguments
    /// (`$1`…`$4`), so a hostile path (e.g. a crafted release tag baked into the
    /// unpack dir) can never break out of a quoted string into shell commands.
    static func swapScript() -> String {
        """
        #!/bin/bash
        pid="$1"; newBundle="$2"; installedPath="$3"; logPath="$4"
        exec >> "$logPath" 2>&1
        echo "[$(date)] waiting for pid $pid to exit"
        while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
        echo "[$(date)] swapping bundle"
        rm -rf "$installedPath"
        ditto "$newBundle" "$installedPath" || { echo "ditto failed"; exit 1; }
        xattr -dr com.apple.quarantine "$installedPath" 2>/dev/null
        echo "[$(date)] relaunching"
        open "$installedPath"
        """
    }

    /// Write the script into a fresh, private (0700) temp dir and launch it
    /// detached, passing the paths as arguments; the caller then terminates.
    static func install(newBundle: String, installedPath: String) {
        let pid = ProcessInfo.processInfo.processIdentifier
        let logPath = "/tmp/shepherd-update.log"
        let dir = uniqueTempDir()
        let scriptPath = (dir as NSString).appendingPathComponent("shepherd-swap.sh")
        try? swapScript().write(toFile: scriptPath, atomically: true, encoding: .utf8)

        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [scriptPath, String(pid), newBundle, installedPath, logPath]
        // Detach so it outlives this process (which is about to terminate).
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try? p.run()
    }

    /// A fresh, unpredictable, user-private (0700) temp directory. `mkdtemp`
    /// creates it atomically with 0700 perms, defeating symlink/TOCTOU races on
    /// a predictable path.
    static func uniqueTempDir() -> String {
        let template = (NSTemporaryDirectory() as NSString).appendingPathComponent("shepherd-update-XXXXXX")
        var buf = Array(template.utf8CString)
        let ok = buf.withUnsafeMutableBufferPointer { mkdtemp($0.baseAddress) != nil }
        if ok { return String(cString: buf) }
        let dir = (NSTemporaryDirectory() as NSString).appendingPathComponent("shepherd-update-" + UUID().uuidString)
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        return dir
    }
}
