import SwiftUI
import CoreText
import AppKit

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

    // Elevation ramp — surfaces separate by a few % lightness, not borders/shadows
    // (Linear discipline). `raised` above is kept for existing views; new surfaces
    // use these. ground → surface1 (panels) → surface2 (cards) → surface3 (hover).
    static let surface1 = Color(hex: 0x141417)
    static let surface2 = Color(hex: 0x1A1A1E)
    static let surface3 = Color(hex: 0x212127)

    static let accent = working                    // the one accent, spent sparingly
    static func accentWash(_ o: Double = 0.14) -> Color { working.opacity(o) }

    /// The **Shepherd code theme** — our own syntax palette for the diff panel.
    /// Deliberately muted and harmonious on the near-black ground: most code is a
    /// soft near-white, comments recede to a dim slate, and the accents are
    /// desaturated so nothing shouts. This is NOT the terminal's ANSI palette (that
    /// one is tuned for terminal legibility and reads as a rainbow in a review
    /// surface). Token categories are remapped onto these by nearest hue.
    static let codePalette: [UInt32] = [
        0xC5CAD3,   // default text / punctuation — soft near-white
        0x5B6270,   // comments — dim slate, recedes
        0xB08CD9,   // keyword / control — muted violet
        0x8FBF9F,   // string — sage
        0xD2A277,   // number / constant — warm amber
        0x6C9EE6,   // function / method — soft blue (kin of the accent)
        0xD8C08A,   // type / class — muted gold
        0xD98A82,   // variable / tag — muted coral
        0x6FBAB0,   // built-in / attribute — muted teal
    ]
}

extension Font {
    /// T3-Code's UI typeface — DM Sans (bundled, registered at launch by
    /// Fonts.registerBundled). Sidebar chrome only; the terminal grid keeps its
    /// own mono font from ~/.config/shepherd. Default weight is medium (500).
    static func ui(_ size: CGFloat, _ weight: Font.Weight = .medium) -> Font {
        .custom("DM Sans", size: size).weight(weight)
    }

    /// The terminal's monospace face, so diff code matches the grid. Follows the
    /// config's `font-family` if set; else libghostty's default (JetBrains Mono),
    /// preferring an installed JetBrains Mono family; else the system mono.
    static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        if let name = Theme.monoFontName { return .custom(name, size: size).weight(weight) }
        return .system(size: size, weight: weight, design: .monospaced)
    }
}

extension Theme {
    /// Resolved terminal-mono family name the app can actually load, or nil to fall
    /// back to the system monospaced face. Resolved once.
    static let monoFontName: String? = {
        var candidates: [String] = []
        if let cfg = try? String(contentsOfFile: (NSHomeDirectory() as NSString)
            .appendingPathComponent(".config/shepherd/config"), encoding: .utf8) {
            for line in cfg.split(separator: "\n") {
                let parts = line.split(separator: "=", maxSplits: 1)
                if parts.count == 2, parts[0].trimmingCharacters(in: .whitespaces) == "font-family" {
                    candidates.append(parts[1].trimmingCharacters(in: .whitespaces)
                        .trimmingCharacters(in: CharacterSet(charactersIn: "\"'")))
                }
            }
        }
        // "JetBrains Mono" is the bundled default (registered by Fonts.registerBundled),
        // so it wins unless the config overrides it; the rest cover odd installs.
        candidates += ["JetBrains Mono", "JetBrainsMono Nerd Font", "JetBrainsMono NF"]
        return candidates.first { NSFont(name: $0, size: 12) != nil }
    }()
}

/// Registers the bundled DM Sans variable font into the process at launch so
/// `Font.ui` resolves it — more reliable for variable fonts than the declarative
/// ATSApplicationFontsPath. Called once at launch; a missing font leaves the system fallback.
enum Fonts {
    static func registerBundled() {
        // DM Sans (chrome) + JetBrains Mono (terminal + diff default), so the app's
        // default faces ship with it and don't depend on what's installed.
        for name in ["DMSans", "JetBrainsMono-Regular"] {
            if let url = Bundle.main.url(forResource: name, withExtension: "ttf") {
                CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
            }
        }
    }
}
