#!/usr/bin/env bash
# Reproducibly build libghostty as vendor/GhosttyKit.xcframework for Shepherd.
#
# THE SAGA THIS ENCODES (macOS 26 / Xcode 26 / Zig 0.15.2):
#   1. Manual ziglang.org Zig does NOT link on macOS 26 (undefined libSystem
#      symbols). Use keg-only brew:
#        brew install zig@0.15
#        ln -sf "$(brew --prefix zig@0.15)/bin/zig" ~/.local/bin/zig
#   2. Ghostty's Metal shaders need the Metal Toolchain component:
#        xcodebuild -downloadComponent MetalToolchain
#   3. Build ONLY the xcframework (-Demit-macos-app=false): the bundled
#      Ghostty.app target fails to link on macOS 26 and we don't need it.
#   4. Zig's `zig build` combines libghostty + deps into libghostty-fat.a via
#      Apple `libtool -static`, which on macOS 26 DEDUPES same-named members and
#      silently drops objects -> the fat archive is INCOMPLETE (missing the
#      ImGui C-API / sentry / the ghostty_init entry-point object, varying by
#      optimize mode). So we IGNORE zig's fat archive and assemble our own
#      COMPLETE one from the constituent archives via `ld -r` (merges by symbol,
#      no dedupe), then wrap it. This is the crux fix.
#   5. The consuming app must also link: -lstdc++, Carbon.framework,
#      GameController.framework (ld -r drops the static lib's autolink hints).
set -euo pipefail

GHOSTTY_TAG="${GHOSTTY_TAG:-v1.3.1}"          # matches the installed Ghostty.app
OPTIMIZE="${OPTIMIZE:-ReleaseFast}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="${BUILD_DIR:-/tmp/shepherd-ghostty-build}"
ZIG="${ZIG:-$(brew --prefix zig@0.15)/bin/zig}"
DST="$REPO_ROOT/vendor/GhosttyKit.xcframework"

echo "==> zig: $ZIG ($("$ZIG" version))   ghostty: $GHOSTTY_TAG   optimize: $OPTIMIZE"

rm -rf "$BUILD_DIR"
git clone --depth 1 --branch "$GHOSTTY_TAG" https://github.com/ghostty-org/ghostty.git "$BUILD_DIR"

cd "$BUILD_DIR"
"$ZIG" build \
  -Demit-xcframework=true -Demit-macos-app=false \
  -Dxcframework-target=native -Doptimize="$OPTIMIZE"

# Vendor the xcframework (Headers + module map + Info.plist).
rm -rf "$DST"; mkdir -p "$REPO_ROOT/vendor"
cp -R "$BUILD_DIR/macos/GhosttyKit.xcframework" "$DST"

echo "==> assembling a COMPLETE static archive (zig's libtool-combined fat is incomplete on macOS 26)"
CACHE="$BUILD_DIR/.zig-cache"
SDK_VER="$(xcrun --sdk macosx --show-sdk-version)"
# newest (= this build's) of every lib*.a, except the incomplete combined fat
# and the separate libghostty-vt product. Includes libghostty.a + every dep.
LIBS=()
while IFS= read -r n; do
  [ -n "$n" ] && LIBS+=("$(find "$CACHE" -name "$n" -type f | xargs ls -t | head -1)")
done < <(find "$CACHE" -name 'lib*.a' -type f | xargs -n1 basename | sort -u \
           | grep -vE 'libghostty-fat\.a|libghostty-vt')
echo "    merging ${#LIBS[@]} archives via ld -r"
TMP="$(mktemp -d)"
xcrun ld -r -arch arm64 -platform_version macos 13.0 "$SDK_VER" -all_load \
  "${LIBS[@]}" -o "$TMP/libghostty-complete.o"
xcrun libtool -static -o "$DST/macos-arm64/libghostty-fat.a" "$TMP/libghostty-complete.o"
rm -rf "$TMP"

echo "==> done: $DST"
echo "==> complete archive: $(du -h "$DST/macos-arm64/libghostty-fat.a" | cut -f1)"
echo "    (link the consumer app with -lstdc++ + Carbon.framework + GameController.framework)"
