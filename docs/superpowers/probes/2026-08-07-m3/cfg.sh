#!/bin/bash
for r in "$@"; do
  git -C "$r" config user.name Probe
  git -C "$r" config user.email probe@example.com
  git -C "$r" config commit.gpgsign false
done
