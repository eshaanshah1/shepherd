#!/bin/bash
P="$1"; R="$P/repos/beta"; W="$P/wt2"; mkdir -p "$W"
run(){ echo "\$ $*"; "$@" 2>&1; echo "  ==> exit=$?"; echo; }

echo "########## (a) branch exists LOCALLY — v1 path ##########"
echo "probe: git show-ref --verify --quiet refs/heads/local-only"; git -C "$R" show-ref --verify --quiet refs/heads/local-only; echo "  ==> exit=$? (0 = exists)"
run git -C "$R" worktree add "$W/a" local-only
echo "HEAD: $(git -C "$W/a" branch --show-current 2>/dev/null)"; ls "$W/a"

echo "########## (b) branch exists ONLY ON ORIGIN ##########"
echo "probe: git show-ref --verify --quiet refs/heads/remote-only"; git -C "$R" show-ref --verify --quiet refs/heads/remote-only; echo "  ==> exit=$? (nonzero = v1 thinks it does not exist)"
echo "--- b1: v1's ACTUAL args: -b remote-only origin/master ---"
run git -C "$R" worktree add "$W/b1" -b remote-only origin/master
echo "branch: $(git -C "$W/b1" branch --show-current)"; echo "files:"; ls "$W/b1"
echo "does it contain remote-only.txt?"; test -f "$W/b1/remote-only.txt" && echo YES || echo "NO  <-- content of origin/remote-only was NOT used"
echo "upstream: $(git -C "$W/b1" rev-parse --abbrev-ref '@{u}' 2>&1)"
echo
echo "--- b2: git DWIM (no -b), on a FRESH repo copy ---"
rm -rf "$P/repos/beta2"; git clone -q "$P/repos/beta-origin.git" "$P/repos/beta2"; "$P/cfg.sh" "$P/repos/beta2"
run git -C "$P/repos/beta2" worktree add "$W/b2" remote-only
echo "branch: $(git -C "$W/b2" branch --show-current)"; ls "$W/b2"
echo "upstream: $(git -C "$W/b2" rev-parse --abbrev-ref '@{u}' 2>&1)"

echo "########## (c) branch does NOT exist anywhere ##########"
run git -C "$R" worktree add "$W/c" -b brand-new origin/master
echo "--- c2: DWIM with a nonexistent name (no -b) ---"
run git -C "$R" worktree add "$W/c2" no-such-branch

echo "########## (d) branch exists locally but is CHECKED OUT elsewhere ##########"
echo "fix-login is checked out at $P/tasks/fix-login/beta"
run git -C "$R" worktree add "$W/d" fix-login
echo "--- d2: same, with --force ---"
run git -C "$R" worktree add --force "$W/d2" fix-login
echo "--- d3: -b onto an EXISTING branch name ---"
run git -C "$R" worktree add "$W/d3" -b local-only origin/master
