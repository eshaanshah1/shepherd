# Seam 1 — a live libghostty surface in your own window

This is the only genuinely-unknown seam: whether you can embed a libghostty
terminal surface in a fresh SwiftUI/AppKit app *today*. Prove it before building
anything else.

## Goal

A single `NSWindow` showing:
- a real terminal surface (your `$SHELL`, real keystrokes, Metal rendering), via libghostty
- the `SidebarView` from this skeleton beside it

## Steps

1. **Get libghostty as `GhosttyKit.xcframework`.**
   - Clone Ghostty (MIT). Build the embeddable lib / xcframework target with its
     Zig toolchain (the macOS app consumes exactly this artifact).
   - Confirm the current C API surface in `include/ghostty.h` — this is the part
     whose maturity is the risk. If it looks embeddable, proceed; if not, that's
     a finding, and the plan changes here.

2. **Make a macOS app target** (Xcode app project is the realistic host —
   App-lifecycle SwiftUI + a Metal surface wants a real bundle/Info.plist).
   Drop in `Sources/Shepherd/*.swift` from this skeleton.

3. **Crib the embedding glue, don't author it cold.** Copy/adapt Ghostty's MIT
   `SurfaceView` (and the app/runtime callback wiring — clipboard, title, bell,
   config, etc.) from Ghostty's `macos/Sources/Ghostty/`. Replace
   `GhosttySurfaceView` with a wrapper that:
   - creates the `ghostty_app_t` / `ghostty_surface_t`
   - hosts the surface's `CAMetalLayer` in the `NSView`
   - forwards key/mouse events
   - **spawns the shell with `SHEPHERD_TAB_ID` + `SHEPHERD_SOCK` in its env**
     (this is also seam 2 — env injection at surface spawn)
   - reports the surface's **title-changed** callback to `AgentStore.setTitle`

4. **Run it.** Type. See a prompt. Run `ls`. If that works, seam 1 is green.

## Bonus: all three seams at once

With step 3's env injection in place, run `claude` *inside the embedded surface*
with the throwaway plugin installed and the `socket-probe` (or the real
`AgentStore.listen()`) running. State should flow from a real agent, in your
window, correlated by the `tab_id` you injected — the whole architecture proven
in one shot.

## If seam 1 fights you

The fallback isn't "give up" — it's "reduce the unknown":
- Stand up the Ghostty macOS app from source first, confirm *their* SurfaceView
  builds against your xcframework, then lift it.
- If the public C API genuinely isn't embeddable yet, reconsider: vendor more of
  Ghostty's Swift layer, or pin to a known-good Ghostty commit. Either way you've
  learned it in a weekend, not month three.
