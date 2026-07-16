# Shepherd light theme — design

**Date:** 2026-07-16
**Status:** approved (design), pending implementation
**Scope:** add a second (light) theme, selectable via a config directive. Deliberately minimal — no new UI, no system-appearance tracking (deferred).

---

## Goal

Shepherd ships only a dark theme today (near-black "flat premium-minimal"
palette). Add a **light** theme with the same visual philosophy, inverted, and
let the user pick it via a config key. Along the way, route any color that
currently hardcodes a dark hex through `Theme` so both themes stay coherent —
the light theme is our forcing function for finding those.

## Switching mechanism

A new directive in `~/.config/shepherd/config`, riding the existing
`# shepherd: key = value` comment channel (same path as `worktree-base`):

```
# shepherd: theme = light
```

- Values: `light` | `dark`. Anything else (or absent) ⇒ `dark` (today's behavior).
- Resolved **once at launch**. Changing it requires a relaunch — consistent with
  libghostty loading its base theme once at init, and with the config already
  being read at startup.
- **No `system` (macOS appearance) option in v1** — deferred. If wanted later it
  slots in as a third enum case that resolves against `NSApp.effectiveAppearance`.

## Touch points

Three source files + one test. Token *names* are unchanged, so no call sites move.

### 1. `WorktreeService.swift` (pure, unit-tested)
- Add `enum ThemeMode { case dark, light }`.
- Add `var theme: ThemeMode = .dark` to `ShepherdConfig`.
- In `parseShepherdConfig`, handle `key == "theme"`: `"light"` ⇒ `.light`, else
  leave default `.dark` (tolerant — unknown values fall back to dark).

### 2. `Theme.swift`
- Add `static let mode: ThemeMode`, resolved once by reading
  `~/.config/shepherd/config` through `parseShepherdConfig` (mirrors how
  `monoFontName` already reads that file at launch).
- Add a private helper so tokens stay `static let` and resolve once:
  ```swift
  static func pick(dark: UInt32, light: UInt32) -> Color {
      Color(hex: mode == .light ? light : dark)
  }
  static func pickHex(dark: UInt32, light: UInt32) -> UInt32 {
      mode == .light ? light : dark
  }
  ```
- Convert every color token to `pick(dark:light:)` and every `Theme.Code.*`
  `UInt32` to `pickHex(dark:light:)`, using the palette below.
- `divider` keeps its alpha form: dark `Color.white.opacity(0.05)`, light
  `Color.black.opacity(0.06)`.

### 3. `Ghostty.swift` — `writeBaseTheme()`
- Emit the light or dark palette string based on `Theme.mode`, so the terminal
  grid matches the chrome (ADR 0010 discipline). Keeps the two halves in sync.

### 4. `CodeSurfaceView.swift` (fold-in — honoring Theme)
- `shepherdEditorTheme` currently hardcodes `0x0F0F11` (background),
  `0x1A1A1E` (lineHighlight), `0x2E2E36` (selection), `0x3B4048` (invisibles).
  Route these through `Theme` (`ground`, `surface2`, a selection token,
  `textDim`) so the editor follows the theme too. (Builds on the in-flight
  `Theme.Code` WIP already in the tree.)

### 5. Tests
- `WorktreeArchiveTests` (or the worktree/config test file) gains cases for the
  `theme` parse: `light` ⇒ `.light`, `dark`/absent/garbage ⇒ `.dark`.

## Proposed light palette

Warm off-white canvas; elevation reads as *slightly darker warm gray* (inverting
the dark theme's lighter-with-elevation ramp). State hues keep their identity but
are deepened for contrast on white.

| Token | Dark | Light |
|---|---|---|
| ground | `0F0F11` | `FBFBF9` |
| surface1 (panels) | `141417` | `F3F3F1` |
| surface2 (cards) | `1A1A1E` | `EEEEEC` |
| surface3 (hover) | `212127` | `E6E6E3` |
| raised | `1D1D20` | `F0F0EE` |
| hairline | `232327` | `DEDEDA` |
| divider | white 5% | black 6% |
| textPrimary | `EDEDED` | `1A1A1E` |
| textSecondary | `8C8C92` | `6A6A72` |
| textDim | `5F5F66` | `9A9AA2` |
| working (accent) | `5B9DF8` | `2F7DE1` |
| needsCheck | `43C988` | `1FA463` |
| blocked | `E5A23D` | `C7811A` |
| error | `E5645D` | `D23A33` |
| idle | `8C8C92` | `77777E` |
| prMerged | `A371F7` | `8250DF` |

### Syntax (`Theme.Code`) light variants
| Token | Dark | Light |
|---|---|---|
| text | `C8C8CE` | `2A2A30` |
| comment | `5F5F66` | `9A9AA2` |
| keyword | `5B9DF8` | `2F7DE1` |
| string | `43C988` | `1FA463` |
| number | `E5A23D` | `C7811A` |
| type | `8C8C92` | `6A6A72` |
| function | `EDEDED` | `1A1A1E` |
| variable | `C8C8CE` | `2A2A30` |
| builtin | `5B9DF8` | `2F7DE1` |

### Terminal ANSI (light `writeBaseTheme`)
- `background = FBFBF9`, `foreground = 1A1A1E`, `cursor-color = 2F7DE1`
- `selection-background = D6E4FB`, `selection-foreground = 1A1A1E`
- Grayscale ramp flips so text stays legible on white:
  `0=1A1A1E` `8=6A6A72` `7=9A9AA2` `15=1A1A1E`
- State-matched ANSI (normal / bright):
  red `D23A33`/`E5645D`, green `1FA463`/`2FBE7C`, yellow `C7811A`/`E5A23D`,
  blue `2F7DE1`/`5B9DF8`, magenta `8250DF`/`A371F7`, cyan `178F85`/`2FB0A4`

## Non-goals (v1)
- macOS system-appearance (`theme = system`) tracking.
- Live theme switching without relaunch.
- Per-workspace themes.

## Risks / notes
- **Hardcoded colors outside `Theme`** are the main risk — they'll stay dark on a
  light theme. The build+run pass is how we find them; `CodeSurfaceView` is the
  first known one. Any others get routed through `Theme` when spotted.
- The libghostty base theme requires a relaunch to change, which is already the
  documented behavior for the config file.
