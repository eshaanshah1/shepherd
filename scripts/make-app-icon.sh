#!/usr/bin/env bash
#
# Generate the macOS app icon set + .icns from a full-frame logo PNG, zooming the goat
# so it owns ~64% of the icon height — Shepherd's established icon treatment (the source
# art places a small goat on a large solid field; a raw resize leaves it tiny).
#
#   scripts/make-app-icon.sh <source.png> <appiconset-dir> <output.icns>
#
# e.g.  scripts/make-app-icon.sh ~/Downloads/shepherd_indigo.png \
#         spike/seam1/Resources/Assets.xcassets/AppIcon.appiconset \
#         spike/seam1/Resources/AppIcon.icns
set -euo pipefail

SRC="${1:?source png}"; SET="${2:?appiconset dir}"; ICNS="${3:?output icns}"
GOAT_FRAC=0.64   # goat height as a fraction of the icon frame

command -v convert  >/dev/null || { echo "needs ImageMagick (brew install imagemagick)"; exit 1; }
command -v iconutil >/dev/null || { echo "needs iconutil (Xcode command-line tools)"; exit 1; }

# 1) Goat bounding box. Background is a solid field; fuzz absorbs the subtle paper texture.
read -r W H X Y < <(convert "$SRC" -fuzz 20% -trim -format '%w %h %X %Y\n' info: | tr -d '+')
read -r side left top < <(python3 - "$W" "$H" "$X" "$Y" "$GOAT_FRAC" <<'PY'
import sys
W, H, X, Y = map(int, sys.argv[1:5]); frac = float(sys.argv[5])
cx, cy = X + W / 2, Y + H / 2          # goat center in the source
side = round(H / frac)                  # frame so the goat is `frac` of its height
print(side, round(cx - side / 2), round(cy - side / 2))
PY
)

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
BG="$(convert "$SRC" -format '%[pixel:p{5,5}]' info:)"   # corner = background field

# 2) Centered square crop (bg-filled if it ever runs past an edge) → 1024 master.
convert "$SRC" -background "$BG" -crop "${side}x${side}+${left}+${top}" +repage \
        -gravity center -background "$BG" -extent "${side}x${side}" \
        -resize 1024x1024 "$WORK/master.png"

# 3) Every size the .xcassets appiconset + the .iconset need (name → px).
sizes="icon_16x16:16 icon_16x16@2x:32 icon_32x32:32 icon_32x32@2x:64
       icon_128x128:128 icon_128x128@2x:256 icon_256x256:256 icon_256x256@2x:512
       icon_512x512:512 icon_512x512@2x:1024"

mkdir -p "$SET"
ICONSET="$WORK/AppIcon.iconset"; mkdir -p "$ICONSET"
for pair in $sizes; do
  name="${pair%%:*}"; px="${pair##*:}"
  convert "$WORK/master.png" -resize "${px}x${px}" "$SET/$name.png"
  convert "$WORK/master.png" -resize "${px}x${px}" "$ICONSET/$name.png"
done

iconutil -c icns "$ICONSET" -o "$ICNS"
echo "✓ $SET"
echo "✓ $ICNS  (goat ≈ $(python3 -c "print(f'{$H/$side*100:.0f}')")% of the frame)"
