#!/usr/bin/env bash
# Vendor CodeEditLanguages into vendor/CodeEditLanguages as a BLOBLESS clone.
#
# WHY THIS EXISTS: upstream bundles ~50 tree-sitter grammars, and every
# regenerated parser.c is a multi-MB blob kept in history -> a full clone is
# 3.2G of objects to serve a 34M checkout. SwiftPM has no --depth/--filter
# option, and it pays that 3.2G TWICE: once in ~/Library/Caches/org.swift.swiftpm
# and again in every worktree's -derivedDataPath SourcePackages. Consuming it as
# a local path package instead means SwiftPM clones nothing.
#
# --filter=blob:none (not --depth) is deliberate: it keeps the entire commit
# graph and every tag, so `git fetch && git merge` upstream still works here;
# only file contents are fetched on demand. A shallow clone would break that.
#
# A local path package makes SwiftPM ignore version requirements, so the tag
# checked out below IS the dependency pin — bump TAG to upgrade.
#
# THE SLICE WE THROW AWAY: the grammars ship as a prebuilt static archive inside
# CodeLanguagesContainer.xcframework.zip, fat with arm64 (198 MB) + x86_64 (195 MB).
# Shepherd cannot build for x86_64 at all — vendor/GhosttyKit.xcframework has only a
# macos-arm64 slice — so that second slice is dead weight, and it is dead weight in
# EVERY copy: the SwiftPM artifacts cache, and each worktree's
# Products/Debug/CodeLanguages_Container.framework (a linked static archive is copied
# into BUILT_PRODUCTS_DIR, exactly as libghostty-fat.a is, so no way of declaring the
# dependency avoids it). Three built worktrees plus the cache had this machine's disk
# at 100%. So we thin the slice out and rezip in place, which is invisible to SwiftPM:
# a LOCAL binaryTarget carries no checksum, only a remote `url:` one does.
set -euo pipefail

TAG="${CEL_TAG:-0.1.20}"
REPO="${CEL_REPO:-https://github.com/CodeEditApp/CodeEditLanguages}"
ARCH="${CEL_ARCH:-arm64}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/vendor/CodeEditLanguages"
CONTAINER="$DEST/CodeLanguagesContainer.xcframework.zip"

if [ -d "$DEST/.git" ]; then
  echo "==> updating $DEST"
  git -C "$DEST" fetch --filter=blob:none --tags --force origin "refs/tags/$TAG:refs/tags/$TAG"
else
  echo "==> blobless clone of $REPO"
  mkdir -p "$(dirname "$DEST")"
  git clone --filter=blob:none --no-checkout "$REPO" "$DEST"
fi

echo "==> checking out $TAG"
git -C "$DEST" -c advice.detachedHead=false checkout --force "$TAG"

# A path package is only usable if SwiftPM can read its manifest; failing here
# beats a confusing "missing package product" at build time.
if [ ! -f "$DEST/Package.swift" ]; then
  echo "error: $DEST/Package.swift missing — clone did not produce a package" >&2
  exit 1
fi

# The `checkout --force` above restores upstream's fat zip on every run, so the normal
# path always re-thins — that is what makes this idempotent rather than doubly-applied.
# The single-slice check below is for a vendor dir reached some other way (a hand-thinned
# zip, or a caller that skips the checkout); it is not a fast path for CI, which pays the
# ~1 min unzip/lipo/rezip every time.
thin_container() {
  [ -f "$CONTAINER" ] || { echo "error: $CONTAINER missing" >&2; exit 1; }
  # Read the listing into a variable rather than piping into grep: `grep -q` closes the
  # pipe on its first match, `unzip` dies of EPIPE, and `set -o pipefail` then reports
  # the whole pipeline as failed — which read as "already thin" and skipped the work.
  local listing; listing="$(unzip -l "$CONTAINER")"
  case "$listing" in
    *macos-*_*) ;;   # a fat slice dir, e.g. macos-arm64_x86_64
    *) echo "==> container already single-slice ($(du -h "$CONTAINER" | cut -f1)) — leaving it"
       return ;;
  esac
  # Staged next to the target, not in $TMPDIR: this moves ~400 MB around, and keeping it
  # on one volume makes the final install a rename instead of a copy.
  local work="$(dirname "$DEST")/.cel-thin"
  rm -rf "$work"; mkdir -p "$work"

  echo "==> thinning the grammar container to $ARCH"
  ( cd "$work" && unzip -q "$CONTAINER" )
  local xc="$work/CodeLanguagesContainer.xcframework"
  local slice; slice="$(ls "$xc" | grep '^macos-')"
  local bin="$xc/$slice/CodeLanguages_Container.framework/Versions/A/CodeLanguages_Container"
  echo "    before: $(lipo -archs "$bin") ($(du -h "$bin" | cut -f1))"

  lipo "$bin" -thin "$ARCH" -output "$bin.thin"
  mv "$bin.thin" "$bin"
  # The slice directory name and the plist must agree with the binary, or Xcode resolves
  # the xcframework against an architecture that is no longer in it.
  mv "$xc/$slice" "$xc/macos-$ARCH"
  /usr/libexec/PlistBuddy \
    -c "Set :AvailableLibraries:0:LibraryIdentifier macos-$ARCH" \
    -c "Delete :AvailableLibraries:0:SupportedArchitectures" \
    -c "Add :AvailableLibraries:0:SupportedArchitectures array" \
    -c "Add :AvailableLibraries:0:SupportedArchitectures:0 string $ARCH" \
    "$xc/Info.plist" >/dev/null
  bin="$xc/macos-$ARCH/CodeLanguages_Container.framework/Versions/A/CodeLanguages_Container"
  echo "    after:  $(lipo -archs "$bin") ($(du -h "$bin" | cut -f1))"

  # Build a fresh zip and move it into place: `zip` on the existing file would ADD the
  # thinned slice beside the fat one it can no longer see (the directory was renamed),
  # leaving a two-slice archive bigger than the one we started with. -y keeps the
  # framework's Versions/Current symlinks as symlinks; resolving them would duplicate
  # the archive inside the zip.
  ( cd "$work" && zip -qry container.zip CodeLanguagesContainer.xcframework )
  mv "$work/container.zip" "$CONTAINER"
  rm -rf "$work"
}
thin_container

# -L: in a worktree, vendor/CodeEditLanguages is a symlink to the main checkout (the
# worktree hook puts it there), and `du` on a symlink measures the link, not the tree.
echo "==> vendored CodeEditLanguages @ $TAG ($(du -shL "$DEST" | cut -f1)) at $(cd "$DEST" && pwd -P)"
