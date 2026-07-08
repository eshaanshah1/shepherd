import SwiftUI
import AppKit
import QuartzCore
import GhosttyKit

/// SwiftUI host for one libghostty terminal surface, identified by `paneID`.
struct GhosttyTerminal: NSViewRepresentable {
    let paneID: String
    let isVisible: Bool      // on screen now → render at refresh rate (occlusion)
    let isSelected: Bool     // this tab's focused pane → hold first responder
    var focusTick: Int = 0   // changing this re-runs updateNSView so we can reclaim focus

    func makeNSView(context: Context) -> GhosttySurfaceView { GhosttySurfaceView(paneID: paneID) }

    func updateNSView(_ v: GhosttySurfaceView, context: Context) {
        v.setActive(isVisible)   // every visible pane renders; only hidden ones pause
        v.hitTestable = isVisible // only the selected tab's on-screen panes take clicks
        if isSelected, let w = v.window, w.firstResponder !== v {
            w.makeFirstResponder(v)
        }
    }
}

/// NSView backing one libghostty surface. libghostty owns the Metal layer and
/// drives rendering; we create/size the surface, inject per-pane env into its PTY,
/// and forward keyboard + mouse + clipboard.
final class GhosttySurfaceView: NSView {
    let paneID: String
    private var surface: ghostty_surface_t?

    init(paneID: String) {
        self.paneID = paneID
        super.init(frame: .zero)
        NotificationCenter.default.addObserver(self, selector: #selector(paneClosed(_:)),
                                               name: .shepherdPaneClosed, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(performBinding(_:)),
                                               name: .shepherdPerformBinding, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(injectText(_:)),
                                               name: .shepherdInjectText, object: nil)
    }
    required init?(coder: NSCoder) { fatalError("not supported") }

    /// Invoke a libghostty keybind action (e.g. "search:foo", "navigate_search:next",
    /// "end_search") on this surface by name — the app→core channel for terminal
    /// search. Posted per pane so the matching surface performs it; runs on main.
    static func perform(paneID: String, binding action: String) {
        NotificationCenter.default.post(name: .shepherdPerformBinding, object: nil,
                                        userInfo: ["paneID": paneID, "action": action])
    }

    /// Inject a text string straight into this pane's PTY (as if typed). Used by the
    /// diff-review "send to agent" action. Posted per pane; runs on main.
    static func perform(paneID: String, injectText text: String) {
        NotificationCenter.default.post(name: .shepherdInjectText, object: nil,
                                        userInfo: ["paneID": paneID, "text": text])
    }

    @objc private func performBinding(_ note: Notification) {
        guard note.userInfo?["paneID"] as? String == paneID,
              let action = note.userInfo?["action"] as? String,
              let surface else { return }
        _ = action.withCString {
            ghostty_surface_binding_action(surface, $0, UInt(action.utf8.count))
        }
    }

    @objc private func injectText(_ note: Notification) {
        guard note.userInfo?["paneID"] as? String == paneID,
              let text = note.userInfo?["text"] as? String,
              let surface else { return }
        var key = ghostty_input_key_s()
        key.action = GHOSTTY_ACTION_PRESS
        key.mods = ghostty_input_mods_e(GHOSTTY_MODS_NONE.rawValue)
        key.consumed_mods = ghostty_input_mods_e(GHOSTTY_MODS_NONE.rawValue)
        key.keycode = 0
        key.composing = false
        key.unshifted_codepoint = 0
        _ = text.withCString { ptr -> Bool in
            key.text = ptr
            return ghostty_surface_key(surface, key)
        }
    }

    /// The pane was removed from the model. Free the surface now — which closes the
    /// PTY and tears down its child — instead of waiting on SwiftUI to deallocate
    /// this view, which it does not do deterministically (the child would leak).
    @objc private func paneClosed(_ note: Notification) {
        guard note.userInfo?["paneID"] as? String == paneID, let s = surface else { return }
        surface = nil
        ghostty_surface_free(s)
    }

    /// Only the selected tab's on-screen panes should receive clicks. Every tab of
    /// every workspace stays mounted (agents keep running), and SwiftUI's
    /// `.allowsHitTesting(false)` on the hidden ones does NOT propagate to the raw
    /// surface — so without this gate, a background tab's full-size surface overlaps
    /// the visible split and swallows clicks meant for its panes.
    var hitTestable = false

    override func hitTest(_ point: NSPoint) -> NSView? {
        hitTestable ? super.hitTest(point) : nil
    }

    override var acceptsFirstResponder: Bool { true }

    override func becomeFirstResponder() -> Bool {
        let ok = super.becomeFirstResponder()
        if ok { AgentStore.shared.focusPane(paneID) }   // move tab focus here + clear need-to-check
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

        // Claim keyboard focus on launch/restore if our pane is the selected
        // tab's focused pane — else first responder lands on a SwiftUI control
        // and keystrokes miss the PTY.
        if AgentStore.shared.isFocusedSurface(paneID: paneID) {
            DispatchQueue.main.async { [weak self] in
                guard let self, let window = self.window else { return }
                window.makeFirstResponder(self)
            }
        }
        NotificationCenter.default.addObserver(
            self, selector: #selector(screenChanged),
            name: NSWindow.didChangeScreenNotification, object: window)
    }

