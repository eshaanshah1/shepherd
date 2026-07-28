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

/// Design tokens. Flat near-black (dark) or warm off-white (light),
/// premium-minimal — modeled on T3 Code / Conductor. State colors are soft and
/// used sparingly. The active palette is chosen once at launch from
/// `# shepherd: theme = light|dark` in `~/.config/shepherd/config`; token names
/// are identical across themes so call sites never branch on the mode.
enum Theme {
    /// The active theme. Resolved from the config at launch and re-resolved on a
    /// live config reload (⌘⇧R → `reloadMode()`). Mutable so tokens (computed
    /// below) re-resolve against it without a relaunch.
    static var mode: ThemeMode = resolveMode()

    /// Code-editor line wrapping (`# shepherd: editor-wrap-lines`). Off by default →
    /// the editor scrolls horizontally. Re-resolved on ⌘⇧R alongside `mode`.
    static var editorWrapLines: Bool = resolveConfig().editorWrapLines

    private static func resolveConfig() -> ShepherdConfig {
        guard let cfg = try? String(contentsOfFile: (NSHomeDirectory() as NSString)
            .appendingPathComponent(".config/shepherd/config"), encoding: .utf8)
        else { return ShepherdConfig() }
        return parseShepherdConfig(cfg)
    }

    private static func resolveMode() -> ThemeMode { resolveConfig().theme }

    /// Re-read the config file and update `mode` + `editorWrapLines`. The chrome
    /// re-render + libghostty grid reload are driven by the caller (`GhosttyApp.reloadConfig`).
    static func reloadMode() {
        let cfg = resolveConfig()
        mode = cfg.theme
        editorWrapLines = cfg.editorWrapLines
    }

    /// Pick a per-theme color / raw hex. Tokens are computed `static var` so each
    /// read re-resolves against the current `mode` — cheap, and lets a live reload
    /// recolor without a relaunch. `warm` is the cream/sepia middle-ground light
    /// theme (mapped from ~/.claude/themes/shepherd.json).
    static func pick(dark: UInt32, light: UInt32, warm: UInt32) -> Color {
        Color(hex: pickHex(dark: dark, light: light, warm: warm))
    }
    static func pickHex(dark: UInt32, light: UInt32, warm: UInt32) -> UInt32 {
        switch mode {
        case .dark:  return dark
        case .light: return light
        case .warm:  return warm
        }
    }

    static var ground        : Color { pick(dark: 0x0F0F11, light: 0xFBFBF9, warm: 0xFAF4E6) }
    static var raised        : Color { pick(dark: 0x1D1D20, light: 0xF0F0EE, warm: 0xF0E8D4) }
    static var hairline      : Color { pick(dark: 0x232327, light: 0xDEDEDA, warm: 0xC9BFA8) }
    // Ghost separator for inter-group lines — a low-alpha wash so groups read
    // apart on whitespace, not a visible rule (white on dark, black on the light themes).
    static var divider       : Color { mode == .dark ? Color.white.opacity(0.05)
                                                      : Color.black.opacity(0.06) }
    static var textPrimary   : Color { pick(dark: 0xEDEDED, light: 0x1A1A1E, warm: 0x43413A) }
    static var textSecondary : Color { pick(dark: 0x8C8C92, light: 0x6A6A72, warm: 0x8F897A) }
    static var textDim       : Color { pick(dark: 0x5F5F66, light: 0x9A9AA2, warm: 0xA39A86) }

    static var working    : Color { pick(dark: 0x5B9DF8, light: 0x2F7DE1, warm: 0x4A7996) }   // busy — leave it
    static var needsCheck : Color { pick(dark: 0x43C988, light: 0x1FA463, warm: 0x6F8F3D) }   // done — ready for you
    static var blocked    : Color { pick(dark: 0xE5A23D, light: 0xC7811A, warm: 0xB5841C) }   // your move
    static var error      : Color { pick(dark: 0xE5645D, light: 0xD23A33, warm: 0xB04A3D) }   // broke
    static var idle       : Color { pick(dark: 0x8C8C92, light: 0x77777E, warm: 0x8F897A) }   // between turns
    static var prMerged   : Color { pick(dark: 0xA371F7, light: 0x8250DF, warm: 0x8563A8) }   // merged PR — GitHub-ish violet

    // Elevation ramp — surfaces separate by a few % lightness, not borders/shadows
    // (Linear discipline). `raised` above is kept for existing views; new surfaces
    // use these. ground → surface1 (panels) → surface2 (cards) → surface3 (hover);
    // dark rises lighter, the light themes sink to a warmer/greyer tint.
    static var surface1 : Color { pick(dark: 0x141417, light: 0xF3F3F1, warm: 0xF3ECDA) }
    static var surface2 : Color { pick(dark: 0x1A1A1E, light: 0xEEEEEC, warm: 0xECE3CD) }
    static var surface3 : Color { pick(dark: 0x212127, light: 0xE6E6E3, warm: 0xE3D9BF) }

    static var accent : Color { working }          // the one accent, spent sparingly
    static func accentWash(_ o: Double = 0.14) -> Color { working.opacity(o) }

