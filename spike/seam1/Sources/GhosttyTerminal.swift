import SwiftUI
import AppKit
import GhosttyKit

/// SwiftUI host for one libghostty terminal surface, identified by `tabID`.
struct GhosttyTerminal: NSViewRepresentable {
    let tabID: String
    let isSelected: Bool

    func makeNSView(context: Context) -> GhosttySurfaceView { GhosttySurfaceView(tabID: tabID) }

    func updateNSView(_ v: GhosttySurfaceView, context: Context) {
        v.setActive(isSelected)   // only the visible tab renders at refresh rate
        if isSelected, let w = v.window, w.firstResponder !== v {
            w.makeFirstResponder(v)
        }
    }
}

/// NSView backing one libghostty surface. libghostty owns the Metal layer and
/// drives rendering; we create/size the surface, inject per-tab env into its PTY,
/// and forward keyboard + mouse + clipboard.
final class GhosttySurfaceView: NSView {
    let tabID: String
    private var surface: ghostty_surface_t?

    init(tabID: String) {
        self.tabID = tabID
        super.init(frame: .zero)
    }
    required init?(coder: NSCoder) { fatalError("not supported") }

    override var acceptsFirstResponder: Bool { true }

    override func becomeFirstResponder() -> Bool {
        let ok = super.becomeFirstResponder()
        if ok { AgentStore.shared.didFocus(tabID: tabID) }   // focus clears need-to-check
        return ok
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard surface == nil, let window, let app = GhosttyApp.shared.app else { return }
        guard let s = makeSurface(app: app, window: window) else { return }
        surface = s
        ghostty_surface_set_focus(s, true)
        ghostty_surface_set_occlusion(s, true)
        updateDisplayID()                       // lock vsync to this screen's refresh rate
        syncSizeAndScale()
        NotificationCenter.default.addObserver(
            self, selector: #selector(screenChanged),
            name: NSWindow.didChangeScreenNotification, object: window)
    }

    /// Pause rendering for unselected tabs; the visible one renders at refresh rate.
    func setActive(_ active: Bool) {
        guard let surface else { return }
        ghostty_surface_set_occlusion(surface, active)
    }

    @objc private func screenChanged() { updateDisplayID() }

    private func updateDisplayID() {
        guard let surface, let id = window?.screen?.ghosttyDisplayID else { return }
        ghostty_surface_set_display_id(surface, id)
    }

    private func makeSurface(app: ghostty_app_t, window: NSWindow) -> ghostty_surface_t? {
        var cfg = ghostty_surface_config_new()
        cfg.platform_tag = GHOSTTY_PLATFORM_MACOS
        cfg.platform.macos.nsview = Unmanaged.passUnretained(self).toOpaque()
        cfg.userdata = Unmanaged.passUnretained(self).toOpaque()   // surface-scoped callbacks recover us via this
        cfg.scale_factor = window.backingScaleFactor

        // Inject per-tab env into the PTY so the Claude plugin's hook can report
        // back tagged with this tab. libghostty copies these during surface_new.
        var allocs: [UnsafeMutablePointer<CChar>] = []
        func dup(_ s: String) -> UnsafePointer<CChar> {
            let p = strdup(s)!
            allocs.append(p)
            return UnsafePointer(p)
        }
        var envVars = [
            ghostty_env_var_s(key: dup("SHEPHERD_SOCK"),   value: dup(AgentStore.shared.socketPath)),
            ghostty_env_var_s(key: dup("SHEPHERD_TAB_ID"), value: dup(tabID)),
        ]
        defer { allocs.forEach { free($0) } }

        // Restore-on-relaunch: open in the tab's last-known cwd if we have one.
        if let cwd = AgentStore.shared.cwd(forTab: tabID) {
            cfg.working_directory = dup(cwd)
        }

        return envVars.withUnsafeMutableBufferPointer { buf in
            cfg.env_vars = buf.baseAddress
            cfg.env_var_count = buf.count
            return ghostty_surface_new(app, &cfg)
        }
    }