    /// Pause rendering for unselected tabs; the visible one renders at refresh rate.
    func setActive(_ active: Bool) {
        guard let surface else { return }
        ghostty_surface_set_occlusion(surface, active)
    }

    @objc private func screenChanged() {
        updateDisplayID()
        syncSizeAndScale()
    }

    /// Backing scale factor changed — e.g. the window moved to a display with a
    /// different DPI. libghostty renders the grid at the right pixel size, but the
    /// Metal layer keeps the contentsScale it was born with, so Core Animation would
    /// rescale the whole layer during compositing (text 2× too big on the other
    /// display). Pin contentsScale to the new screen — inside a CATransaction with
    /// actions off so CA doesn't animate the jump — then re-sync libghostty. (Mirrors
    /// Ghostty's own SurfaceView; this is the piece a fresh surface gets for free.)
    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        if let window {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            layer?.contentsScale = window.backingScaleFactor
            CATransaction.commit()
        }
        updateDisplayID()
        syncSizeAndScale()
    }

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

        // Inject per-pane env into the PTY so the Claude plugin's hook can report
        // back tagged with this pane. The env var name is still SHEPHERD_TAB_ID
        // (plugin compat); its value is this paneID. libghostty copies these
        // during surface_new.
        var allocs: [UnsafeMutablePointer<CChar>] = []
        func dup(_ s: String) -> UnsafePointer<CChar> {
            let p = strdup(s)!
            allocs.append(p)
            return UnsafePointer(p)
        }
        var envVars: [ghostty_env_var_s]
        if let info = AgentStore.shared.remoteAttachInfo(forPane: paneID) {
            // MIRROR pane (M2): its surface is a raw byte pipe to the host's pane via
            // `shepherdd attach`. No local hooks/cwd/resume — the PTY lives on the host; the
            // attach process just carries its bytes. Params ride env, not argv (no `ps` leak).
            envVars = [
                ghostty_env_var_s(key: dup("SHEPHERD_ATTACH_HOST"),  value: dup(info.host)),
                ghostty_env_var_s(key: dup("SHEPHERD_ATTACH_PORT"),  value: dup(String(info.port))),
                ghostty_env_var_s(key: dup("SHEPHERD_ATTACH_NONCE"), value: dup(info.nonce)),
                ghostty_env_var_s(key: dup("SHEPHERD_ATTACH_PANE"),  value: dup(info.remotePaneID)),
            ]
            cfg.command = dup("\(AgentStore.shared.helperPath) attach")
        } else {
            envVars = [
                ghostty_env_var_s(key: dup("SHEPHERD_SOCK"),     value: dup(AgentStore.shared.socketPath)),
                ghostty_env_var_s(key: dup("SHEPHERD_TAB_ID"),   value: dup(paneID)),
                ghostty_env_var_s(key: dup("SHEPHERD_PTY_SOCK"), value: dup(AgentStore.shared.ptySocketPath)),
            ]
            // Restore-on-relaunch: open in the pane's last-known cwd if we have one.
            if let cwd = AgentStore.shared.cwd(forPane: paneID) {
                cfg.working_directory = dup(cwd)
            }
            // If this pane had a live Claude session at quit, resume it: type `claude --resume <id>`
            // into the PTY once the shell (or the shepherdd pty wrapper) is up. Only restored panes
            // carry a sessionID at creation; fresh panes don't, so nothing is injected for them.
            if let resume = AgentStore.shared.takeResumeInput(forPane: paneID) {
                cfg.initial_input = dup(resume)
            }
            if let cmd = remoteSurfaceCommand(serving: AgentStore.shared.isServing,
                                              helperPath: AgentStore.shared.helperPath) {
                cfg.command = dup(cmd)
            }
        }
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
        // A click must switch the focused/active pane deterministically: move keyboard focus
        // here AND update the model directly, rather than relying solely on becomeFirstResponder
        // firing (which we don't control the timing/return of). focusPane is idempotent.
        if window?.firstResponder !== self { window?.makeFirstResponder(self) }
        AgentStore.shared.focusPane(paneID)
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

extension Notification.Name {
    /// Posted (with userInfo `["paneID": String]`) when a pane is closed in the
    /// model, so its surface view can free the libghostty surface synchronously.
    static let shepherdPaneClosed = Notification.Name("shepherd.paneClosed")

    /// Posted (with userInfo `["paneID": String, "action": String]`) to invoke a
    /// libghostty keybind action on a specific pane's surface — the app→core
    /// channel for terminal search.
    static let shepherdPerformBinding = Notification.Name("shepherd.performBinding")

    /// Posted (userInfo `["paneID": String, "text": String]`) to inject text into a
    /// pane's PTY — the diff-review comment→prompt channel.
    static let shepherdInjectText = Notification.Name("shepherd.injectText")
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
