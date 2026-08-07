#!/bin/bash
P="$1"; R="$P/repos/alpha"; W="$P/wt4"
run(){ echo "\$ $*"; "$@" 2>&1; echo "  ==> exit=$?"; echo; }
echo "### v1 uses 'worktree remove --force' — does it handle a VANISHED dir? ###"
run git -C "$R" worktree add "$W/v2" -b r-v2
rm -rf "$W/v2"
run git -C "$R" worktree remove --force "$W/v2"
echo "registration still present?"; git -C "$R" worktree list --porcelain | grep -c "wt4/v2"
echo
echo "### and does plain remove handle it? ###"
run git -C "$R" worktree remove "$W/v2"
echo "registration now?"; git -C "$R" worktree list --porcelain | grep -c "wt4/v2"
echo
echo "### 'remove' on a LOCKED worktree ###"
run git -C "$R" worktree add "$W/locked" -b r-locked
run git -C "$R" worktree lock "$W/locked" --reason "task running"
run git -C "$R" worktree remove "$W/locked"
run git -C "$R" worktree remove --force "$W/locked"
run git -C "$R" worktree remove --force --force "$W/locked"
echo "### does prune skip a locked-but-vanished worktree? ###"
run git -C "$R" worktree add "$W/lv" -b r-lv
run git -C "$R" worktree lock "$W/lv"
rm -rf "$W/lv"
run git -C "$R" worktree prune -v
echo "still registered? $(git -C "$R" worktree list --porcelain | grep -c 'wt4/lv')"
