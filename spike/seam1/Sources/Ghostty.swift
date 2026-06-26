import AppKit
import GhosttyKit

/// Owns the single libghostty app instance: global init, config, the runtime
/// callback table, and the tick pump (SPEC §5). Terminal surfaces attach to `app`.
final class GhosttyApp {
    static let shared = GhosttyApp()

    private(set) var app: ghostty_app_t? = nil
    let version: String

    private init() {
        // 1) Global init with argc/argv.
        _ = ghostty_init(UInt(CommandLine.argc), CommandLine.unsafeArgv)

        // Version string (also our seam-1 "C API is live" signal).
        let info = ghostty_info()
        if let v = info.version, info.version_len > 0 {
            version = String(decoding: UnsafeRawBufferPointer(start: v, count: Int(info.version_len)),
                             as: UTF8.self)
        } else {
            version = "unknown"
        }
        // From here on `self` is fully initialized (app defaulted, version set).

        // 2) Config: built-in defaults + the user's ~/.config/ghostty, then finalize.
        guard let cfg = ghostty_config_new() else { return }
        ghostty_config_load_default_files(cfg)
        ghostty_config_finalize(cfg)

        // 3) Runtime callbacks. These become @convention(c) pointers, so each must
        //    be non-capturing (they only call statics / use the userdata pointer).
        var runtime = ghostty_runtime_config_s(
            userdata: Unmanaged.passUnretained(self).toOpaque(),
            supports_selection_clipboard: false,
            wakeup_cb: { userdata in GhosttyApp.wakeup(userdata) },
            action_cb: { _, _, _ in false },
            read_clipboard_cb: { _, _, _ in false },
            confirm_read_clipboard_cb: { _, _, _, _ in },
            write_clipboard_cb: { _, _, _, _, _ in },
            close_surface_cb: { _, _ in }
        )

        guard let app = ghostty_app_new(&runtime, cfg) else { return }
        self.app = app
        ghostty_app_set_focus(app, true)
    }

    func tick() {
        guard let app else { return }
        ghostty_app_tick(app)
    }

    /// libghostty may call this from any thread; pump the tick on the main thread.
    private static func wakeup(_ userdata: UnsafeMutableRawPointer?) {
        guard let userdata else { return }
        let me = Unmanaged<GhosttyApp>.fromOpaque(userdata).takeUnretainedValue()
        DispatchQueue.main.async { me.tick() }
    }
}
