import XCTest
import SwiftUI
@testable import Shepherd

/// A conditional that WRAPS a live surface tears it down: `if x { c.mod() } else { c }` is a
/// `_ConditionalContent`, so flipping x rebuilds the subtree — a new `ghostty_surface_t`, a
/// new PTY, and the old shell's `claude` hangs up. It shipped once via
/// `.onboardingAnchor(…, if:)` and was invisible, because a remounted plain shell looks
/// exactly like the original.
///
/// `PaneChrome` therefore keeps the content in ONE structural position and lets the bar's
/// own view decide whether it draws anything.
final class PaneChromeTests: XCTestCase {

    /// Counts how many backing views SwiftUI creates for it.
    private struct CountingRep: NSViewRepresentable {
        final class Box { var made = 0 }
        let box: Box
        func makeNSView(context: Context) -> NSView { box.made += 1; return NSView() }
        func updateNSView(_ view: NSView, context: Context) {}
    }

    private func flush() {
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    }

    func testTogglingTheBarDoesNotRemountTheContent() {
        let box = CountingRep.Box()

        func tree(showBar: Bool) -> AnyView {
            AnyView(
                PaneChrome {
                    if showBar { Color.red.frame(height: 26) }
                } content: {
                    CountingRep(box: box)
                }
                .frame(width: 400, height: 300)
            )
        }

        let host = NSHostingView(rootView: tree(showBar: false))
        host.frame = CGRect(x: 0, y: 0, width: 400, height: 300)
        let window = NSWindow(contentRect: host.frame, styleMask: [.titled],
                              backing: .buffered, defer: false)
        window.contentView = host
        flush()
        XCTAssertEqual(box.made, 1, "the surface should mount exactly once")

        host.rootView = tree(showBar: true)
        flush()
        XCTAssertEqual(box.made, 1, "showing the bar must not rebuild the surface")

        host.rootView = tree(showBar: false)
        flush()
        XCTAssertEqual(box.made, 1, "hiding the bar must not rebuild the surface either")
    }

    /// The control: the shape `PaneChrome` exists to avoid. If this does NOT remount, the
    /// test above proves nothing and the guard needs rethinking.
    func testConditionalWrappingDoesRemount() {
        let box = CountingRep.Box()

        func bad(showBar: Bool) -> AnyView {
            let content = CountingRep(box: box)
            return AnyView(
                Group {
                    if showBar {
                        VStack(spacing: 0) { Color.red.frame(height: 26); content }
                    } else {
                        content
                    }
                }
                .frame(width: 400, height: 300)
            )
        }

        let host = NSHostingView(rootView: bad(showBar: false))
        host.frame = CGRect(x: 0, y: 0, width: 400, height: 300)
        let window = NSWindow(contentRect: host.frame, styleMask: [.titled],
                              backing: .buffered, defer: false)
        window.contentView = host
        flush()
        XCTAssertEqual(box.made, 1)

        host.rootView = bad(showBar: true)
        flush()
        XCTAssertGreaterThan(box.made, 1,
                             "a _ConditionalContent around the content SHOULD remount it — "
                             + "if it doesn't, PaneChrome is guarding against nothing")
    }
}
