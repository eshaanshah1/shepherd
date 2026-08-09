#!/usr/bin/env bash
# Build the two `.icns` electron-builder packages into Shep and Shep Night.
#
#   tooling/scripts/make-icons.sh <day.png> <night.png>
#
# The inputs are full-bleed square art (1024px or better). `mask-icon.swift`
# draws each inside Apple's squircle with the standard padding — macOS does not
# round an app icon for you — and `iconutil` turns the result into the `.icns`
# that `electron-builder.yml` names.
#
# The OUTPUT is committed. `packages/app/build/` is electron-builder's
# `buildResources` directory, and it lives in a repo whose root `.gitignore`
# carries `**/build/` for v1's xcodebuild output; that rule swallowed this
# directory, so the icons were never tracked and every fresh checkout packaged
# with Electron's default icon — silently, since electron-builder only says
# "default Electron icon is used" in the middle of a successful build. The
# `.gitignore` now re-includes this path; keep it that way.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="$root/packages/app/build"

day="${1:-$HOME/Downloads/shep.png}"
night="${2:-$HOME/Downloads/shep-night.png}"

build_one() {
  local src="$1" name="$2"
  [ -f "$src" ] || { echo "make-icons: no source art at $src" >&2; exit 1; }

  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  swift "$here/mask-icon.swift" "$src" "$tmp/masked.png"

  local set="$tmp/icon.iconset"
  mkdir -p "$set"
  # The names are iconutil's, not ours: it reads the sizes off the filenames.
  for spec in "16 icon_16x16" "32 icon_16x16@2x" "32 icon_32x32" "64 icon_32x32@2x" \
              "128 icon_128x128" "256 icon_128x128@2x" "256 icon_256x256" \
              "512 icon_256x256@2x" "512 icon_512x512" "1024 icon_512x512@2x"; do
    set -- $spec
    sips -z "$1" "$1" "$tmp/masked.png" --out "$set/$2.png" >/dev/null
  done

  mkdir -p "$out"
  iconutil -c icns "$set" -o "$out/$name.icns"
  echo "make-icons: wrote $out/$name.icns"
}

build_one "$day" icon
build_one "$night" icon-dev
