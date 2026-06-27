# 0002. Building libghostty on macOS 26 (the toolchain saga)

Status: Accepted
Date: 2026-06-27

## Context
There is no prebuilt, downloadable libghostty — you compile it from Ghostty's
source into `GhosttyKit.xcframework`. Doing this on macOS 26 / Xcode 26 / Zig
hit four distinct, non-obvious blockers, each of which would silently waste a
future session's time.

## Decision
Encode the working build in `scripts/build-libghostty.sh`, which:
1. Uses **brew `zig@0.15`** (= 0.15.2, Ghostty's pinned min). The manual
   ziglang.org Zig does **not** link on macOS 26 — every libSystem symbol comes
   back undefined (`__availability_version_check`, `_abort`, …).
2. Requires the **Metal Toolchain** component (`xcodebuild -downloadComponent
   MetalToolchain`) — Xcode 26 omits it by default and Ghostty compiles `.metal`
   shaders.
3. Builds **only the xcframework** (`-Demit-xcframework=true -Demit-macos-app=false`)
   — the bundled Ghostty.app target fails to link on macOS 26 and we don't need it.
4. **Re-assembles a complete static archive via `ld -r -all_load`.** Apple's
   `libtool -static` (which Ghostty's own build uses to combine libghostty + its
   vendored deps) **dedupes same-named archive members on macOS 26**, so the
   combined `libghostty-fat.a` is *incomplete* and drops different objects per
   build mode (Debug dropped the ImGui C-API; ReleaseFast dropped the object with
   `ghostty_init`). `ld -r` merges by symbol (no dedupe), then we wrap the result.

## Consequences
- The consuming app must also link `-lstdc++`, `Carbon.framework`, and
  `GameController.framework` (the `ld -r` merge drops the static lib's autolink hints).
- This is effectively a Ghostty-on-macOS-26 build bug worth reporting upstream.
- If you bump the Ghostty tag or Xcode/Zig, re-validate this whole chain.
