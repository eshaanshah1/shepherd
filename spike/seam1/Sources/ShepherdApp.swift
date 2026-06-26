import SwiftUI
import GhosttyKit

@main
struct ShepherdApp: App {
    @StateObject private var agents = AgentStore()
    @State private var status = "initializing libghostty…"

    var body: some Scene {
        WindowGroup {
            ContentView(status: status)
                .environmentObject(agents)
                .frame(minWidth: 820, minHeight: 520)
                .onAppear { status = Self.bootGhostty() }
        }
    }

    /// Seam-1 link smoke test: prove GhosttyKit links and the libghostty C API
    /// is callable at runtime. (The actual terminal surface is the next step.)
    static func bootGhostty() -> String {
        let rc = ghostty_init(UInt(CommandLine.argc), CommandLine.unsafeArgv)
        let info = ghostty_info()
        let version: String
        if let v = info.version, info.version_len > 0 {
            let bytes = UnsafeRawBufferPointer(start: v, count: Int(info.version_len))
            version = String(decoding: bytes, as: UTF8.self)
        } else {
            version = "unknown"
        }
        return "libghostty \(version) linked ✓  (ghostty_init rc=\(rc))"
    }
}
