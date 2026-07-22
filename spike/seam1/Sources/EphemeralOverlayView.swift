import SwiftUI

/// In-window layer for ephemeral (workspace-less) panes. Each pane's libghostty
/// surface is mounted once and kept mounted (live PTY survives collapse/expand);
/// its container animates between the centered overlay and a bottom-right PiP.
struct EphemeralOverlayView: View {
    @EnvironmentObject var store: AgentStore

    private let pipSize = CGSize(width: 240, height: 150)
    private let pipGap: CGFloat = 12

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
        let frame = isOverlay ? overlayFrame(in: size) : pipFrame(for: e, in: size)

        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: isOverlay ? 12 : 8, style: .continuous)
                .fill(Theme.ground)
                .overlay(RoundedRectangle(cornerRadius: isOverlay ? 12 : 8, style: .continuous)
                    .strokeBorder(Theme.hairline, lineWidth: 1))

            VStack(spacing: 0) {
                titleBar(e, isOverlay: isOverlay)
                terminal(e, isOverlay: isOverlay)
            }
        }
        // A collapsed card expands on click. Its click-catcher is a real NSView (not a
        // SwiftUI gesture) so it wins AppKit hit-testing over the live terminal beneath it.
        .overlay { if !isOverlay { MouseCatcher { store.expandEphemeral(e.id) } } }
        .frame(width: frame.width, height: frame.height)
        .clipShape(RoundedRectangle(cornerRadius: isOverlay ? 12 : 8, style: .continuous))
        .shadow(color: .black.opacity(isOverlay ? 0.4 : 0.25),
                radius: isOverlay ? 30 : 10, y: isOverlay ? 16 : 6)
        .position(x: frame.midX, y: frame.midY)
        .modifier(FlashOnBump(trigger: store.ephemeralCapFlash, active: e.collapsed))
    }

    private func titleBar(_ e: EphemeralPane, isOverlay: Bool) -> some View {
        HStack(spacing: 8) {
            Circle().fill(e.pane.state.color).frame(width: 7, height: 7)
            Text(e.pane.displayTitle)
                .font(.ui(isOverlay ? 12.5 : 11))
                .foregroundColor(Theme.textPrimary)
                .lineLimit(1)
            Spacer(minLength: 0)
            if isOverlay {
                iconButton("minus") { store.collapseEphemeral(e.id) }
                iconButton("xmark") { store.closeEphemeral(e.id) }
            }
        }
        .padding(.horizontal, 10)
        .frame(height: isOverlay ? 30 : 24)
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

    /// Vertical stack of PiPs anchored bottom-right, newest at the bottom.
    private func pipFrame(for e: EphemeralPane, in size: CGSize) -> CGRect {
        let collapsed = store.ephemeralPanes.filter { $0.collapsed }
        let idx = collapsed.firstIndex { $0.id == e.id } ?? 0
        let fromBottom = collapsed.count - 1 - idx
        let x = size.width - pipSize.width - pipGap
        let y = size.height - pipSize.height - pipGap - CGFloat(fromBottom) * (pipSize.height + pipGap)
        return CGRect(x: x, y: y, width: pipSize.width, height: pipSize.height)
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