    private func syncSizeAndScale() {
        guard let surface else { return }
        let backing = convertToBacking(bounds)
        let fallback = window?.backingScaleFactor ?? 2
        let xs = bounds.width > 0 ? backing.width / bounds.width : fallback
        let ys = bounds.height > 0 ? backing.height / bounds.height : fallback
        ghostty_surface_set_content_scale(surface, Double(xs), Double(ys))
        ghostty_surface_set_size(surface,
                                 UInt32(max(backing.width, 1)),
                                 UInt32(max(backing.height, 1)))
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        syncSizeAndScale()
    }

    // MARK: Keyboard — libghostty encodes control chars from the keycode.

    override func keyDown(with event: NSEvent) {
        send(event.isARepeat ? GHOSTTY_ACTION_REPEAT : GHOSTTY_ACTION_PRESS, event)
    }
    override func keyUp(with event: NSEvent) {
        send(GHOSTTY_ACTION_RELEASE, event)
    }
    override func flagsChanged(with event: NSEvent) {
        let flags = event.modifierFlags
        let action: ghostty_input_action_e
        switch event.keyCode {
        case 0x38, 0x3C: action = flags.contains(.shift) ? GHOSTTY_ACTION_PRESS : GHOSTTY_ACTION_RELEASE
        case 0x3B, 0x3E: action = flags.contains(.control) ? GHOSTTY_ACTION_PRESS : GHOSTTY_ACTION_RELEASE
        case 0x3A, 0x3D: action = flags.contains(.option) ? GHOSTTY_ACTION_PRESS : GHOSTTY_ACTION_RELEASE
        case 0x37, 0x36: action = flags.contains(.command) ? GHOSTTY_ACTION_PRESS : GHOSTTY_ACTION_RELEASE
        default: return
        }
        send(action, event)
    }

    private func send(_ action: ghostty_input_action_e, _ event: NSEvent) {
        guard let surface else { return }
        var key = event.ghosttyKeyEvent(action)
        if let text = event.ghosttyCharacters, let first = text.utf8.first, first >= 0x20 {
            _ = text.withCString { ptr -> Bool in
                key.text = ptr
                return ghostty_surface_key(surface, key)
            }
        } else {
            _ = ghostty_surface_key(surface, key)
        }
    }

    // MARK: Mouse — position is view-space with a top-left origin (NSView is bottom-left).

    private func mods(_ e: NSEvent) -> ghostty_input_mods_e { ghosttyMods(e.modifierFlags) }

