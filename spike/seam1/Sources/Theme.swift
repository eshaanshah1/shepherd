import SwiftUI

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
