import SwiftUI
import CoreText

extension Color {
    /// #RRGGBB hex (no alpha).
    init(hex: UInt32) {
        self.init(.sRGB,
                  red:   Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8)  & 0xFF) / 255,
                  blue:  Double( hex        & 0xFF) / 255)
    }
}

/// Design tokens. Flat near-black, premium-minimal — modeled on T3 Code /
/// Conductor. State colors are soft and used sparingly.
enum Theme {
    static let ground        = Color(hex: 0x0F0F11)
    static let raised        = Color(hex: 0x1D1D20)
    static let hairline      = Color(hex: 0x232327)
    static let textPrimary   = Color(hex: 0xEDEDED)
    static let textSecondary = Color(hex: 0x8C8C92)
    static let textDim       = Color(hex: 0x5F5F66)

    static let working    = Color(hex: 0x5B9DF8)   // busy — leave it
    static let needsCheck = Color(hex: 0x43C988)   // done — ready for you
    static let blocked    = Color(hex: 0xE5A23D)   // your move
    static let error      = Color(hex: 0xE5645D)   // broke
    static let idle       = Color(hex: 0x8C8C92)   // between turns
}

extension Font {
    /// T3-Code's UI typeface — DM Sans (bundled, registered at launch by
    /// Fonts.registerBundled). Sidebar chrome only; the terminal grid keeps its
    /// own mono font from ~/.config/shepherd. Default weight is medium (500).
    static func ui(_ size: CGFloat, _ weight: Font.Weight = .medium) -> Font {
        .custom("DM Sans", size: size).weight(weight)
    }
}

/// Registers the bundled DM Sans variable font into the process at launch so
/// `Font.ui` resolves it — more reliable for variable fonts than the declarative
/// ATSApplicationFontsPath. Called once at launch; a missing font leaves the system fallback.
enum Fonts {
    static func registerBundled() {
        guard let url = Bundle.main.url(forResource: "DMSans", withExtension: "ttf") else { return }
        CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
    }
}
