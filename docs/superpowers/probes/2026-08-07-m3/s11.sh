#!/bin/bash
P="$1"; R="$P/repos/alpha"; run(){ echo "\$ $*"; "$@" 2>&1; echo "  ==> exit=$?"; echo; }
rm -rf "$P/wt11"; mkdir -p "$P/wt11"
echo "########## A: prune-free rebuild via 'add --force' at the same path ##########"
run git -C "$R" worktree add "$P/wt11/w" -b pf1
rm -rf "$P/wt11/w"
echo "--- another worktree in the SAME repo is moved-but-not-repaired (must survive) ---"
git -C "$R" worktree add "$P/wt11/bystander" -b pf-by >/dev/null 2>&1
echo "PRECIOUS" >> "$P/wt11/bystander/README.md"; echo untr > "$P/wt11/bystander/u.txt"
mv "$P/wt11/bystander" "$P/wt11/bystander-moved"
run git -C "$R" worktree add --force "$P/wt11/w" pf1
echo "--- bystander registration survived? ---"
git -C "$R" worktree list --porcelain | grep -c "wt11/bystander" 
run git -C "$R" worktree repair "$P/wt11/bystander-moved"
echo "bystander work intact? $(tail -1 "$P/wt11/bystander-moved/README.md"); untracked: $(test -f "$P/wt11/bystander-moved/u.txt" && echo YES || echo NO)"

echo "########## B: detached-worktree archive/restore, MEASURED ##########"
AR="$P/repos/arch"; D="$P/wt11/det"
git -C "$AR" worktree add --detach "$D" HEAD >/dev/null 2>&1
ORIG=$(git -C "$D" rev-parse HEAD); echo "original detached HEAD = $ORIG"
echo "dirty" >> "$D/keep.txt"
ST=$(git -C "$D" write-tree); SC=$(git -C "$D" commit-tree "$ST" -p "$ORIG" -m "archive: staged")
IDX="$P/wt11/t.index"; rm -f "$IDX"; export GIT_INDEX_FILE="$IDX"
git -C "$D" read-tree "$ORIG"; git -C "$D" add -A
WT=$(git -C "$D" write-tree); WC=$(git -C "$D" commit-tree "$WT" -p "$SC" -m "archive: worktree")
unset GIT_INDEX_FILE; rm -f "$IDX"
git -C "$AR" update-ref refs/shepherd/archived-worktrees/det1 "$WC"
git -C "$AR" worktree remove --force "$D"
echo "-- restore (branch=\"\" so v1 SKIPS symbolic-ref) --"
run git -C "$AR" worktree add --detach "$D" "$WC"
git -C "$D" read-tree "$SC"
echo "HEAD after restore = $(git -C "$D" rev-parse HEAD)   (original was $ORIG)"
echo "$( [ "$(git -C "$D" rev-parse HEAD)" = "$ORIG" ] && echo 'MATCHES original' || echo 'DOES NOT MATCH -> HEAD is the ARCHIVE commit')"
echo "status:"; git -C "$D" status --porcelain
git -C "$AR" update-ref -d refs/shepherd/archived-worktrees/det1

echo "########## C: does 'git gc' auto-prune a moved worktree? ##########"
git -C "$R" worktree add "$P/wt11/gcw" -b gcw1 >/dev/null 2>&1
mv "$P/wt11/gcw" "$P/wt11/gcw-moved"
echo "gc.worktreePruneExpire = $(git -C "$R" config gc.worktreePruneExpire || echo '(unset -> default 3.months.ago)')"
run git -C "$R" gc --quiet
echo "registration after plain gc: $(git -C "$R" worktree list --porcelain | grep -c 'wt11/gcw')"
run git -C "$R" gc --prune=now --quiet
echo "registration after gc --prune=now: $(git -C "$R" worktree list --porcelain | grep -c 'wt11/gcw')"
run git -C "$R" -c gc.worktreePruneExpire=now gc --quiet
echo "registration after gc with worktreePruneExpire=now: $(git -C "$R" worktree list --porcelain | grep -c 'wt11/gcw')"
