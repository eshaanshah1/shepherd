import XCTest
import SwiftUI
import AppKit
@testable import Shepherd

/// The anchor modifier gates its published VALUE, never its view tree — an `if` in a
/// `ViewModifier` body remounts the wrapped subtree, which for `SplitContainer` meant a
/// new PTY (and a dead agent) on every tab or workspace switch. Most of these pin the
/// value semantics the non-structural form has to preserve; the last one pins the
/// remount, by hosting the modifier for real and counting the views it creates.
final class OnboardingAnchorTests: XCTestCase {
    private let rect = CGRect(x: 10, y: 20, width: 300, height: 400)

    // Happy path: an active publisher claims its slot, with its rect and shape intact.
    func testActivePublishesTheSpot() {
        let v = OnboardingAnchorKey.published(.terminalArea, shape: .panel, rect: rect, active: true)
        XCTAssertEqual(v.count, 1)
        XCTAssertEqual(v[.terminalArea]?.rect, rect)
        XCTAssertEqual(v[.terminalArea]?.shape, .panel)
    }

    // Empty state: inactive contributes nothing, which is what makes gating the value
    // equivalent to the old "don't publish at all" branch.
    func testInactivePublishesNothing() {
        XCTAssertTrue(OnboardingAnchorKey.published(.terminalArea, shape: .panel,
                                                    rect: rect, active: false).isEmpty)
    }

    // The empty dictionary has to merge away rather than clear a sibling's claim: every
    // mounted tab now publishes on every layout pass, and only one of them is active.
    func testInactiveSiblingCannotEraseAnActiveClaim() {
        var value = OnboardingAnchorKey.defaultValue
        OnboardingAnchorKey.reduce(value: &value) {
            OnboardingAnchorKey.published(.terminalArea, shape: .panel, rect: self.rect, active: true)
        }
        OnboardingAnchorKey.reduce(value: &value) {
            OnboardingAnchorKey.published(.terminalArea, shape: .panel, rect: .zero, active: false)
        }
        XCTAssertEqual(value[.terminalArea]?.rect, rect)
    }

    // The regression itself: flipping the flag must not re-create the view being wrapped.
    // A second `makeNSView` in the real app is a second `ghostty_surface_t` — a new PTY,
    // with the old shell and its agent hung up. This is the only assertion here that
    // fails against the `if active { content… } else { content }` form.
    func testFlippingActiveDoesNotRemountTheWrappedView() {
        MakeCounter.makes = 0
        let flag = AnchorFlag()
        let host = NSHostingView(rootView: AnchorProbeHost(flag: flag))
        host.frame = NSRect(x: 0, y: 0, width: 120, height: 120)
        // Parked far offscreen and never ordered front: a real layout pass, no window.
        let window = NSWindow(contentRect: NSRect(x: -10_000, y: -10_000, width: 120, height: 120),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = host
        window.orderBack(nil)
        settle(host)
        XCTAssertEqual(MakeCounter.makes, 1, "the wrapped view should be created once")

        flag.active = false          // the flip a tab or workspace switch performs
        settle(host)
        flag.active = true           // ...and switching back
        settle(host)
        XCTAssertEqual(MakeCounter.makes, 1, "the flag flipped, so the view was remounted")
    }

    /// Let SwiftUI observe the change and lay out again.
    private func settle(_ host: NSView) {
        host.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.2))
    }

    // Two active publishers of the same anchor still resolve last-wins, unchanged.
    func testLastActiveClaimWins() {
        var value = OnboardingAnchorKey.defaultValue
        let second = CGRect(x: 1, y: 2, width: 3, height: 4)
        OnboardingAnchorKey.reduce(value: &value) {
            OnboardingAnchorKey.published(.terminalArea, shape: .panel, rect: self.rect, active: true)
        }
        OnboardingAnchorKey.reduce(value: &value) {
            OnboardingAnchorKey.published(.terminalArea, shape: .panel, rect: second, active: true)
        }
        XCTAssertEqual(value[.terminalArea]?.rect, second)
    }
}

/// Stands in for `GhosttyTerminal`: the count is how many surfaces the real thing would
/// have created.
private final class MakeCounter { static var makes = 0 }

private struct CountingProbe: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { MakeCounter.makes += 1; return NSView() }
    func updateNSView(_ v: NSView, context: Context) {}
}

private final class AnchorFlag: ObservableObject { @Published var active = true }

/// `SplitContainer`'s shape: the anchor wraps the surface and is gated on selection.
/// The modifier is named rather than reached through its `View` extension because the
/// test target compiles these sources *and* `@testable import`s the app module, so the
/// unqualified call is ambiguous between two identical copies.
private struct AnchorProbeHost: View {
    @ObservedObject var flag: AnchorFlag
    var body: some View {
        CountingProbe()
            .modifier(ShepherdModelTests.OnboardingAnchorIf(
                anchor: .terminalArea, shape: .panel, active: flag.active))
            .frame(width: 120, height: 120)
    }
}
