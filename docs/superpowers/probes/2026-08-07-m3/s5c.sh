#!/bin/bash
P="$1"; R="$P/repos/alpha"
run(){ echo "\$ $*"; "$@" 2>&1; echo "  ==> exit=$?"; echo; }
echo "### DANGER TEST: move a worktree with live work, then run prune BEFORE repair ###"
rm -rf "$P/wt5"; mkdir -p "$P/wt5"
run git -C "$R" worktree add "$P/wt5/orig" -b danger
echo "PRECIOUS" >> "$P/wt5/orig/README.md"; echo untracked > "$P/wt5/orig/scratch.txt"
mv "$P/wt5/orig" "$P/wt5/moved"
echo "--- list (before prune) ---"; git -C "$R" worktree list | grep -E "wt5|danger"
run git -C "$R" worktree prune -v
echo "--- list (after prune) ---"; git -C "$R" worktree list | grep -E "wt5|danger" || echo "(registration GONE)"
echo "--- does the moved dir still work as a git repo? ---"
echo "\$ git -C $P/wt5/moved status --porcelain"; git -C "$P/wt5/moved" status --porcelain 2>&1; echo "  ==> exit=$?"
echo "--- files still on disk? ---"; ls "$P/wt5/moved"; tail -1 "$P/wt5/moved/README.md"
echo "--- can repair rescue it after prune? ---"
run git -C "$P/wt5/moved" worktree repair
run git -C "$R" worktree repair "$P/wt5/moved"
echo "--- list ---"; git -C "$R" worktree list | grep -E "wt5|danger" || echo "(still gone)"
echo "--- recovery: re-add the branch at the new path ---"
mv "$P/wt5/moved" "$P/wt5/rescue-backup"
run git -C "$R" worktree add "$P/wt5/moved" danger
echo "branch 'danger' commits intact? $(git -C "$R" log --oneline danger | head -1)"
