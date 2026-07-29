import XCTest
@testable import Shepherd

final class OnboardingPlacementTests: XCTestCase {

    private let container = CGSize(width: 1400, height: 900)
    private let card = CGSize(width: 340, height: 200)

    private func rect(_ x: CGFloat, _ y: CGFloat) -> CGRect {
        CGRect(x: x, y: y, width: 12, height: 12)
    }

    func testCenteredWhenThereIsNoAnchor() {
        let p = OnboardingPlacement.place(anchor: nil, card: card, container: container)
        XCTAssertNil(p.arrowFrom)
        XCTAssertEqual(p.origin.x, (1400 - 340) / 2, accuracy: 0.5)
        XCTAssertEqual(p.origin.y, (900 - 200) / 2, accuracy: 0.5)
    }

    // The real failure mode: an anchor near an edge pushing the card off screen.
    func testCardStaysFullyInsideForAnchorsAllOverTheContainer() {
        let xs: [CGFloat] = [0, 8, 200, 700, 1200, 1392, 1400]
        let ys: [CGFloat] = [0, 8, 200, 450, 700, 892, 900]
        for x in xs {
            for y in ys {
                let p = OnboardingPlacement.place(anchor: rect(x, y), card: card, container: container)
                XCTAssertGreaterThanOrEqual(p.origin.x, 0, "anchor \(x),\(y) pushed the card off the left")
                XCTAssertGreaterThanOrEqual(p.origin.y, 0, "anchor \(x),\(y) pushed the card off the top")
                XCTAssertLessThanOrEqual(p.origin.x + card.width, container.width,
                                         "anchor \(x),\(y) pushed the card off the right")
                XCTAssertLessThanOrEqual(p.origin.y + card.height, container.height,
                                         "anchor \(x),\(y) pushed the card off the bottom")
            }
        }
    }

    // A sidebar anchor has room on its right, so the card goes right and the arrow
    // leaves from the card's leading edge.
    func testAnchorOnTheLeftPutsTheCardRightWithALeadingArrow() {
        let p = OnboardingPlacement.place(anchor: rect(120, 300), card: card, container: container)
        XCTAssertEqual(p.arrowFrom, .leading)
        XCTAssertGreaterThan(p.origin.x, 120)
    }

    func testAnchorOnTheRightPutsTheCardLeftWithATrailingArrow() {
        let p = OnboardingPlacement.place(anchor: rect(1340, 300), card: card, container: container)
        XCTAssertEqual(p.arrowFrom, .trailing)
        XCTAssertLessThan(p.origin.x + card.width, 1340)
    }

    // Narrow container: neither side fits, so it must fall back to below/above.
    func testFallsBackToVerticalWhenNeitherSideFits() {
        let narrow = CGSize(width: 380, height: 900)
        let p = OnboardingPlacement.place(anchor: rect(190, 120), card: card, container: narrow)
        XCTAssertEqual(p.arrowFrom, .top)
        XCTAssertGreaterThan(p.origin.y, 120)
        XCTAssertGreaterThanOrEqual(p.origin.x, 0)
        XCTAssertLessThanOrEqual(p.origin.x + card.width, narrow.width)
    }

    func testFallsBackToAboveWhenBelowIsAlsoTooTight() {
        let narrow = CGSize(width: 380, height: 900)
        let p = OnboardingPlacement.place(anchor: rect(190, 820), card: card, container: narrow)
        XCTAssertEqual(p.arrowFrom, .bottom)
        XCTAssertLessThan(p.origin.y + card.height, 820)
    }

    // A card larger than its container can't satisfy anything; it must still be
    // deterministic rather than producing a negative origin.
    func testCardBiggerThanContainerClampsToTheOrigin() {
        let p = OnboardingPlacement.place(anchor: rect(10, 10),
                                          card: CGSize(width: 900, height: 900),
                                          container: CGSize(width: 400, height: 400))
        XCTAssertEqual(p.origin.x, 0, accuracy: 0.5)
        XCTAssertEqual(p.origin.y, 0, accuracy: 0.5)
    }
}