    private func reportPos(_ e: NSEvent) {
        guard let surface else { return }
        let p = convert(e.locationInWindow, from: nil)
        ghostty_surface_mouse_pos(surface, p.x, frame.height - p.y, mods(e))
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach { removeTrackingArea($0) }
        addTrackingArea(NSTrackingArea(
            rect: .zero,
            options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect],
            owner: self, userInfo: nil))
    }

    override func mouseDown(with e: NSEvent) {
        if window?.firstResponder !== self { window?.makeFirstResponder(self) }
        guard let surface else { return }
        reportPos(e)
        _ = ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_LEFT, mods(e))
    }
    override func mouseUp(with e: NSEvent) {
        guard let surface else { return }
        _ = ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_LEFT, mods(e))
    }
    override func rightMouseDown(with e: NSEvent) {
        guard let surface else { return }
        reportPos(e)
        _ = ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_RIGHT, mods(e))
    }
    override func rightMouseUp(with e: NSEvent) {
        guard let surface else { return }
        _ = ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_RIGHT, mods(e))
    }
    override func otherMouseDown(with e: NSEvent) {
        guard let surface else { return }
        reportPos(e)
        _ = ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_MIDDLE, mods(e))
    }
    override func otherMouseUp(with e: NSEvent) {
        guard let surface else { return }
        _ = ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_MIDDLE, mods(e))
    }
    override func mouseMoved(with e: NSEvent) { reportPos(e) }
    override func mouseDragged(with e: NSEvent) { reportPos(e) }
    override func rightMouseDragged(with e: NSEvent) { reportPos(e) }
    override func otherMouseDragged(with e: NSEvent) { reportPos(e) }

    override func scrollWheel(with e: NSEvent) {
        guard let surface else { return }
        var x = e.scrollingDeltaX, y = e.scrollingDeltaY
        let precision = e.hasPreciseScrollingDeltas
        if precision { x *= 2; y *= 2 }
        var sm: Int32 = precision ? 1 : 0
        let mp = e.momentumPhase
        let momentum: Int32 = mp.contains(.began) ? 1
            : mp.contains(.stationary) ? 2
            : mp.contains(.changed) ? 3
            : mp.contains(.ended) ? 4 : 0
        sm |= momentum << 1
        ghostty_surface_mouse_scroll(surface, x, y, ghostty_input_scroll_mods_t(sm))
    }

    // MARK: Clipboard — called from libghostty's runtime callbacks (copy/paste keybinds).

    func readClipboard(location: ghostty_clipboard_e, state: UnsafeMutableRawPointer?) -> Bool {
        guard let surface, let str = NSPasteboard.general.string(forType: .string) else { return false }
        str.withCString { ptr in
            ghostty_surface_complete_clipboard_request(surface, ptr, state, false)
        }
        return true
    }

    func writeClipboard(content: UnsafePointer<ghostty_clipboard_content_s>?, len: Int) {
        guard let content, len > 0 else { return }
        for i in 0..<len {
            let item = content[i]
            guard let mime = item.mime, let data = item.data,
                  String(cString: mime) == "text/plain" else { continue }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(String(cString: data), forType: .string)
            return
        }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        if let surface { ghostty_surface_free(surface) }
    }
}

private extension NSScreen {
    /// CGDirectDisplayID for libghostty's vsync display link.
    var ghosttyDisplayID: UInt32? {
        (deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
    }
}

// MARK: - NSEvent → ghostty key event (ported from Ghostty's NSEvent+Extension, MIT)

private func ghosttyMods(_ flags: NSEvent.ModifierFlags) -> ghostty_input_mods_e {
    var mods: UInt32 = GHOSTTY_MODS_NONE.rawValue
    if flags.contains(.shift)    { mods |= GHOSTTY_MODS_SHIFT.rawValue }
    if flags.contains(.control)  { mods |= GHOSTTY_MODS_CTRL.rawValue }
    if flags.contains(.option)   { mods |= GHOSTTY_MODS_ALT.rawValue }
    if flags.contains(.command)  { mods |= GHOSTTY_MODS_SUPER.rawValue }
    if flags.contains(.capsLock) { mods |= GHOSTTY_MODS_CAPS.rawValue }
    return ghostty_input_mods_e(mods)
}

private extension NSEvent {
    func ghosttyKeyEvent(_ action: ghostty_input_action_e) -> ghostty_input_key_s {
        var key = ghostty_input_key_s()
        key.action = action
        key.keycode = UInt32(keyCode)       // raw macOS keycode; libghostty maps it
        key.text = nil
        key.composing = false
        key.mods = ghosttyMods(modifierFlags)
        key.consumed_mods = ghosttyMods(modifierFlags.subtracting([.control, .command]))
        key.unshifted_codepoint = 0
        if type == .keyDown || type == .keyUp,
           let chars = characters(byApplyingModifiers: []),
           let scalar = chars.unicodeScalars.first {
            key.unshifted_codepoint = scalar.value
        }
        return key
    }

    /// Text for the event, excluding control chars (Ghostty encodes those) and PUA function keys.
    var ghosttyCharacters: String? {
        guard let characters else { return nil }
        if characters.count == 1, let scalar = characters.unicodeScalars.first {
            if scalar.value < 0x20 {
                return self.characters(byApplyingModifiers: modifierFlags.subtracting(.control))
            }
            if scalar.value >= 0xF700 && scalar.value <= 0xF8FF { return nil }
        }
        return characters
    }
}
