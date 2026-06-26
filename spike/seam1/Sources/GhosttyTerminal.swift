import SwiftUI
import AppKit
import GhosttyKit

/// SwiftUI host for one libghostty terminal surface, identified by `tabID`.
struct GhosttyTerminal: NSViewRepresentable {
    let tabID: String
    let isSelected: Bool

    func makeNSView(context: Context) -> GhosttySurfaceView { GhosttySurfaceView(tabID: tabID) }

    func updateNSView(_ v: GhosttySurfaceView, context: Context) {
        // When this tab becomes the selected one, give its surface keyboard focus.
        if isSelected, let w = v.window, w.firstResponder !== v {
            w.makeFirstResponder(v)
        }
    }
}

/// NSView backing one libghostty surface. libghostty owns the Metal layer and
/// drives rendering; we create/size the surface, inject the per-tab env
/// (SHEPHERD_SOCK / SHEPHERD_TAB_ID) into its PTY, and forward input + focus.
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
        syncSizeAndScale()
    }

    private func makeSurface(app: ghostty_app_t, window: NSWindow) -> ghostty_surface_t? {
        var cfg = ghostty_surface_config_new()
        cfg.platform_tag = GHOSTTY_PLATFORM_MACOS
        cfg.platform.macos.nsview = Unmanaged.passUnretained(self).toOpaque()
        cfg.scale_factor = window.backingScaleFactor

        // Inject per-tab env into the PTY so the Claude plugin's hook can report
        // back tagged with this tab. libghostty copies these during surface_new,
        // so the strdup'd strings only need to live across the call.
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

    // MARK: Input — real key events (libghostty encodes control chars from keycode).

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

    deinit {
        if let surface { ghostty_surface_free(surface) }
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
