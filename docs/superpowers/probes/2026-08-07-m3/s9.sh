#!/bin/bash
P="$1"; run(){ echo "\$ $*"; "$@" 2>&1; echo "  ==> exit=$?"; echo; }
echo "### the REAL cost in v1's path is the network fetch it does first ###"
URL=$(git -C /Users/eshaan/Home/dev/shepherd remote get-url origin 2>/dev/null || echo "(none)")
echo "real repo origin: $URL"
S=$(python3 -c 'import time;print(time.time())')
git ls-remote "$URL" HEAD >/dev/null 2>&1; RC=$?
E=$(python3 -c 'import time;print(time.time())')
python3 -c "print('  network ls-remote (proxy for v1 git fetch origin): %.2fs  exit=$RC' % ($E-$S))"
echo
echo "### does worktree repair work on a repo WITH submodules (rename path)? ###"
git -C "$P/repos/super" worktree add "$P/wt7/s2" -b sub2 >/dev/null 2>&1
git -C "$P/wt7/s2" -c protocol.file.allow=always submodule update --init >/dev/null 2>&1
run git -C "$P/repos/super" worktree move "$P/wt7/s2" "$P/wt7/s2-moved"
mv "$P/wt7/s2" "$P/wt7/s2-moved"
run git -C "$P/wt7/s2-moved" worktree repair
echo "superproject status in moved worktree:"; git -C "$P/wt7/s2-moved" status --porcelain 2>&1 | head -3
echo "submodule still resolvable?"; git -C "$P/wt7/s2-moved/libs/alpha" status --porcelain 2>&1 | head -2; echo "  ==> exit=$?"
echo
echo "### does a stale-registration prune LOSE the branch? (no) and are branches shared? ###"
echo "branches in gamma visible from every worktree (refs are COMMON):"
git -C "$P/repos/gamma" branch --list | tr -d ' ' | tr '\n' ' '; echo
echo
echo "### concurrent index: two worktrees of the SAME repo committing at once ###"
rm -rf "$P/wt9"; mkdir -p "$P/wt9"
git -C "$P/repos/gamma" worktree add "$P/wt9/c1" -b cc1 >/dev/null 2>&1
git -C "$P/repos/gamma" worktree add "$P/wt9/c2" -b cc2 >/dev/null 2>&1
for i in 1 2; do ( echo "x$i" > "$P/wt9/c$i/f.txt"; git -C "$P/wt9/c$i" add -A; git -C "$P/wt9/c$i" commit -q -m "c$i"; echo "c$i exit=$?" ) & done; wait
echo "separate indexes? $(ls $P/repos/gamma/.git/worktrees/c1/index $P/repos/gamma/.git/worktrees/c2/index 2>&1 | wc -l) index files"
git -C "$P/repos/gamma" log --oneline cc1 | head -1; git -C "$P/repos/gamma" log --oneline cc2 | head -1
echo
echo "### is HEAD per-worktree and config shared? ###"
echo "c1 HEAD file: $(cat $P/repos/gamma/.git/worktrees/c1/HEAD)"
echo "c2 HEAD file: $(cat $P/repos/gamma/.git/worktrees/c2/HEAD)"
git -C "$P/wt9/c1" config --worktree --list 2>&1 | head -2
echo "extensions.worktreeConfig set? $(git -C $P/repos/gamma config extensions.worktreeConfig || echo 'no (per-worktree config needs it)')"
