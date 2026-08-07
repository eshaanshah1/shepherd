#!/bin/bash
P="$1"; T="$P/tasks/recon"; mkdir -p "$T"
run(){ echo "\$ $*"; "$@" 2>&1; echo "  ==> exit=$?"; echo; }
for r in alpha beta gamma; do git -C "$P/repos/$r" worktree add "$T/$r" -b recon-task >/dev/null 2>&1; done
echo "created:"; ls "$T"
# do some work: commit in alpha, uncommitted in beta
echo "committed work" >> "$T/alpha/README.md"; git -C "$T/alpha" commit -qam "task work"
echo "UNCOMMITTED" >> "$T/beta/README.md"; echo untracked > "$T/beta/scratch.txt"
echo; echo "########## nuke the whole task folder ##########"
run rm -rf "$T"
echo "--- what git thinks now ---"
for r in alpha beta gamma; do echo "[$r] $(git -C "$P/repos/$r" worktree list --porcelain | grep -A3 "tasks/recon" | grep prunable || echo 'no prunable line')"; done
echo
echo "########## REBUILD from the (simulated) SQLite record: {repo, branch, dest} ##########"
START=$(python3 -c 'import time;print(time.time())')
for r in alpha beta gamma; do
  git -C "$P/repos/$r" worktree prune
  git -C "$P/repos/$r" worktree add "$T/$r" recon-task 2>&1 | sed "s/^/[$r] /"
done
END=$(python3 -c 'import time;print(time.time())')
python3 -c "print('rebuild of 3 worktrees: %.2fs' % ($END-$START))"
echo "--- verify ---"
echo "alpha README (committed work survived?):"; tail -1 "$T/alpha/README.md"
echo "beta README (uncommitted work?):"; tail -1 "$T/beta/README.md"
echo "beta scratch.txt (untracked?):"; test -f "$T/beta/scratch.txt" && echo PRESENT || echo "GONE  <-- unrecoverable"
echo "beta status:"; git -C "$T/beta" status --porcelain; echo "(empty = clean)"
