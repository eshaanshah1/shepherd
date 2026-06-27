# 0001. Build on libghostty in a fresh SwiftUI app

Status: Accepted
Date: 2026-06-27

## Context
Shepherd needs a real terminal engine and a custom UI (sidebar, tabs, agent
state). Three options: (a) fork Ghostty's macOS app and graft features on,
(b) embed the raw `libghostty` C API in a from-scratch app, (c) build chrome
fresh while reusing Ghostty's proven embedding glue. The terminal grid (PTY, VT
parsing, Metal rendering) is the hard part we should not rebuild; the chrome is
where Shepherd's value is and where we want full control.

## Decision
Fresh **SwiftUI/AppKit app** that links **libghostty** (compiled as
`GhosttyKit.xcframework`) and renders each terminal as a libghostty Metal surface
wrapped in `NSViewRepresentable`. We crib the embedding patterns (surface
creation, runtime callbacks, key/mouse encoding) from Ghostty's MIT macOS
sources rather than authoring them blind. SwiftUI owns all chrome; libghostty
owns the grid. We do **not** fork the Ghostty app or ship its window/tab model.

## Consequences
- Full control over workspaces/sidebar/navigator without fighting Ghostty's app.
- We own the C-interop glue (runtime callback table, input encoding, vsync,
  occlusion) — see `Ghostty.swift` / `GhosttyTerminal.swift`.
- We must track libghostty's (unstable) embedding API ourselves; pinned to
  Ghostty **v1.3.1**. The C API is "not stable for general use" per Ghostty.
- Reaffirmed by the spike: a single surface rendered + took input on day one.
