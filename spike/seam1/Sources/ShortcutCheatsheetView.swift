import SwiftUI

/// The ⌘/ HUD: a centered reference card of every shortcut, rendered from
/// `ShortcutCatalog` so it stays in lockstep with the menu. Dismissed by Esc,
/// click-outside, or ⌘/ again. The terminal + agents keep running underneath.
struct ShortcutCheatsheetView: View {
    @Binding var isPresented: Bool

    // Two masonry columns: even-indexed categories left, odd-indexed right.
    private var columns: (left: [ShortcutCategory], right: [ShortcutCategory]) {
        let cats = ShortcutCategory.allCases.filter { !ShortcutCatalog.commands(in: $0).isEmpty }
        var l: [ShortcutCategory] = [], r: [ShortcutCategory] = []
        for (i, c) in cats.enumerated() { if i % 2 == 0 { l.append(c) } else { r.append(c) } }
        return (l, r)
    }

    var body: some View {
        ZStack {
            // Backdrop — click anywhere outside the card to dismiss.
            Color.black.opacity(0.45)
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture { isPresented = false }

            card
        }
        .background(escHandler)
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Keyboard Shortcuts")
                .font(.ui(15, .semibold))
                .foregroundColor(Theme.textPrimary)

            HStack(alignment: .top, spacing: 40) {
                column(columns.left)
                column(columns.right)
            }

            Text("Esc to close · ⌘/ to toggle")
                .font(.ui(11))
                .foregroundColor(Theme.textDim)
                .frame(maxWidth: .infinity, alignment: .center)
        }
        .padding(28)
        .frame(width: 620)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Theme.surface1)
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(Theme.hairline, lineWidth: 1))
        )
        .shadow(color: .black.opacity(0.35), radius: 30, y: 16)
    }

    private func column(_ cats: [ShortcutCategory]) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(cats, id: \.self) { cat in
                VStack(alignment: .leading, spacing: 7) {
                    Text(cat.rawValue.uppercased())
                        .font(.ui(10, .semibold))
                        .tracking(0.6)
                        .foregroundColor(Theme.textSecondary)
                    ForEach(ShortcutCatalog.commands(in: cat)) { cmd in
                        row(cmd)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func row(_ cmd: ShortcutCommand) -> some View {
        HStack(spacing: 12) {
            Text(cmd.display)
                .font(.mono(11.5))
                .foregroundColor(Theme.textPrimary)
                .padding(.horizontal, 7)
                .padding(.vertical, 2.5)
                .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(Theme.surface3))
                .frame(width: 78, alignment: .leading)
            Text(cmd.title)
                .font(.ui(12.5))
                .foregroundColor(Theme.textPrimary)
            Spacer(minLength: 0)
        }
    }

    // Invisible button giving the overlay an Esc-to-dismiss binding.
    private var escHandler: some View {
        Button("") { isPresented = false }
            .keyboardShortcut(.cancelAction)
            .opacity(0)
            .frame(width: 0, height: 0)
            .focusable(false)
    }
}
