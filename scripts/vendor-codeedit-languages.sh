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
set -euo pipefail

TAG="${CEL_TAG:-0.1.20}"
REPO="${CEL_REPO:-https://github.com/CodeEditApp/CodeEditLanguages}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/vendor/CodeEditLanguages"

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

echo "==> vendored CodeEditLanguages @ $TAG ($(du -sh "$DEST" | cut -f1)) at $DEST"
