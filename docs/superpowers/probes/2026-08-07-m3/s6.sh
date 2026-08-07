#!/bin/bash
P="$1"; R="$P/repos/arch"; W="$P/wt6/task"
rm -rf "$R" "$P/repos/arch-origin.git" "$P/wt6"; mkdir -p "$P/wt6"
"$P/setup.sh" "$P/repos" arch main >/dev/null
"$P/cfg.sh" "$R"
# seed tracked files incl. one to delete, one gitignored pattern
cd "$R"
echo "keep" > keep.txt; echo "del-staged" > del-staged.txt; echo "del-unstaged" > del-unstaged.txt
echo "both" > both.txt; echo "unstaged" > unstaged.txt; echo "staged" > staged.txt
printf 'secret.env\nbuild/\n' > .gitignore
git add -A && git commit -q -m "seed" && git push -q origin main
git worktree add "$W" -b arch-task >/dev/null 2>&1

cd "$W"
# --- build the fixture ---
echo "STAGED EDIT" >> staged.txt;            git add staged.txt
echo "NEWLY ADDED" > added-staged.txt;        git add added-staged.txt
echo "UNSTAGED EDIT" >> unstaged.txt
echo "BOTH-staged" >> both.txt; git add both.txt; echo "BOTH-unstaged" >> both.txt
git rm -q del-staged.txt
rm del-unstaged.txt
echo "UNTRACKED" > untracked.txt
mkdir -p newdir && echo "UNTRACKED IN NEW DIR" > newdir/deep.txt
echo "SECRET=hunter2" > secret.env          # gitignored
mkdir -p build && echo "artifact" > build/out.o  # gitignored dir

echo "########## STATUS BEFORE ARCHIVE ##########"
git status --porcelain=v1 | sort | tee "$P/wt6/before.txt"
echo "--- ignored too ---"; git status --porcelain --ignored | grep '^!!' | sort
echo "--- checksums of every file on disk ---"
find . -type f -not -path './.git/*' | sort | xargs shasum | tee "$P/wt6/before-sums.txt"
