#!/bin/bash
P="$1"; R="$P/repos/gamma"; run(){ echo "\$ $*"; "$@" 2>&1; echo "  ==> exit=$?"; echo; }
mkdir -p "$P/wt10/full"; echo junk > "$P/wt10/full/j.txt"
echo "### can ANY force flag make worktree add reuse a NON-EMPTY dir? ###"
run git -C "$R" worktree add --force --force "$P/wt10/full" -b ff1
echo "### cheapest correct recovery = rm the dir (or add to a fresh path) ###"
rm -rf "$P/wt10/full"
run git -C "$R" worktree add "$P/wt10/full" -b ff2
echo "### does 'worktree add' create MISSING PARENT dirs? ###"
run git -C "$R" worktree add "$P/wt10/a/b/c/d" -b deep1
echo "### DWIM: 'worktree add <path>' with NO branch arg ###"
run git -C "$R" worktree add "$P/wt10/dwim"
echo "branch created: $(git -C "$P/wt10/dwim" branch --show-current)  <-- derived from the PATH BASENAME"
run git -C "$R" worktree add "$P/wt10/dwim2"
echo "### add --detach + later attach (what restore does) ###"
run git -C "$R" worktree add --detach "$P/wt10/det" HEAD
echo "### hardlinks? is a worktree checkout a real copy? ###"
echo "inode of repo README:  $(stat -f %i "$R/README.md")"
echo "inode of wt   README:  $(stat -f %i "$P/wt10/dwim/README.md")"
