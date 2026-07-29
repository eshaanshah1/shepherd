import CoreGraphics

/// The card edge an arrow leaves from, pointing back at the anchor.
enum ArrowEdge: Equatable { case leading, trailing, top, bottom }

struct CardPlacement: Equatable {
    var origin: CGPoint
    var arrowFrom: ArrowEdge?
}

/// Where a coach-mark card sits relative to the element it describes. Tries the four
/// sides in order of how much room each has, then clamps so the card is always fully
/// on screen — an anchor in a corner must not push the card out of the window.
enum OnboardingPlacement {

    static func place(anchor: CGRect?,
                      card: CGSize,
                      container: CGSize,
                      gap: CGFloat = 18,
                      margin: CGFloat = 16) -> CardPlacement {

        guard let a = anchor else {
            return CardPlacement(origin: centered(card, in: container), arrowFrom: nil)
        }

        let roomRight = container.width  - a.maxX - gap - margin
        let roomLeft  = a.minX - gap - margin
        let roomBelow = container.height - a.maxY - gap - margin
        let roomAbove = a.minY - gap - margin

        var origin: CGPoint
        var edge: ArrowEdge

        if roomRight >= card.width {
            (origin, edge) = beside(a, card, .leading, gap)
        } else if roomLeft >= card.width {
            (origin, edge) = beside(a, card, .trailing, gap)
        } else if roomBelow >= card.height {
            (origin, edge) = beside(a, card, .top, gap)
        } else if roomAbove >= card.height {
            (origin, edge) = beside(a, card, .bottom, gap)
        } else {
            // Nothing fits beside the anchor — take the roomiest side and let the
            // clamp below decide, so the card is still readable and on screen.
            let best = max(roomRight, roomLeft, roomBelow, roomAbove)
            if best == roomRight       { (origin, edge) = beside(a, card, .leading, gap) }
            else if best == roomLeft   { (origin, edge) = beside(a, card, .trailing, gap) }
            else if best == roomBelow  { (origin, edge) = beside(a, card, .top, gap) }
            else                       { (origin, edge) = beside(a, card, .bottom, gap) }
        }

        origin.x = clamp(origin.x, card.width, container.width, margin)
        origin.y = clamp(origin.y, card.height, container.height, margin)
        return CardPlacement(origin: origin, arrowFrom: edge)
    }

    /// `edge` is the card edge that will face the anchor, which is the opposite side
    /// of the anchor from where the card lands.
    private static func beside(_ a: CGRect, _ card: CGSize,
                               _ edge: ArrowEdge, _ gap: CGFloat) -> (CGPoint, ArrowEdge) {
        switch edge {
        case .leading:
            return (CGPoint(x: a.maxX + gap, y: a.midY - card.height / 2), .leading)
        case .trailing:
            return (CGPoint(x: a.minX - gap - card.width, y: a.midY - card.height / 2), .trailing)
        case .top:
            return (CGPoint(x: a.midX - card.width / 2, y: a.maxY + gap), .top)
        case .bottom:
            return (CGPoint(x: a.midX - card.width / 2, y: a.minY - gap - card.height), .bottom)
        }
    }

    private static func centered(_ card: CGSize, in container: CGSize) -> CGPoint {
        CGPoint(x: max(0, (container.width - card.width) / 2),
                y: max(0, (container.height - card.height) / 2))
    }

    private static func clamp(_ v: CGFloat, _ size: CGFloat,
                              _ containerSize: CGFloat, _ margin: CGFloat) -> CGFloat {
        // A card wider than its container has no valid range; pin it at 0 rather
        // than letting max() hand back a negative origin.
        guard size + 2 * margin <= containerSize else { return 0 }
        return min(max(v, margin), containerSize - size - margin)
    }
}
