# 0010. Terminal theme from ~/.config/shepherd, not ~/.config/ghostty

Status: Accepted
Date: 2026-06-27

## Context
We theme the libghostty grid to match the SwiftUI chrome so the window reads as
one surface. The first cut loaded our base theme, then
`ghostty_config_load_default_files`, so a user's `~/.config/ghostty` would
override. But a user with `theme = carbonfox` then saw carbonfox in the grid and
our palette in the chrome (no cohesion), and it coupled Shepherd's look to
ghostty's config. We want Shepherd self-contained and configured on its own.

## Decision
Load a built-in base theme, then `~/.config/shepherd/config` (ghostty syntax) on
top; do **not** read `~/.config/ghostty`. libghostty only loads config from files
(there is no `..._load_string`), so `GhosttyApp.writeBaseTheme()` writes the base
theme to a temp file and loads it via `ghostty_config_load_file` before the
shepherd config. The base theme's background/foreground/palette mirror the
`Theme.swift` chrome tokens.

## Consequences
- A user's ghostty config no longer affects Shepherd; they configure it via
  `~/.config/shepherd/config` (e.g. `theme = <name>` or explicit colors), which
  overrides our base.
- Keep the base-theme string in sync with `Theme.swift` ([ADR 0009](0009-sidebar-custom-rows-not-list.md))
  so chrome and grid stay cohesive.
