#!/bin/bash
# make a bare origin + a clone, with N commits
# usage: mkrepo <name> <default-branch>
set -e
ROOT="$1"; NAME="$2"; BR="${3:-main}"
G="git -c user.name=Probe -c user.email=probe@example.com -c commit.gpgsign=false -c init.defaultBranch=$BR"
mkdir -p "$ROOT"
$G init --bare "$ROOT/$NAME-origin.git" -b "$BR" >/dev/null
$G clone "$ROOT/$NAME-origin.git" "$ROOT/$NAME" 2>/dev/null
cd "$ROOT/$NAME"
echo "hello from $NAME" > README.md
mkdir -p src && echo "int main(){return 0;}" > src/main.c
$G add -A && $G commit -q -m "initial commit"
$G push -q -u origin "$BR"
echo "OK $ROOT/$NAME on $BR"
