#!/bin/bash
P="$1"; R="$P/repos/beta"
git -C "$R" branch local-only
rm -rf "$P/tmp-push"
git clone -q "$P/repos/beta-origin.git" "$P/tmp-push"
"$P/cfg.sh" "$P/tmp-push"
cd "$P/tmp-push"
git checkout -q -b remote-only
echo "REMOTE ONLY CONTENT" > remote-only.txt
git add -A && git commit -q -m "remote-only work" && git push -q origin remote-only
git -C "$R" fetch -q origin
echo "--- refs in beta ---"; git -C "$R" for-each-ref --format='%(refname)' | sort
echo; echo "--- origin/HEAD ---"; git -C "$R" symbolic-ref --short refs/remotes/origin/HEAD; echo "exit=$?"
