#!/bin/bash
P="$1"; R="$P/repos/alpha"; W="$P/wt4"; mkdir -p "$W"
run(){ echo "\$ $*"; "$@" 2>&1; echo "  ==> exit=$?"; echo; }

echo "########## 4a: CLEAN tree ##########"
run git -C "$R" worktree add "$W/clean" -b r-clean
run git -C "$R" worktree remove "$W/clean"
echo "dir gone? $(test -d "$W/clean" && echo NO || echo YES)"; echo "branch: $(git -C "$R" branch --list r-clean)"; echo

echo "########## 4b: UNCOMMITTED changes (modified tracked file) ##########"
run git -C "$R" worktree add "$W/dirty" -b r-dirty
echo "modified" >> "$W/dirty/README.md"
run git -C "$R" worktree remove "$W/dirty"
echo "--- with --force ---"; run git -C "$R" worktree remove --force "$W/dirty"

echo "########## 4b2: UNTRACKED file only ##########"
run git -C "$R" worktree add "$W/untr" -b r-untr
echo scratch > "$W/untr/notes.txt"
run git -C "$R" worktree remove "$W/untr"
echo "--- untracked-only: did it refuse? (above) ---"
echo "--- 4b3: IGNORED file only ---"
run git -C "$R" worktree add "$W/ign" -b r-ign
echo "secret.env" > "$W/ign/.gitignore"; echo "KEY=1" > "$W/ign/secret.env"
git -C "$W/ign" add .gitignore && git -C "$W/ign" commit -q -m gitignore
run git -C "$R" worktree remove "$W/ign"
echo "dir gone? $(test -d "$W/ign" && echo NO || echo YES)   <-- did it delete an IGNORED file?"; echo

echo "########## 4c: directory already deleted BY HAND ##########"
run git -C "$R" worktree add "$W/vanished" -b r-vanish
rm -rf "$W/vanished"
run git -C "$R" worktree remove "$W/vanished"
run git -C "$R" worktree remove --force "$W/vanished"
run git -C "$R" worktree prune -v
echo "branch after prune: $(git -C "$R" branch --list r-vanish)  <-- prune does NOT delete branches"

echo "########## machine-readable staleness detection ##########"
run git -C "$R" worktree add "$W/stale2" -b r-stale2
rm -rf "$W/stale2"
echo "\$ git worktree list --porcelain"; git -C "$R" worktree list --porcelain | tail -8
