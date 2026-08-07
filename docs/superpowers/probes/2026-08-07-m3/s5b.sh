#!/bin/bash
P="$1"; T="$P/tasks/recon"; T2="$P/tasks/recon-renamed"
run(){ echo "\$ $*"; "$@" 2>&1; echo "  ==> exit=$?"; echo; }
echo "### put uncommitted work in beta, then MOVE the whole task folder (slug rename) ###"
echo "PRECIOUS UNCOMMITTED" >> "$T/beta/README.md"; echo untracked > "$T/beta/scratch.txt"
run mv "$T" "$T2"
echo "--- git status inside the moved worktree ---"
echo "\$ git -C $T2/beta status --porcelain"; git -C "$T2/beta" status --porcelain 2>&1; echo "  ==> exit=$?"
echo
echo "--- worktree list from the repo (stale paths) ---"; git -C "$P/repos/beta" worktree list
echo
echo "### git worktree repair, run FROM the moved worktree ###"
run git -C "$T2/beta" worktree repair
echo "--- list after repair ---"; git -C "$P/repos/beta" worktree list
echo "--- uncommitted work intact? ---"; tail -1 "$T2/beta/README.md"; test -f "$T2/beta/scratch.txt" && echo "untracked PRESENT" || echo "untracked GONE"
echo
echo "### repair ALL at once from the repo side, passing new paths ###"
run git -C "$P/repos/alpha" worktree repair "$T2/alpha"
run git -C "$P/repos/gamma" worktree repair "$T2/gamma"
for r in alpha beta gamma; do echo "[$r]"; git -C "$P/repos/$r" worktree list | grep recon; done
echo
echo "### what if the MAIN REPO moves instead? ###"
mv "$P/repos/gamma" "$P/repos/gamma-moved"
echo "\$ git -C $T2/gamma status"; git -C "$T2/gamma" status --porcelain 2>&1; echo "  ==> exit=$?"
run git -C "$P/repos/gamma-moved" worktree repair
echo "\$ git -C $T2/gamma status (after repair from main repo)"; git -C "$T2/gamma" status --porcelain 2>&1; echo "  ==> exit=$?"
mv "$P/repos/gamma-moved" "$P/repos/gamma"; git -C "$P/repos/gamma" worktree repair >/dev/null 2>&1
