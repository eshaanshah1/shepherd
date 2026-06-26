import SwiftUI
import AppKit
import GhosttyKit

/// SwiftUI host for a libghostty terminal surface.
struct GhosttyTerminal: NSViewRepresentable {
    func makeNSView(context: Context) -> GhosttySurfaceView { GhosttySurfaceView() }
    func updateNSView(_ nsView: GhosttySurfaceView, context: Context) {}
}

/// NSView backing one libghostty surface. libghostty owns the Metal layer and
/// drives rendering into this view; we create/size the surface and forward input.
final class GhosttySurfaceView: NSView {
    private var surface: ghostty_surface_t?

    override var acceptsFirstResponder: Bool { true }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard surface == nil, let window, let app = GhosttyApp.shared.app else { return }

        var cfg = ghostty_surface_config_new()
        cfg.platform_tag = GHOSTTY_PLATFORM_MACOS
        cfg.platform.macos.nsview = Unmanaged.passUnretained(self).toOpaque()
        cfg.scale_factor = window.backingScaleFactor

        guard let s = ghostty_surface_new(app, &cfg) else { return }
        surface = s
        ghostty_surface_set_focus(s, true)
        syncSizeAndScale()
        window.makeFirstResponder(self)
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

    // MARK: Input — real key events. libghostty encodes control chars (Enter,
    // Ctrl-C, arrows…) itself from the keycode; we only attach `text` for
    // printable characters (codepoint >= 0x20).

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
