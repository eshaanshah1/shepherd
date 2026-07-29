import SwiftUI

/// How the spotlight traces a given element. A sidebar row wants its own 6pt radius and a
/// little breathing room; a panel edge wants none, or the ring floats off the boundary it
/// is supposed to be drawing.
enum OnboardingSpotShape: Equatable {
    case row        // a sidebar row / tab row
    case pill       // a pip or dot
    case panel      // a full-height region: the terminal, the workbench rail
    case card       // a floating card that already has its own corners

    var cornerRadius: CGFloat {
        switch self {
        case .row:   return 7
        case .pill:  return 20
        case .panel: return 3
        case .card:  return 14
        }
    }

    /// Positive values grow the hole. A panel is traced tight so the ring lands on its
    /// real edge rather than hovering outside it.
    var pad: CGSize {
        switch self {
        case .row:   return CGSize(width: 4, height: 3)
        case .pill:  return CGSize(width: 6, height: 5)
        case .panel: return CGSize(width: -1, height: -1)
        case .card:  return CGSize(width: 4, height: 4)
        }
    }
}

struct OnboardingSpot: Equatable {
    var rect: CGRect
    var shape: OnboardingSpotShape

    /// The hole actually drawn, and hit-tested.
    var highlight: CGRect {
        rect.insetBy(dx: -shape.pad.width, dy: -shape.pad.height)
    }

    func path() -> Path {
        Path(roundedRect: highlight, cornerRadius: shape.cornerRadius, style: .continuous)
    }
}

/// Real UI elements publish their bounds so a coach-mark card can point an arrow at them.
///
/// A plain `CGRect` in the **named** `OnboardingAnchorKey.space`, not an `Anchor<CGRect>`
/// and not `.global`. Two bugs came out of the alternatives, in order:
///
///   * `Anchor<CGRect>` resolved to a pre-layout frame for rows inside the sidebar's
///     `LazyVStack`, landing the arrow on the previous sibling.
///   * `.global` does not resolve to the same origin for a deep publisher and for the
///     overlay reading it — the sidebar's 28pt traffic-light strip came out as a constant
///     one-row upward shift, so every highlight sat on the row above its target.
///
/// A named space declared above both ends removes the question. `FolderRegionsKey` next
/// door has always done this for drag-reorder, which is why it was never wrong.
struct OnboardingAnchorKey: PreferenceKey {
    /// Declared by `ContentView` above both the publishers and the overlay that reads them.
    static let space = "onboarding"

    static var defaultValue: [OnboardingAnchor: OnboardingSpot] = [:]
    static func reduce(value: inout [OnboardingAnchor: OnboardingSpot],
                       nextValue: () -> [OnboardingAnchor: OnboardingSpot]) {
        value.merge(nextValue(), uniquingKeysWith: { _, b in b })
    }
}

extension View {
    func onboardingAnchor(_ a: OnboardingAnchor, shape: OnboardingSpotShape = .row) -> some View {
        background(GeometryReader { g in
            Color.clear.preference(key: OnboardingAnchorKey.self,
                                   value: [a: OnboardingSpot(rect: g.frame(in: .named(OnboardingAnchorKey.space)),
                                                             shape: shape)])
        })
    }

    /// Each anchor is a single slot, so only the demo workspace's rows may claim one —
    /// otherwise the last folder drawn wins and the arrow points at a stranger's tab.
    func onboardingAnchor(_ a: OnboardingAnchor,
                          shape: OnboardingSpotShape = .row,
                          if active: Bool) -> some View {
        modifier(OnboardingAnchorIf(anchor: a, shape: shape, active: active))
    }
}

struct OnboardingAnchorIf: ViewModifier {
    let anchor: OnboardingAnchor
    let shape: OnboardingSpotShape
    let active: Bool
    func body(content: Content) -> some View {
        if active { content.onboardingAnchor(anchor, shape: shape) } else { content }
    }
}
