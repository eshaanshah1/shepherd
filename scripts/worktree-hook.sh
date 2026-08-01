# Shepherd worktree hook — paste into Settings → Workspaces → worktree hook.
# Runs after `git worktree add`, cwd = the new worktree.
# Links the gitignored heavy/secret deps so xcodegen + the Android build work immediately.
set -u

mkdir -p "$WORKTREE_DIR/vendor"
for d in GhosttyKit.xcframework CodeEditLanguages; do
  if [ -e "$WORKTREE_SRC/vendor/$d" ]; then
    ln -sfn "$WORKTREE_SRC/vendor/$d" "$WORKTREE_DIR/vendor/$d"
    echo "linked vendor/$d"
  else
    echo "WARN: $WORKTREE_SRC/vendor/$d missing — build it in the main checkout first"
  fi
done

# Android: gitignored Firebase config, without which :app:processDebugGoogleServices fails.
if [ -f "$WORKTREE_SRC/android/app/google-services.json" ]; then
  mkdir -p "$WORKTREE_DIR/android/app"
  ln -sfn "$WORKTREE_SRC/android/app/google-services.json" \
          "$WORKTREE_DIR/android/app/google-services.json"
  echo "linked android/app/google-services.json"
fi
