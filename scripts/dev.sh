#!/usr/bin/env bash
#
# Build + relaunch the throwaway "Shepherd Dev" instance.
#
# Shepherd Dev is a separate app (bundle id com.shepherd.Shepherd.dev, product
# ShepherdDev) with fully separate state from your daily Shepherd — its own
# UserDefaults domain and its own ~/.shepherd/dev support subtree. On every launch it
# copies your daily app's UI layout (workspaces/tabs/splits/cwds) as plain shells, so
# it looks like your real setup without resuming your real agents. Nuke it as often as
# you like; your daily Shepherd is never touched.
#
#   scripts/dev.sh            build once + relaunch the dev app
#   scripts/dev.sh --watch    also rebuild+relaunch on every save under Sources/
#
# Promotion to the main app is unchanged: this only builds the ShepherdDev target;
# releases build the `Shepherd` target. Ship via the normal workflow.
set -euo pipefail

cd "$(dirname "$0")/../spike/seam1"

build_and_run() {
  xcodegen generate
  xcodebuild -project Shepherd.xcodeproj -scheme ShepherdDev -configuration Debug \
    -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
    CLANG_MODULE_CACHE_PATH=./build/ModuleCache build
  local app=./build/Build/Products/Debug/ShepherdDev.app
  codesign --force --deep --sign - "$app"
  killall ShepherdDev 2>/dev/null || true
  # `open` right after killall can hit LaunchServices -600; wait for the old one to exit.
  while pgrep -x ShepherdDev >/dev/null; do sleep 0.2; done
  open "$app"
  echo "▸ Shepherd Dev relaunched."
}

build_and_run

if [[ "${1:-}" == "--watch" ]]; then
  command -v fswatch >/dev/null || { echo "fswatch not found — brew install fswatch"; exit 1; }
  echo "Watching Sources/ — save a file to rebuild (Ctrl-C to stop)…"
  fswatch -o Sources | while read -r _; do
    echo "↻ change detected, rebuilding…"
    build_and_run || echo "✗ build failed; keeping the current dev instance running"
  done
fi
