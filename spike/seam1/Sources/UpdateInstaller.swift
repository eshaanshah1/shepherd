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
