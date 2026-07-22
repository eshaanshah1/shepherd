import SwiftUI

/// In-window layer for ephemeral (workspace-less) panes. Each pane's libghostty
/// surface is mounted once and kept mounted (live PTY survives collapse/expand);
/// its container animates between the centered overlay and a bottom-right PiP.
struct EphemeralOverlayView: View {
    @EnvironmentObject var store: AgentStore

    private let pipTargetWidth: CGFloat = 260   // PiP width; height follows the overlay's aspect
    private let pipGap: CGFloat = 12
    private let titleBarHeight: CGFloat = 30     // must match titleBar's .frame(height:)

    var body: some View {
        GeometryReader { geo in
            ZStack {
                // Dim backdrop behind the overlay — tap to collapse it to PiP.
                if let id = store.expandedEphemeralID {
                    Color.black.opacity(0.45)
                        .ignoresSafeArea()
                        .contentShape(Rectangle())
                        .onTapGesture { store.collapseEphemeral(id) }
                        .transition(.opacity)
                }

                // One mounted surface per ephemeral pane; frame/position depends on state.
                ForEach(store.ephemeralPanes, id: \.id) { e in
                    paneContainer(e, in: geo.size)
                }
            }
            .background(escHandler)
        }
        .animation(.easeOut(duration: 0.18), value: store.expandedEphemeralID)
        .animation(.easeOut(duration: 0.18), value: store.ephemeralPanes.map(\.id))
    }

