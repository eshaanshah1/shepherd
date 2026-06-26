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
        //    be non-capturing. Surface-scoped callbacks (clipboard, close) receive
        //    the *surface's* userdata (which we set to the GhosttySurfaceView).
        var runtime = ghostty_runtime_config_s(
            userdata: Unmanaged.passUnretained(self).toOpaque(),
            supports_selection_clipboard: false,
            wakeup_cb: { userdata in GhosttyApp.wakeup(userdata) },
            action_cb: { app, target, action in GhosttyApp.handleAction(app, target, action) },
            read_clipboard_cb: { userdata, location, state in
                guard let userdata else { return false }
                return GhosttyApp.view(userdata).readClipboard(location: location, state: state)
            },
            confirm_read_clipboard_cb: { _, _, _, _ in },
            write_clipboard_cb: { userdata, _, content, len, _ in
                guard let userdata else { return }
                GhosttyApp.view(userdata).writeClipboard(content: content, len: Int(len))
            },
            close_surface_cb: { userdata, _ in
                guard let userdata else { return }
                let id = GhosttyApp.view(userdata).tabID
                DispatchQueue.main.async { AgentStore.shared.closeTab(id) }
            }
        )

        guard let app = ghostty_app_new(&runtime, cfg) else { return }
        self.app = app
        ghostty_app_set_focus(app, true)
    }

    func tick() {
        guard let app else { return }
        ghostty_app_tick(app)
    }

    // MARK: Callback plumbing

    /// libghostty may call this from any thread; pump the tick on the main thread.
    private static func wakeup(_ userdata: UnsafeMutableRawPointer?) {
        guard let userdata else { return }
        let me = Unmanaged<GhosttyApp>.fromOpaque(userdata).takeUnretainedValue()
        DispatchQueue.main.async { me.tick() }
    }

    /// Recover the surface view from a surface-scoped callback's userdata.
    private static func view(_ userdata: UnsafeMutableRawPointer) -> GhosttySurfaceView {
        Unmanaged<GhosttySurfaceView>.fromOpaque(userdata).takeUnretainedValue()
    }

    /// Handle surface actions. We currently only consume SET_TITLE → sidebar label;
    /// everything else is left to libghostty's defaults.
    private static func handleAction(
        _ app: ghostty_app_t?,
        _ target: ghostty_target_s,
        _ action: ghostty_action_s
    ) -> Bool {
        switch action.tag {
        case GHOSTTY_ACTION_SET_TITLE:
            guard target.tag == GHOSTTY_TARGET_SURFACE,
                  let surface = target.target.surface,
                  let ud = ghostty_surface_userdata(surface),
                  let cTitle = action.action.set_title.title else { return false }
            let id = view(ud).tabID
            let title = String(cString: cTitle)
            DispatchQueue.main.async { AgentStore.shared.setTitle(title, tabID: id) }
            return true
        default:
            return false
        }
    }
}
