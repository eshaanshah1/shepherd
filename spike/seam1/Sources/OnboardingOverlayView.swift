import SwiftUI

/// The tour's chrome: a dimmed backdrop with a spotlight cut out of it, one card, and an
/// elbow arrow from the card to the element.
///
/// The cutout is visual only — the dim layer eats every click, so the user cannot walk
/// the tour out from under itself into a state the script does not expect. The card's own
/// controls are the only interaction.
/// The anchor rect is resolved by `ContentView`, not here: preferences propagate up from
/// a view's own children, so a reader attached to this overlay would only ever see the
/// overlay's subtree — never the sidebar, terminal or workbench that publish the anchors.
struct OnboardingOverlayView: View {
    @EnvironmentObject var onboarding: OnboardingController

    let step: OnboardingStep
    /// nil = no anchor for this step (or the view that owns it isn't on screen): the card
    /// centres itself and draws no arrow.
    let spot: OnboardingSpot?
    let container: CGSize

    private let cardWidth: CGFloat = 380

    var body: some View {
        // NO .ignoresSafeArea() here. Anchors are measured in the reader's frame, and
        // ignoring the safe area shifts this view's own frame ~32pt up relative to it —
        // which drew every highlight a title-bar height too high. The dim still reaches
        // the window edges because `backdrop` inflates the rect it fills.
        content(step: step, spot: spot, container: container)
    }

    private func content(step: OnboardingStep, spot: OnboardingSpot?, container: CGSize) -> some View {
        let card = CGSize(width: cardWidth, height: estimatedHeight(step))
        let hole = spot?.highlight
        let place = OnboardingPlacement.place(anchor: hole, card: card, container: container)

        return ZStack(alignment: .topLeading) {
            backdrop(spot: spot)
            clickShield(spot: spot, container: container)

            if let hole, let edge = place.arrowFrom {
                ArrowShape(from: cardEdgePoint(place.origin, card, edge),
                           to: anchorEdgePoint(hole, edge))
                    .stroke(Theme.accent.opacity(0.85),
                            style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                    .allowsHitTesting(false)
            }

            cardView(step: step)
                .frame(width: cardWidth)
                .offset(x: place.origin.x, y: place.origin.y)
        }
        // The hole and the card slide when a step's target changes size (a tab row grows
        // pips when it splits); without this they teleport and read as a step change.
        .animation(.easeOut(duration: 0.22), value: spot)
    }

    /// Full-screen dim with the anchor punched out, so the element being described keeps
    /// its real colours instead of reading through the scrim.
    private func backdrop(spot: OnboardingSpot?) -> some View {
        Canvas { ctx, size in
            // Inflated so the scrim still bleeds past the window edges without moving
            // this view's coordinate origin.
            var p = Path(CGRect(origin: .zero, size: size).insetBy(dx: -80, dy: -80))
            if let spot { p.addPath(spot.path()) }
            ctx.fill(p, with: .color(.black.opacity(0.62)), style: FillStyle(eoFill: true))

            // A ring on the hole, traced with the element's own corner radius: without it
            // the spotlight reads as an accident of the layout rather than the thing being
            // pointed at, and a generic radius floats off a panel's real edge.
            if let spot {
                ctx.stroke(spot.path(), with: .color(Theme.accent.opacity(0.7)), lineWidth: 1.5)
            }
        }
        .allowsHitTesting(false)
    }

    /// Clicks are swallowed everywhere *except* over the spotlight, so a card that says
    /// "try typing in it" is telling the truth while the rest of the app stays off-limits.
    /// Four bands around the hole rather than one shape, because `contentShape` has no
    /// even-odd fill.
    private func clickShield(spot: OnboardingSpot?, container: CGSize) -> some View {
        let hole = spot?.highlight ?? .zero
        return ZStack(alignment: .topLeading) {
            if spot == nil {
                band(CGRect(origin: .zero, size: container))
            } else {
                band(CGRect(x: 0, y: 0, width: container.width, height: max(0, hole.minY)))
                band(CGRect(x: 0, y: hole.maxY,
                            width: container.width, height: max(0, container.height - hole.maxY)))
                band(CGRect(x: 0, y: hole.minY, width: max(0, hole.minX), height: hole.height))
                band(CGRect(x: hole.maxX, y: hole.minY,
                            width: max(0, container.width - hole.maxX), height: hole.height))
            }
        }
    }

    private func band(_ r: CGRect) -> some View {
        Color.clear
            .contentShape(Rectangle())
            .frame(width: r.width, height: r.height)
            .offset(x: r.minX, y: r.minY)
            .onTapGesture { }   // swallow — Skip is an explicit button, never a stray click
    }

    private func cardView(step: OnboardingStep) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(step.title)
                .font(.ui(14, .semibold))
                .foregroundColor(Theme.textPrimary)

            Text(step.body)
                .font(.ui(12))
                .foregroundColor(Theme.textDim)
                .lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)

            if step.id == "welcome" {
                OnboardingWelcomeView().environmentObject(onboarding)
            }
            if step.id == "agentLegend" {
                stateLegend
            }
            if !step.instruction.isEmpty {
                instructionRow(step)
            }

