#!/bin/bash
P="$1"
echo "### clone the real shepherd repo into scratch (source untouched) ###"
rm -rf "$P/repos/medium"
/usr/bin/time -p git clone -q --no-checkout /Users/eshaan/Home/dev/shepherd "$P/repos/medium" 2>&1 | tail -3 || \
/usr/bin/time -p git clone -q --no-checkout /Users/eshaan/.shepherd/worktrees/shepherd/fable-electron-refactor "$P/repos/medium" 2>&1 | tail -3
cd "$P/repos/medium" && git checkout -q 2>/dev/null
"$P/cfg.sh" "$P/repos/medium"
echo "tracked files: $(git -C "$P/repos/medium" ls-files | wc -l)"
echo "checkout size: $(du -sh "$P/repos/medium" | cut -f1)  (.git: $(du -sh "$P/repos/medium/.git" | cut -f1))"
echo
echo "### time 3 sequential worktree adds ###"
rm -rf "$P/wt8"; mkdir -p "$P/wt8"
for i in 1 2 3; do
  S=$(python3 -c 'import time;print(time.time())')
  git -C "$P/repos/medium" worktree add "$P/wt8/m$i" -b "perf$i" >/dev/null 2>&1
  E=$(python3 -c 'import time;print(time.time())')
  python3 -c "print('  worktree add #$i: %.2fs' % ($E-$S))"
done
echo "total on-disk cost of 3 worktrees: $(du -sh "$P/wt8" | cut -f1)"
echo
echo "### same 3, in PARALLEL ###"
rm -rf "$P/wt8p"; mkdir -p "$P/wt8p"
S=$(python3 -c 'import time;print(time.time())')
for i in 1 2 3; do git -C "$P/repos/medium" worktree add "$P/wt8p/m$i" -b "par8$i" >/dev/null 2>&1 & done; wait
E=$(python3 -c 'import time;print(time.time())')
python3 -c "print('  3 in parallel: %.2fs' % ($E-$S))"
echo
echo "### removal timing ###"
S=$(python3 -c 'import time;print(time.time())')
for i in 1 2 3; do git -C "$P/repos/medium" worktree remove --force "$P/wt8/m$i"; done
E=$(python3 -c 'import time;print(time.time())')
python3 -c "print('  3 removes: %.2fs' % ($E-$S))"
echo
echo "### a SYNTHETIC bigger checkout (20k files) for the upper bound ###"
rm -rf "$P/repos/big"; mkdir -p "$P/repos/big"; git -C "$P/repos/big" init -q -b main; "$P/cfg.sh" "$P/repos/big"
python3 - <<PY
import os
base="$P/repos/big"
for d in range(200):
    dd=os.path.join(base,f"d{d}"); os.makedirs(dd,exist_ok=True)
    for f in range(100):
        open(os.path.join(dd,f"f{f}.txt"),"w").write("x"*400)
PY
git -C "$P/repos/big" add -A >/dev/null; git -C "$P/repos/big" commit -q -m big
echo "files: $(git -C "$P/repos/big" ls-files | wc -l), size: $(du -sh "$P/repos/big" | cut -f1)"
S=$(python3 -c 'import time;print(time.time())')
git -C "$P/repos/big" worktree add "$P/wt8/big1" -b big1 >/dev/null 2>&1
E=$(python3 -c 'import time;print(time.time())')
python3 -c "print('  20k-file worktree add: %.2fs' % ($E-$S))"
