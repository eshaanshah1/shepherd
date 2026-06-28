import SwiftUI
import AppKit

/// Installs a local scroll-wheel monitor that converts a horizontal-dominant
/// trackpad swipe (while the sidebar is hovered) into a ±1 workspace step. Vertical
/// scrolls pass through untouched so the tab list still scrolls. Invisible — host it
/// in the sidebar's `.background`.
struct SidebarSwipe: NSViewRepresentable {
    var hovering: Bool
    var onSwipe: (Int) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSView {
        context.coordinator.onSwipe = onSwipe
        context.coordinator.install()
        return NSView(frame: .zero)
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        context.coordinator.hovering = hovering
        context.coordinator.onSwipe = onSwipe
    }

    static func dismantleNSView(_ nsView: NSView, coordinator: Coordinator) {
        coordinator.remove()
    }

    final class Coordinator {
        var hovering = false
        var onSwipe: (Int) -> Void = { _ in }
        private var monitor: Any?
        private var accumX: CGFloat = 0
        private var armed = true

        func install() {
            monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] e in
                guard let self, self.hovering else { return e }
                if e.phase == .began { self.accumX = 0; self.armed = true }
                let dx = e.scrollingDeltaX, dy = e.scrollingDeltaY
                if abs(dx) > abs(dy) * 1.5 {                       // horizontal-dominant → workspace swipe
                    self.accumX += dx
                    if self.armed, abs(self.accumX) > 50 {
                        let dir = self.accumX < 0 ? 1 : -1        // swipe left → next workspace
                        let cb = self.onSwipe
                        DispatchQueue.main.async { cb(dir) }
                        self.armed = false                        // one switch per gesture
                    }
                    return nil                                    // consume horizontal swipe
                }
                if e.phase == .ended || e.phase == .cancelled { self.accumX = 0; self.armed = true }
                return e                                          // let vertical scroll reach the list
            }
        }

        func remove() { if let m = monitor { NSEvent.removeMonitor(m); monitor = nil } }
    }
}
