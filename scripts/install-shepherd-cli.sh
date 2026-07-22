#!/usr/bin/env bash
# Symlink the built shepherdd helper onto PATH as `shepherd`, so Claude Code and
# any shell can drive a running Shepherd (see docs/control-cli.md).
set -euo pipefail
APP="${1:-spike/seam1/build/Build/Products/Debug/Shepherd.app}"
BIN="$APP/Contents/MacOS/shepherdd"
[ -x "$BIN" ] || BIN="$APP/Contents/Resources/shepherdd"
if [ ! -x "$BIN" ]; then
    echo "shepherdd not found under $APP — build the app first" >&2
    exit 1
fi
mkdir -p "$HOME/.local/bin"
ln -sf "$BIN" "$HOME/.local/bin/shepherd"
echo "linked $HOME/.local/bin/shepherd -> $BIN"
case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) echo "note: add ~/.local/bin to your PATH" ;;
esac
