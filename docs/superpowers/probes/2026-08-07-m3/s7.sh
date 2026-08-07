#!/bin/bash
P="$1"; run(){ echo "\$ $*"; "$@" 2>&1; echo "  ==> exit=$?"; echo; }
export GIT_ALLOW_PROTOCOL=file; SUB="-c protocol.file.allow=always"
echo "########## 7a: SUBMODULES ##########"
rm -rf "$P/repos/super" "$P/repos/super-origin.git" "$P/wt7"; mkdir -p "$P/wt7"
"$P/setup.sh" "$P/repos" super main >/dev/null; "$P/cfg.sh" "$P/repos/super"
run git -C "$P/repos/super" -c protocol.file.allow=always submodule add "$P/repos/alpha-origin.git" libs/alpha
git -C "$P/repos/super" commit -q -m "add submodule"
echo "superproject files:"; ls "$P/repos/super/libs/alpha"
echo
echo "--- worktree add on a repo WITH a submodule ---"
run git -C "$P/repos/super" worktree add "$P/wt7/s1" -b sub-task
echo "is libs/alpha populated in the new worktree?"; ls -a "$P/wt7/s1/libs/alpha"; echo
echo "\$ git -C $P/wt7/s1 status --porcelain"; git -C "$P/wt7/s1" status --porcelain; echo "  ==> exit=$? (empty = clean; submodule reads as clean-but-EMPTY)"
echo
echo "--- must init explicitly ---"
run git -C "$P/wt7/s1" -c protocol.file.allow=always submodule update --init --recursive
echo "now populated?"; ls "$P/wt7/s1/libs/alpha"
echo "where is the submodule's git dir?"; cat "$P/wt7/s1/libs/alpha/.git"
echo
echo "--- does worktree remove refuse on a populated submodule? ---"
run git -C "$P/repos/super" worktree remove "$P/wt7/s1"
run git -C "$P/repos/super" worktree remove --force "$P/wt7/s1"
echo "dir gone? $(test -d "$P/wt7/s1" && echo NO || echo YES)"
echo "leftover submodule gitdir in superproject?"; ls "$P/repos/super/.git/modules" 2>&1
echo "leftover worktree gitdir for the SUBMODULE?"; ls "$P/repos/super/.git/worktrees" 2>&1

echo; echo "########## 7b: WORKTREE OF A WORKTREE ##########"
run git -C "$P/repos/gamma" worktree add "$P/wt7/w1" -b nest1
run git -C "$P/wt7/w1" worktree add "$P/wt7/w2" -b nest2
echo "--- where did w2 register? ---"; cat "$P/wt7/w2/.git"
echo "--- gamma's worktree list ---"; git -C "$P/repos/gamma" worktree list | grep -E "w1|w2"
echo "--- and from w1's view ---"; git -C "$P/wt7/w1" worktree list | grep -E "w1|w2"
echo "CONCLUSION: linked worktrees are FLAT — w2 registers on the common repo, not on w1."
echo
echo "--- removing w1 while w2 exists ---"
run git -C "$P/repos/gamma" worktree remove "$P/wt7/w1"
echo "w2 still functional? $(git -C "$P/wt7/w2" status --porcelain >/dev/null 2>&1 && echo YES || echo NO)"
