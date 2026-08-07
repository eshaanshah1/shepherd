#!/bin/bash
P="$1"; R="$P/repos/beta"; W="$P/wt2"
echo "########## consequence of v1's wrong upstream (b1) ##########"
cd "$W/b1"; echo "oops" >> README.md; git add -A; git commit -q -m "work on remote-only"
echo "push.default = $(git config push.default || echo '(unset -> simple)')"
echo "\$ git push (dry-run)"; git push --dry-run 2>&1; echo "  ==> exit=$?"

echo; echo "########## origin/HEAD MISSING — v1 defaultBaseRef fallback ##########"
rm -rf "$P/repos/nohead"; git clone -q "$P/repos/alpha-origin.git" "$P/repos/nohead"; "$P/cfg.sh" "$P/repos/nohead"
git -C "$P/repos/nohead" remote set-head origin -d
echo "\$ git symbolic-ref --short refs/remotes/origin/HEAD"; git -C "$P/repos/nohead" symbolic-ref --short refs/remotes/origin/HEAD 2>&1; echo "  ==> exit=$?"
echo "\$ git remote set-head origin --auto  (v1's recovery; NETWORK round-trip)"; git -C "$P/repos/nohead" remote set-head origin --auto 2>&1; echo "  ==> exit=$?"
echo "re-read: $(git -C "$P/repos/nohead" symbolic-ref --short refs/remotes/origin/HEAD 2>&1)"

echo; echo "########## repo with NO REMOTE AT ALL (a task on a local-only repo) ##########"
rm -rf "$P/repos/noremote"; mkdir -p "$P/repos/noremote"; git -C "$P/repos/noremote" init -q -b main; "$P/cfg.sh" "$P/repos/noremote"
echo hi > "$P/repos/noremote/f.txt"; git -C "$P/repos/noremote" add -A; git -C "$P/repos/noremote" commit -q -m init
echo "\$ git fetch origin  (v1 REQUIRES this to succeed)"; git -C "$P/repos/noremote" fetch origin 2>&1; echo "  ==> exit=$?"
echo "\$ git symbolic-ref --short refs/remotes/origin/HEAD"; git -C "$P/repos/noremote" symbolic-ref --short refs/remotes/origin/HEAD 2>&1; echo "  ==> exit=$?"
echo "\$ git remote set-head origin --auto"; git -C "$P/repos/noremote" remote set-head origin --auto 2>&1; echo "  ==> exit=$?"
echo "\$ v1 fallback: worktree add ... -b x origin/main"; git -C "$P/repos/noremote" worktree add "$W/nr" -b x origin/main 2>&1; echo "  ==> exit=$?"
echo "\$ correct: worktree add ... -b x HEAD"; git -C "$P/repos/noremote" worktree add "$W/nr" -b x HEAD 2>&1; echo "  ==> exit=$?"