            HStack(spacing: 12) {
                Text("\(onboarding.stepNumber) / \(onboarding.stepCount)")
                    .font(.ui(11))
                    .foregroundColor(Theme.textDim)
                Spacer()
                Button("Skip tour") { onboarding.skip() }
                    .buttonStyle(.plain)
                    .font(.ui(11))
                    .foregroundColor(Theme.textDim)
                    .focusable(false)
                if !done && !step.instruction.isEmpty {
                    Button("Skip step") { onboarding.advance() }
                        .buttonStyle(.plain)
                        .font(.ui(11))
                        .foregroundColor(Theme.textDim)
                        .focusable(false)
                }
                // No key equivalent on purpose: Return would advance the card the moment
                // someone typed `claude` and hit return in the pane behind it.
                Button(onboarding.isLastStep ? "Finish" : "Next") { onboarding.advance() }
                    .disabled(!done)
                    .focusable(false)
            }
        }
        .padding(20)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Theme.surface1)
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(Theme.hairline, lineWidth: 1))
        )
        .shadow(color: .black.opacity(0.4), radius: 26, y: 12)
    }

    private var done: Bool { onboarding.satisfied }

    /// The imperative, with a tick that fills in the moment the user actually does it —
    /// the tour watches, it never presses the key itself.
    private func instructionRow(_ step: OnboardingStep) -> some View {
        HStack(spacing: 8) {
            Image(systemName: done ? "checkmark.circle.fill" : "circle.dashed")
                .font(.system(size: 12))
                .foregroundColor(done ? Theme.needsCheck : Theme.accent)
            Text(step.instruction)
                .font(.ui(12, .semibold))
                .foregroundColor(done ? Theme.textDim : Theme.textPrimary)
                .strikethrough(done, color: Theme.textDim)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 10)
        .background(RoundedRectangle(cornerRadius: 7, style: .continuous)
            .fill(done ? Theme.needsCheck.opacity(0.10) : Theme.accent.opacity(0.12)))
    }

    /// Drawn from `AgentState.color` rather than its own copy of the palette, so the
    /// legend cannot drift from the dots it describes.
    private var stateLegend: some View {
        VStack(alignment: .leading, spacing: 5) {
            ForEach(AgentState.allCases, id: \.self) { s in
                HStack(spacing: 7) {
                    Circle().fill(s.color).frame(width: 6, height: 6)
                    Text(s.legendLabel)
                        .font(.ui(11))
                        .foregroundColor(Theme.textDim)
                }
            }
        }
    }

    // Placement needs a height before the card has been laid out, so approximate from
    // the copy. Over-estimating only widens the gap to the anchor.
    private func estimatedHeight(_ step: OnboardingStep) -> CGFloat {
        let lines = ceil(CGFloat(step.body.count) / 52)
        var h = 104 + lines * 17
        if step.id == "welcome" { h += 150 }
        if step.id == "agentLegend" { h += CGFloat(AgentState.allCases.count) * 16 }
        if !step.instruction.isEmpty { h += 46 }
        return h
    }

    private func cardEdgePoint(_ o: CGPoint, _ card: CGSize, _ edge: ArrowEdge) -> CGPoint {
        switch edge {
        case .leading:  return CGPoint(x: o.x, y: o.y + card.height / 2)
        case .trailing: return CGPoint(x: o.x + card.width, y: o.y + card.height / 2)
        case .top:      return CGPoint(x: o.x + card.width / 2, y: o.y)
        case .bottom:   return CGPoint(x: o.x + card.width / 2, y: o.y + card.height)
        }
    }

    private func anchorEdgePoint(_ spot: CGRect, _ edge: ArrowEdge) -> CGPoint {
        switch edge {
        case .leading:  return CGPoint(x: spot.maxX + 4, y: spot.midY)
        case .trailing: return CGPoint(x: spot.minX - 4, y: spot.midY)
        case .top:      return CGPoint(x: spot.midX, y: spot.maxY + 4)
        case .bottom:   return CGPoint(x: spot.midX, y: spot.minY - 4)
        }
    }
}

private extension AgentState {
    var legendLabel: String {
        switch self {
        case .shell:      return "shell — no agent running"
        case .working:    return "working — mid-turn"
        case .blocked:    return "blocked — waiting on you"
        case .needsCheck: return "done — finished while you were away"
        case .idle:       return "idle — between turns"
        case .error:      return "error — the turn died on an API error"
        }
    }
}

/// An elbow rather than a straight line: a diagonal across the chrome reads as a stray
/// hairline, a right-angled one reads as pointing.
private struct ArrowShape: Shape {
    let from: CGPoint
    let to: CGPoint

    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: from)
        let mid = CGPoint(x: (from.x + to.x) / 2, y: from.y)
        p.addLine(to: mid)
        p.addLine(to: CGPoint(x: mid.x, y: to.y))
        p.addLine(to: to)

        let head: CGFloat = 4
        let dx: CGFloat = to.x >= mid.x ? -1 : 1
        p.move(to: CGPoint(x: to.x + dx * head, y: to.y - head))
        p.addLine(to: to)
        p.addLine(to: CGPoint(x: to.x + dx * head, y: to.y + head))
        return p
    }
}