    /// Shepherd's own syntax palette — the "restrained" scheme. Three accents drawn
    /// straight from the state-dot colors (keyword = working blue, string = done green,
    /// number = blocked amber); everything else stays in the text ramp so nothing
    /// shouts on the near-black ground. Both the diff and the editor render from this,
    /// so code reads in the app's voice — not a stock IDE theme.
    enum Code {
        static var text     : UInt32 { pickHex(dark: 0xC8C8CE, light: 0x2A2A30, warm: 0x43413A) }
        static var comment  : UInt32 { pickHex(dark: 0x5F5F66, light: 0x9A9AA2, warm: 0x8F897A) }
        static var keyword  : UInt32 { pickHex(dark: 0x5B9DF8, light: 0x2F7DE1, warm: 0x4A7996) }   // working
        static var string   : UInt32 { pickHex(dark: 0x43C988, light: 0x1FA463, warm: 0x6F8F3D) }   // needsCheck
        static var number   : UInt32 { pickHex(dark: 0xE5A23D, light: 0xC7811A, warm: 0xB5841C) }   // blocked
        static var type     : UInt32 { pickHex(dark: 0x8C8C92, light: 0x6A6A72, warm: 0x8F897A) }   // secondary — quiet
        static var function : UInt32 { pickHex(dark: 0xEDEDED, light: 0x1A1A1E, warm: 0x43413A) }   // primary
        static var variable : UInt32 { pickHex(dark: 0xC8C8CE, light: 0x2A2A30, warm: 0x5A564C) }   // text
        static var builtin  : UInt32 { pickHex(dark: 0x5B9DF8, light: 0x2F7DE1, warm: 0x4A7996) }   // working
    }

    /// Diff colors, deliberately independent of the state-dot ramp. Deriving them
    /// from `needsCheck`/`error` made "line added" the same green as "agent is
    /// done" — a semantic collision, and the reason the old tints read washed out.
    enum Diff {
        static var addition  : UInt32 { pickHex(dark: 0x3FB950, light: 0x1A7F37, warm: 0x5C8A2E) }
        static var deletion  : UInt32 { pickHex(dark: 0xF85149, light: 0xCF222E, warm: 0xA83A2C) }
        static var modified  : UInt32 { pickHex(dark: 0x58A6FF, light: 0x0969DA, warm: 0x3F6E91) }
        static var buffer    : UInt32 { pickHex(dark: 0x0F0F11, light: 0xFBFBF9, warm: 0xFAF4E6) }
        static var hover     : UInt32 { pickHex(dark: 0x1F1F24, light: 0xEAEAE7, warm: 0xE8DFC7) }
        static var separator : UInt32 { pickHex(dark: 0x232327, light: 0xDEDEDA, warm: 0xC9BFA8) }
        static var gutterFg  : UInt32 { pickHex(dark: 0x5F5F66, light: 0x9A9AA2, warm: 0xA39A86) }
        /// Word-level tints, sitting on top of the row tint for the parts that changed.
        static var wordAdd   : UInt32 { pickHex(dark: 0x2B5B33, light: 0xAEE0B8, warm: 0xC3D6A4) }
        static var wordDel   : UInt32 { pickHex(dark: 0x6E2B28, light: 0xF3B7B3, warm: 0xE0B4AA) }
        /// The blame lane's hue, shaded by age through alpha. One token rather than four:
        /// a colour per age bucket is four values to keep in tune across three themes for
        /// nothing the alpha steps don't already give.
        static var blameHeat        : UInt32 { pickHex(dark: 0x58A6FF, light: 0x0969DA, warm: 0x3F6E91) }
        /// A line that is not committed yet. Deliberately not the heat hue: it is a
        /// different kind of fact, not a fresher version of the same one.
        static var blameUncommitted : UInt32 { pickHex(dark: 0x8B949E, light: 0x8C959F, warm: 0x9A8F79) }
    }

    /// Shared row rhythm. The editor, the diff, and the gutter all read this — its
    /// absence is why the old diff panel needed a hand-computed padding fudge to
    /// approximate the editor's line height.
    static let lineHeightMultiple: CGFloat = 1.5

    /// Every derived token for a mode, keyed by name. Exists so a test can assert
    /// the chain has no holes in any theme. Restores the active mode on the way out.
    static func derivedTokens(for mode: ThemeMode) -> [String: UInt32] {
        let previous = self.mode
        self.mode = mode
        defer { self.mode = previous }
        return [
            "code.text": Code.text, "code.comment": Code.comment,
            "code.keyword": Code.keyword, "code.string": Code.string,
            "code.number": Code.number, "code.type": Code.type,
            "code.function": Code.function, "code.variable": Code.variable,
            "code.builtin": Code.builtin,
            "diff.addition": Diff.addition, "diff.deletion": Diff.deletion,
            "diff.modified": Diff.modified, "diff.buffer": Diff.buffer,
            "diff.hover": Diff.hover, "diff.separator": Diff.separator,
            "diff.gutterFg": Diff.gutterFg,
            "diff.wordAdd": Diff.wordAdd, "diff.wordDel": Diff.wordDel,
            "diff.blameHeat": Diff.blameHeat,
            "diff.blameUncommitted": Diff.blameUncommitted,
        ]
    }
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
