import SwiftUI

// Shepherd's shared visual primitives. Deliberately small — a card that carries
// the accent-stripe focus signature, and a ghost icon button with a warm hover.
// Grounded in the existing Theme palette; no new look, just consistent application.

extension View {
    /// A quiet surface card: an elevated tone + a 1px hairline. No focus ring or
    /// stripe — Shepherd marks focus by dimming what competes, not by adorning the
    /// focused element (and often the cursor alone is enough).
    func shepherdCard(radius: CGFloat = 8) -> some View {
        self
            .background(Theme.surface2)
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .stroke(Theme.hairline, lineWidth: 1)
            }
    }
}

/// A ghost icon button: quiet by default, a faint warm surface + brighter glyph on
/// hover. Stays `.focusable(false)` so it never steals keys from the terminal.
struct GhostIconButton: View {
    let systemName: String
    let help: String
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(hovering ? Theme.textPrimary : Theme.textDim)
                .frame(width: 24, height: 22)
                .background(hovering ? Theme.surface3 : .clear)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .focusable(false)
        .help(help)
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
    }
}
