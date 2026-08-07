#!/bin/bash
P="$1"; R="$P/repos/arch"; W="$P/wt6/task"; ID="probe123"
REF="refs/shepherd/archived-worktrees/$ID"
run(){ echo "\$ $*"; "$@" 2>&1; echo "  ==> exit=$?"; }
HEAD_SHA=$(git -C "$W" rev-parse HEAD)
BRANCH=$(git -C "$W" branch --show-current)
echo "HEAD=$HEAD_SHA branch=$BRANCH"; echo

echo "########## ARCHIVE (v1 algorithm, verbatim) ##########"
STAGED_TREE=$(git -C "$W" write-tree); echo "1. write-tree (staged)      -> $STAGED_TREE"
STAGED_COMMIT=$(git -C "$W" commit-tree "$STAGED_TREE" -p "$HEAD_SHA" -m "shepherd-archive: staged"); echo "2. commit-tree (staged)     -> $STAGED_COMMIT"
TMPIDX="$P/wt6/tmp.index"; rm -f "$TMPIDX"
export GIT_INDEX_FILE="$TMPIDX"
run git -C "$W" read-tree "$HEAD_SHA"
run git -C "$W" add -A
WT_TREE=$(git -C "$W" write-tree); echo "6. write-tree (worktree)    -> $WT_TREE"
WT_COMMIT=$(git -C "$W" commit-tree "$WT_TREE" -p "$STAGED_COMMIT" -m "shepherd-archive: worktree"); echo "7. commit-tree (worktree)   -> $WT_COMMIT"
unset GIT_INDEX_FILE; rm -f "$TMPIDX"
echo; echo "--- WHAT THE SNAPSHOT COMMITS ACTUALLY CONTAIN ---"
echo "[staged tree $STAGED_TREE]"; git -C "$R" ls-tree -r --name-only "$STAGED_TREE" | sort
echo "[worktree tree $WT_TREE]"; git -C "$R" ls-tree -r --name-only "$WT_TREE" | sort
echo
run git -C "$R" update-ref "$REF" "$WT_COMMIT"
run git -C "$R" worktree remove --force "$W"
echo "dir gone? $(test -d "$W" && echo NO || echo YES)"
echo "--- were the GITIGNORED files taken with it? ---"; test -f "$W/secret.env" && echo "secret.env still there" || echo "secret.env DELETED"
echo

echo "########## RESTORE (v1 algorithm, verbatim) ##########"
WTC=$(git -C "$R" rev-parse --verify --quiet "$REF"); echo "wtCommit=$WTC"
STG=$(git -C "$R" rev-parse "$REF^"); echo "staged  =$STG"
run git -C "$R" worktree add --detach "$W" "$WTC"
run git -C "$R" show-ref --verify --quiet "refs/heads/$BRANCH"
run git -C "$W" symbolic-ref HEAD "refs/heads/$BRANCH"
run git -C "$W" read-tree "$STG"
run git -C "$R" update-ref -d "$REF"
echo
echo "########## STATUS AFTER RESTORE ##########"
git -C "$W" status --porcelain=v1 | sort | tee "$P/wt6/after.txt"
echo; echo "########## DIFF: before vs after ##########"
diff "$P/wt6/before.txt" "$P/wt6/after.txt" && echo "IDENTICAL"
echo; echo "########## FILE CHECKSUMS: before vs after ##########"
cd "$W"; find . -type f -not -path './.git/*' | sort | xargs shasum > "$P/wt6/after-sums.txt"
diff "$P/wt6/before-sums.txt" "$P/wt6/after-sums.txt" && echo "IDENTICAL"
echo; echo "--- branch/HEAD after restore ---"
echo "branch: $(git -C "$W" branch --show-current)"; echo "HEAD:   $(git -C "$W" rev-parse HEAD) (orig $HEAD_SHA)"
