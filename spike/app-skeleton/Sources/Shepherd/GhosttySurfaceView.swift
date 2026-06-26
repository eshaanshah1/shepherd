import SwiftUI
import AppKit

/// STUB. The real implementation wraps a libghostty surface (a Metal-backed NSView)
/// here. See SEAM1.md for how to obtain GhosttyKit.xcframework and crib Ghostty's
/// `SurfaceView`. Until then this renders a placeholder so the chrome lays out.
struct GhosttySurfaceView: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let v = NSView()
        v.wantsLayer = true
        v.layer?.backgroundColor = NSColor.black.cgColor
        // TODO(seam 1): create ghostty_surface_t, attach its CAMetalLayer here,
        //               forward key/mouse events, and set SHEPHERD_TAB_ID +
        //               SHEPHERD_SOCK in the spawned shell's PTY environment.
        return v
    }

    func updateNSView(_ nsView: NSView, context: Context) {}
}
