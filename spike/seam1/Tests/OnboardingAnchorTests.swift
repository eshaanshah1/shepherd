import XCTest
import SwiftUI
@testable import Shepherd

/// The anchor modifier gates its published VALUE, never its view tree — an `if` in a
/// `ViewModifier` body remounts the wrapped subtree, which for `SplitContainer` meant a
/// new PTY (and a dead agent) on every workspace switch. These pin the value semantics
/// the non-structural form has to preserve; the remount itself is only observable in a
/// live run.
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
