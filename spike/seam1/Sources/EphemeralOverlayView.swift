import SwiftUI

/// In-window layer for ephemeral (workspace-less) panes. Each pane's libghostty
/// surface is mounted once and kept mounted (live PTY survives collapse/expand); a
/// PiP is the same live surface rendered at full grid and shrunk by an AppKit layer
/// transform (see ScaledGhosttyTerminal), so it's a true scaled-down thumbnail.
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

                // One mounted surface per ephemeral pane; size/position depends on state.
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
        let full = overlayFrame(in: size)               // the overlay's on-screen rect / logical size
        let scale = isOverlay ? 1 : (pipTargetWidth / full.width)
        let bodyLogical = CGSize(width: full.width, height: max(0, full.height - titleBarHeight))
        let disp = CGSize(width: full.width * scale, height: titleBarHeight + bodyLogical.height * scale)
        let center = isOverlay
            ? CGPoint(x: full.midX, y: full.midY)
            : pipCenter(for: e, in: size, footprint: disp)
        let corner: CGFloat = isOverlay ? 12 : 8

        VStack(spacing: 0) {
            titleBar(e, showButtons: isOverlay)
            ScaledGhosttyTerminal(paneID: e.pane.paneID,
                                  logicalSize: bodyLogical,   // render the full grid at this size…
                                  scale: scale,               // …then shrink the layer to fit
                                  isSelected: isOverlay,
                                  hittable: isOverlay,        // overlay types; PiP is expand-only
                                  focusTick: store.focusTick)
                .frame(width: disp.width, height: disp.height - titleBarHeight)
        }
        .frame(width: disp.width, height: disp.height)
        .background(Theme.ground)
        .clipShape(RoundedRectangle(cornerRadius: corner, style: .continuous))
        // PiP edges blend into the terminal, so give a collapsed card a stronger,
        // theme-aware border than the overlay's hairline.
        .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
            .strokeBorder(isOverlay ? Theme.hairline : Theme.textSecondary.opacity(0.55),
                          lineWidth: isOverlay ? 1 : 1.5))
        .shadow(color: .black.opacity(isOverlay ? 0.4 : 0.25),
                radius: isOverlay ? 30 : 10, y: isOverlay ? 16 : 6)
        // Collapsed: a real-NSView catcher (unscaled, at true PiP size) so the expand
        // tap wins AppKit hit-testing over the live terminal beneath it.
        .overlay { if !isOverlay { MouseCatcher { store.expandEphemeral(e.id) } } }
        .position(x: center.x, y: center.y)
        .modifier(FlashOnBump(trigger: store.ephemeralCapFlash, active: e.collapsed))
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
        .frame(height: titleBarHeight)
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

/// Hosts a `GhosttySurfaceView` at full logical size inside a flipped container and
/// shrinks it with the container layer's `sublayerTransform`. libghostty renders the
/// full terminal grid (no reflow); AppKit scales the rendered Metal layer directly —
/// which SwiftUI's `.scaleEffect` fails to do for a CAMetalLayer. `scale == 1` is the
/// overlay (identity). Kept mounted across collapse/expand so the PTY survives.
private struct ScaledGhosttyTerminal: NSViewRepresentable {
    let paneID: String
    let logicalSize: CGSize   // size the surface renders its grid at (constant → no reflow)
    let scale: CGFloat        // shrink factor applied by the container's sublayerTransform
    let isSelected: Bool      // overlay grabs first responder
    let hittable: Bool        // overlay types; PiP is expand-only (a MouseCatcher handles clicks)
    var focusTick: Int = 0

    func makeNSView(context: Context) -> ScaleContainerView { ScaleContainerView(paneID: paneID) }

    func updateNSView(_ v: ScaleContainerView, context: Context) {
        v.configure(logicalSize: logicalSize, scale: scale, hittable: hittable)
        if isSelected, let w = v.window, w.firstResponder !== v.surface {
            w.makeFirstResponder(v.surface)
        }
    }
}

private final class ScaleContainerView: NSView {
    let surface: GhosttySurfaceView
    override var isFlipped: Bool { true }   // top-left origin → sublayerTransform scales toward top-left

    init(paneID: String) {
        surface = GhosttySurfaceView(paneID: paneID)
        super.init(frame: .zero)
        wantsLayer = true
        layer?.masksToBounds = true
        addSubview(surface)
    }
    required init?(coder: NSCoder) { fatalError() }

    func configure(logicalSize: CGSize, scale: CGFloat, hittable: Bool) {
        if surface.frame.size != logicalSize {
            surface.frame = CGRect(origin: .zero, size: logicalSize)   // full grid, no reflow
        }
        surface.hitTestable = hittable
        layer?.sublayerTransform = CATransform3DMakeScale(scale, scale, 1)
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
