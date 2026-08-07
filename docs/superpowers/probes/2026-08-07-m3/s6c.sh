#!/bin/bash
P="$1"; R="$P/repos/arch"; W="$P/wt6/conf"
run(){ echo "\$ $*"; "$@" 2>&1; echo "  ==> exit=$?"; echo; }
echo "########## archive step 1 (write-tree) on a CONFLICTED index ##########"
git -C "$R" worktree add "$W" -b conf-task >/dev/null 2>&1
cd "$W"
echo "SIDE A" > conflict.txt; git add -A; git commit -q -m "A"
git checkout -q -b other HEAD~1 2>/dev/null || git checkout -q -b other main
echo "SIDE B" > conflict.txt; git add -A; git commit -q -m "B"
git merge conf-task >/dev/null 2>&1
echo "--- unmerged? ---"; git ls-files -u | head -3; git status --porcelain | head -3
run git -C "$W" write-tree
echo "  ^^ v1's archiveWorktree ABORTS here — the archive path cannot snapshot a conflicted worktree"
git merge --abort 2>/dev/null; git checkout -q conf-task
cd "$P"; git -C "$R" worktree remove --force "$W"

echo "########## v1 archive on a DETACHED worktree ##########"
git -C "$R" worktree add --detach "$P/wt6/det" >/dev/null 2>&1
echo "b" >> "$P/wt6/det/keep.txt"
echo "branch --show-current: '$(git -C "$P/wt6/det" branch --show-current)'  (empty = detached; v1 stores branch=\"\")"
echo "  -> restore then SKIPS symbolic-ref, worktree stays detached at the ARCHIVE commit, not the original HEAD"
git -C "$R" worktree remove --force "$P/wt6/det"

echo "########## does gc reclaim an UNPINNED archive commit? (why the ref exists) ##########"
cd "$R"
T=$(git -C "$R" hash-object -w -t blob /dev/null)
C=$(git -C "$R" commit-tree "$(git -C "$R" rev-parse HEAD^{tree})" -p HEAD -m "unpinned")
echo "unpinned commit: $C"
run git -C "$R" gc --prune=now --quiet
echo "\$ git cat-file -t $C"; git -C "$R" cat-file -t "$C" 2>&1; echo "  ==> exit=$? (128/failure = reclaimed)"
echo "--- and a PINNED one survives gc ---"
C2=$(git -C "$R" commit-tree "$(git -C "$R" rev-parse HEAD^{tree})" -p HEAD -m "pinned")
git -C "$R" update-ref refs/shepherd/archived-worktrees/pin1 "$C2"
git -C "$R" gc --prune=now --quiet
echo "\$ git cat-file -t $C2"; git -C "$R" cat-file -t "$C2" 2>&1; echo "  ==> exit=$?"
echo "--- is the ref included in a push/fetch by default? ---"
run git -C "$R" push --dry-run origin "refs/shepherd/*:refs/shepherd/*"
