#!/bin/bash
P="$1"; R="$P/repos/gamma"; W="$P/wt3"; mkdir -p "$W"
run(){ echo "\$ $*"; "$@" 2>&1; echo "  ==> exit=$?"; echo; }

echo "########## 3a: dest dir EXISTS and is EMPTY ##########"
mkdir -p "$W/empty"
run git -C "$R" worktree add "$W/empty" -b t-empty

echo "########## 3b: dest dir EXISTS and is NON-EMPTY ##########"
mkdir -p "$W/full"; echo junk > "$W/full/junk.txt"
run git -C "$R" worktree add "$W/full" -b t-full
echo "--- with --force ---"
run git -C "$R" worktree add --force "$W/full" -b t-full2
echo "did junk.txt survive --force?"; ls -a "$W/full"; echo

echo "########## 3c: STALE REGISTRATION (dir rm -rf'd by hand) ##########"
run git -C "$R" worktree add "$W/crashed" -b t-crash
rm -rf "$W/crashed"
echo "--- worktree list after manual delete ---"; git -C "$R" worktree list; echo
echo "--- metadata dir still there? ---"; ls "$R/.git/worktrees"; echo
echo "--- re-add at the SAME path, same branch ---"
run git -C "$R" worktree add "$W/crashed" t-crash
echo "--- what does prune fix? ---"
run git -C "$R" worktree prune -v
run git -C "$R" worktree add "$W/crashed" t-crash
echo "--- after prune, is the BRANCH still there? ---"; git -C "$R" branch --list t-crash; echo
echo "--- so: re-add branch t-crash now ---"
run git -C "$R" worktree add "$W/crashed" t-crash

echo "########## 3d: HALF-CREATED (metadata exists, dir exists but empty) ##########"
run git -C "$R" worktree add "$W/half" -b t-half
rm -rf "$W/half"/*; rm -rf "$W/half"/.git
echo "--- worktree list ---"; git -C "$R" worktree list; echo
run git -C "$R" worktree prune -v
echo "--- list after prune ---"; git -C "$R" worktree list
