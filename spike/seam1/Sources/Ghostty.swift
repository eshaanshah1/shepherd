import AppKit
import GhosttyKit

/// Owns the single libghostty app instance: global init, config, the runtime
/// callback table, and the tick pump (SPEC §5). Terminal surfaces attach to `app`.
final class GhosttyApp {
    static let shared = GhosttyApp()

    private(set) var app: ghostty_app_t? = nil
    let version: String

    /// Live terminal surfaces, weakly held, so a config reload can push a fresh
    /// config to each one (`ghostty_surface_update_config`). Views register on
    /// creation and drop out on `deinit`.
    private let surfaceViews = NSHashTable<GhosttySurfaceView>.weakObjects()
    func register(_ view: GhosttySurfaceView)   { surfaceViews.add(view) }
    func unregister(_ view: GhosttySurfaceView) { surfaceViews.remove(view) }

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

        // 2) Config: our base theme, then Shepherd's own ~/.config/shepherd/config.
        guard let cfg = Self.buildConfig() else { return }

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

    /// Build a finalized ghostty config: our (mode-aware) base theme, then
    /// Shepherd's own ~/.config/shepherd/config (ghostty syntax) on top so the
    /// user configures Shepherd independently of ghostty. We deliberately do NOT
    /// read ~/.config/ghostty. Caller owns the returned config (free it after use,
    /// except the one handed to `ghostty_app_new` at launch).
    private static func buildConfig() -> ghostty_config_t? {
        guard let cfg = ghostty_config_new() else { return nil }
        if let themePath = Self.writeBaseTheme() {
            themePath.withCString { ghostty_config_load_file(cfg, $0) }
        }
        let shepherdCfg = (NSHomeDirectory() as NSString).appendingPathComponent(".config/shepherd/config")
        if FileManager.default.fileExists(atPath: shepherdCfg) {
            shepherdCfg.withCString { ghostty_config_load_file(cfg, $0) }
        }
        ghostty_config_finalize(cfg)
        return cfg
    }

    /// Re-read the config and propagate it live (⌘⇧R) — no rebuild/relaunch.
    /// Re-resolves the theme, rebuilds the ghostty config, pushes it to the app +
    /// every live surface (grid repaints, PTYs survive), then re-renders the chrome.
    /// Main-thread only (libghostty C API + AppKit).
    @MainActor func reloadConfig() {
        Theme.reloadMode()
        guard let app, let cfg = Self.buildConfig() else { return }
        ghostty_app_update_config(app, cfg)
        for view in surfaceViews.allObjects { view.updateConfig(cfg) }
        ghostty_config_free(cfg)
        AgentStore.shared.bumpTheme()
    }

    /// Write the Command Deck base theme to a temp file and return its path.
    /// libghostty only loads config from files, so we materialize one.
    private static func writeBaseTheme() -> String? {
        let dark = """
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
        // Light mirror — warm off-white ground; the 0/7/8/15 grayscale ramp flips so
        // text stays legible on white. Kept in sync with Theme.swift (ADR 0010).
        let light = """
        background = FBFBF9
        foreground = 1A1A1E
        cursor-color = 2F7DE1
        selection-background = D6E4FB
        selection-foreground = 1A1A1E
        palette = 0=#1A1A1E
        palette = 8=#6A6A72
        palette = 1=#D23A33
        palette = 9=#E5645D
        palette = 2=#1FA463
        palette = 10=#2FBE7C
        palette = 3=#C7811A
        palette = 11=#E5A23D
        palette = 4=#2F7DE1
        palette = 12=#5B9DF8
        palette = 5=#8250DF
        palette = 13=#A371F7
        palette = 6=#178F85
        palette = 14=#2FB0A4
        palette = 7=#9A9AA2
        palette = 15=#1A1A1E
        """
        // Warm cream/sepia middle-ground — mapped from ~/.claude/themes/shepherd.json.
        // Paper ground, warm brown text, muted earthy ANSI. In sync with Theme.swift.
        let warm = """
        background = FAF4E6
        foreground = 43413A
        cursor-color = 4A7996
        selection-background = E0D3B4
        selection-foreground = 43413A
        palette = 0=#43413A
        palette = 8=#8F897A
        palette = 1=#B04A3D
        palette = 9=#C05F3A
        palette = 2=#6F8F3D
        palette = 10=#8BA85A
        palette = 3=#B5841C
        palette = 11=#D1A542
        palette = 4=#4A7996
        palette = 12=#6F9BB8
        palette = 5=#8563A8
        palette = 13=#A288C4
        palette = 6=#4A8F85
        palette = 14=#6FB0A4
        palette = 7=#8F897A
        palette = 15=#43413A
        """
        let theme: String
        switch Theme.mode {
        case .dark:  theme = dark
        case .light: theme = light
        case .warm:  theme = warm
        }
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

    /// The paneID for a surface-target action, or nil if the target isn't a surface.
    private static func surfacePaneID(_ target: ghostty_target_s) -> String? {
        guard target.tag == GHOSTTY_TARGET_SURFACE,
              let surface = target.target.surface,
              let ud = ghostty_surface_userdata(surface) else { return nil }
        return view(ud).paneID
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
        case GHOSTTY_ACTION_SEARCH_TOTAL:
            guard let id = surfacePaneID(target) else { return false }
            let total = Int(action.action.search_total.total)
            DispatchQueue.main.async { AgentStore.shared.setSearchTotal(total, paneID: id) }
            return true
        case GHOSTTY_ACTION_SEARCH_SELECTED:
            guard let id = surfacePaneID(target) else { return false }
            let sel = Int(action.action.search_selected.selected)   // 1-based; -1 = none
            DispatchQueue.main.async { AgentStore.shared.setSearchSelected(sel, paneID: id) }
            return true
        case GHOSTTY_ACTION_END_SEARCH:
            guard let id = surfacePaneID(target) else { return false }
            DispatchQueue.main.async { AgentStore.shared.endSearchFromCore(paneID: id) }
            return true
        default:
            return false
        }
    }
}
