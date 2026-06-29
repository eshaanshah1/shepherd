import SwiftUI
import AppKit

/// Hides the window's traffic-light buttons and reveals them only while the
/// cursor is in the top-left corner (macOS-fullscreen behaviour), so they stop
/// crowding the sidebar header at rest.
///
/// The hover zone is a transparent, click-through view inserted into the
/// titlebar *alongside* the buttons — so moving the cursor from the zone onto a
/// button stays inside the tracking rect and never triggers a hide/show flicker.
struct WindowLightsController: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let probe = ProbeView()
        probe.onWindow = { [coordinator = context.coordinator] window in
            coordinator.attach(to: window)
        }
        return probe
    }

    func updateNSView(_ nsView: NSView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    /// Zero-size view whose only job is to hand its window to the coordinator
    /// once it's attached.
    final class ProbeView: NSView {
        var onWindow: ((NSWindow) -> Void)?
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let window { onWindow?(window) }
        }
    }

    final class Coordinator {
        private weak var window: NSWindow?
        private var attached = false
        private var revealed = false

        func attach(to window: NSWindow) {
            guard !attached else { return }
            self.window = window
            attached = true

            for button in buttons() { button.alphaValue = 0; button.isHidden = true }
            installRevealZone()
        }

        private func buttons() -> [NSButton] {
            [.closeButton, .miniaturizeButton, .zoomButton]
                .compactMap { window?.standardWindowButton($0) }
        }

        private func installRevealZone() {
            guard let container = buttons().first?.superview else { return }
            let zone = RevealZone(
                onEnter: { [weak self] in self?.setRevealed(true) },
                onExit: { [weak self] in self?.setRevealed(false) }
            )
            zone.frame = NSRect(x: 0, y: 0, width: 84, height: container.bounds.height)
            zone.autoresizingMask = [.maxXMargin, .height]
            container.addSubview(zone, positioned: .below, relativeTo: nil)
        }

        private func setRevealed(_ reveal: Bool) {
            guard reveal != revealed else { return }
            revealed = reveal
            let targets = buttons()

            if reveal {
                for b in targets { b.isHidden = false }
                NSAnimationContext.runAnimationGroup { ctx in
                    ctx.duration = 0.15
                    for b in targets { b.animator().alphaValue = 1 }
                }
            } else {
                NSAnimationContext.runAnimationGroup({ ctx in
                    ctx.duration = 0.15
                    for b in targets { b.animator().alphaValue = 0 }
                }, completionHandler: { [weak self] in
                    guard let self, !self.revealed else { return }   // re-entered mid-fade
                    for b in self.buttons() { b.isHidden = true }
                })
            }
        }
    }

    /// Transparent hover sensor. Click-through (`hitTest` → nil) so the buttons
    /// underneath still take clicks; the tracking area fires on geometry alone.
    final class RevealZone: NSView {
        private let onEnter: () -> Void
        private let onExit: () -> Void

        init(onEnter: @escaping () -> Void, onExit: @escaping () -> Void) {
            self.onEnter = onEnter
            self.onExit = onExit
            super.init(frame: .zero)
        }
        required init?(coder: NSCoder) { fatalError() }

        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            trackingAreas.forEach(removeTrackingArea)
            addTrackingArea(NSTrackingArea(
                rect: .zero,
                options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                owner: self
            ))
        }

        override func mouseEntered(with event: NSEvent) { onEnter() }
        override func mouseExited(with event: NSEvent) { onExit() }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
}
