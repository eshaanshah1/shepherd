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

        // 2) Config: our base theme, then Shepherd's own ~/.config/shepherd/config
        //    (ghostty syntax) on top so the user configures Shepherd independently
        //    of ghostty. We deliberately do NOT read ~/.config/ghostty.
        guard let cfg = ghostty_config_new() else { return }
        if let themePath = Self.writeBaseTheme() {
            themePath.withCString { ghostty_config_load_file(cfg, $0) }
        }
        let shepherdCfg = (NSHomeDirectory() as NSString).appendingPathComponent(".config/shepherd/config")
        if FileManager.default.fileExists(atPath: shepherdCfg) {
            shepherdCfg.withCString { ghostty_config_load_file(cfg, $0) }
        }
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
                let id = GhosttyApp.view(userdata).paneID
                DispatchQueue.main.async { AgentStore.shared.closePane(id) }
            }
        )

        guard let app = ghostty_app_new(&runtime, cfg) else { return }
        self.app = app
        ghostty_app_set_focus(app, true)
    }

    /// Write the Command Deck base theme to a temp file and return its path.
    /// libghostty only loads config from files, so we materialize one.
    private static func writeBaseTheme() -> String? {
        let theme = """
        background = 0F0F11
        foreground = EDEDED
        cursor-color = 5B9DF8
        selection-background = 232327
        selection-foreground = EDEDED
        palette = 0=#0F0F11
        palette = 8=#5F5F66
        palette = 1=#E5645D
        palette = 9=#EC8983
        palette = 2=#43C988
        palette = 10=#6FE0A6
        palette = 3=#E5A23D
        palette = 11=#ECBB6F
        palette = 4=#5B9DF8
        palette = 12=#82B6FA
        palette = 5=#B98BFF
        palette = 13=#CDAEFF
        palette = 6=#4DD0C4
        palette = 14=#7FE0D6
        palette = 7=#8C8C92
        palette = 15=#EDEDED
        """
        let path = (NSTemporaryDirectory() as NSString).appendingPathComponent("shepherd-theme.conf")
        guard (try? theme.write(toFile: path, atomically: true, encoding: .utf8)) != nil else { return nil }
        return path
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
            let id = view(ud).paneID
            let title = String(cString: cTitle)
            DispatchQueue.main.async { AgentStore.shared.setTitle(title, paneID: id) }
            return true
        case GHOSTTY_ACTION_PWD:
            guard target.tag == GHOSTTY_TARGET_SURFACE,
                  let surface = target.target.surface,
                  let ud = ghostty_surface_userdata(surface),
                  let cPwd = action.action.pwd.pwd else { return false }
            let id = view(ud).paneID
            let pwd = String(cString: cPwd)
            DispatchQueue.main.async { AgentStore.shared.setCwd(pwd, paneID: id) }
            return true
        default:
            return false
        }
    }
}