    @ViewBuilder
    private func paneContainer(_ e: EphemeralPane, in size: CGSize) -> some View {
        let isOverlay = !e.collapsed
        // The card is ALWAYS laid out at the full overlay size, so the terminal keeps its
        // full grid (no reflow). A PiP is that same card shrunk by a layer transform —
        // a true scaled-down thumbnail, not a tiny few-column terminal.
        let full = overlayFrame(in: size)
        let scale = isOverlay ? 1 : (pipTargetWidth / full.width)
        let footprint = CGSize(width: full.width * scale, height: full.height * scale)
        let center = isOverlay
            ? CGPoint(x: full.midX, y: full.midY)
            : pipCenter(for: e, in: size, footprint: footprint)
        let corner: CGFloat = isOverlay ? 12 : 8

        card(e, isOverlay: isOverlay, size: CGSize(width: full.width, height: full.height))
            // Flatten the card (chrome + Metal terminal) into one composited layer BEFORE
            // scaling, so the terminal's CAMetalLayer scales with the card instead of
            // compositing at its own unscaled size.
            .compositingGroup()
            .scaleEffect(scale, anchor: .topLeading)
            .frame(width: footprint.width, height: footprint.height, alignment: .topLeading)
            .clipShape(RoundedRectangle(cornerRadius: corner, style: .continuous))
            // PiP edges blend into the terminal, so give a collapsed card a stronger,
            // theme-aware border than the overlay's hairline.
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(isOverlay ? Theme.hairline : Theme.textSecondary.opacity(0.55),
                              lineWidth: isOverlay ? 1 : 1.5))
            .shadow(color: .black.opacity(isOverlay ? 0.4 : 0.25),
                    radius: isOverlay ? 30 : 10, y: isOverlay ? 16 : 6)
            // Collapsed: a real-NSView catcher (at true PiP size, unscaled) so the expand
            // tap wins AppKit hit-testing over the live terminal beneath it.
            .overlay { if !isOverlay { MouseCatcher { store.expandEphemeral(e.id) } } }
            .position(x: center.x, y: center.y)
            .modifier(FlashOnBump(trigger: store.ephemeralCapFlash, active: e.collapsed))
    }

    private func card(_ e: EphemeralPane, isOverlay: Bool, size: CGSize) -> some View {
        // The surface needs an EXPLICIT frame — a plain maxWidth/maxHeight .infinity lets
        // the ghostty view fall back to a small intrinsic size (SplitContainer sizes it via
        // an explicit-frame layout for the same reason).
        VStack(spacing: 0) {
            titleBar(e, showButtons: isOverlay)
            terminal(e, isOverlay: isOverlay)
                .frame(width: size.width, height: max(0, size.height - titleBarHeight))
        }
        .frame(width: size.width, height: size.height)
        .background(Theme.ground)
    }

    private func titleBar(_ e: EphemeralPane, showButtons: Bool) -> some View {
        HStack(spacing: 8) {
            Circle().fill(e.pane.state.color).frame(width: 7, height: 7)
            Text(e.pane.displayTitle)
                .font(.ui(12.5))
                .foregroundColor(Theme.textPrimary)
                .lineLimit(1)
            Spacer(minLength: 0)
            if showButtons {
                iconButton("minus") { store.collapseEphemeral(e.id) }
                iconButton("xmark") { store.closeEphemeral(e.id) }
            }
        }
        .padding(.horizontal, 10)
        .frame(height: 30)
        .background(Theme.surface1)
    }

    private func iconButton(_ system: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: system).font(.system(size: 10, weight: .semibold))
                .foregroundColor(Theme.textSecondary)
        }
        .buttonStyle(.plain)
        .focusable(false)
    }

    @ViewBuilder
    private func terminal(_ e: EphemeralPane, isOverlay: Bool) -> some View {
        GhosttyTerminal(paneID: e.pane.paneID,
                        isVisible: true,                    // always render (live PiP preview)
                        isSelected: isOverlay,              // overlay grabs first responder
                        focusTick: store.focusTick,
                        hittableOverride: isOverlay)        // overlay types; PiP is expand-only
    }

    // MARK: Layout

    private func overlayFrame(in size: CGSize) -> CGRect {
        let w = min(900, size.width * 0.65)
        let h = min(620, size.height * 0.7)
        return CGRect(x: (size.width - w) / 2, y: (size.height - h) / 2, width: w, height: h)
    }

    /// Center for a PiP in the top-right stack (first at the top, growing down). All PiPs
    /// share the same footprint (same scale), so the stack spacing is uniform.
    private func pipCenter(for e: EphemeralPane, in size: CGSize, footprint: CGSize) -> CGPoint {
        let collapsed = store.ephemeralPanes.filter { $0.collapsed }
        let idx = collapsed.firstIndex { $0.id == e.id } ?? 0
        let x = size.width - footprint.width / 2 - pipGap
        let y = footprint.height / 2 + pipGap + CGFloat(idx) * (footprint.height + pipGap)
        return CGPoint(x: x, y: y)
    }

    private var escHandler: some View {
        Button("") { if let id = store.expandedEphemeralID { store.collapseEphemeral(id) } }
            .keyboardShortcut(.cancelAction)
            .opacity(0).frame(width: 0, height: 0).focusable(false)
    }
}

/// A transparent real NSView that captures a click. Used over a PiP card so the
/// expand tap beats the live terminal NSView beneath it in AppKit hit-testing —
/// a SwiftUI `.onTapGesture` there loses to the raw surface.
private struct MouseCatcher: NSViewRepresentable {
    let onClick: () -> Void
    func makeNSView(context: Context) -> NSView { CatcherView(onClick: onClick) }
    func updateNSView(_ v: NSView, context: Context) { (v as? CatcherView)?.onClick = onClick }

    final class CatcherView: NSView {
        var onClick: () -> Void
        init(onClick: @escaping () -> Void) { self.onClick = onClick; super.init(frame: .zero) }
        required init?(coder: NSCoder) { fatalError() }
        override func mouseDown(with event: NSEvent) { onClick() }
    }
}

/// Briefly flashes a card's border when the summon cap is hit.
private struct FlashOnBump: ViewModifier {
    let trigger: Int
    let active: Bool
    @State private var on = false
    func body(content: Content) -> some View {
        content
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(Theme.blocked.opacity(on ? 0.9 : 0), lineWidth: 2))
            .onChange(of: trigger) { _ in
                guard active else { return }
                withAnimation(.easeIn(duration: 0.1)) { on = true }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                    withAnimation(.easeOut(duration: 0.2)) { on = false }
                }
            }
    }
}
