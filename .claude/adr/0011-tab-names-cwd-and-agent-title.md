# 0011. Tab names: cwd for shells, the agent's own title for agent tabs

Status: Accepted
Date: 2026-06-27

## Context
A shell sets the terminal's OSC title to `user@host[:cwd]` — noise the user never
wants as a tab name ("I never want to see that again"). But a running agent
(Claude) sets a meaningful OSC title for what it's doing, which we DO want —
T3-style, where rows are named by task, not by directory.

## Decision
`Agent.displayTitle` priority:
1. `userTitle` (an explicit rename) — always wins.
2. If the tab is an agent (`state != .shell`) and it set a non-empty OSC title,
   use that title.
3. Otherwise the cwd: home → `~`, child of home → `~/dir`, else `parent/dir`.

We never use the OSC title for a plain shell. `SessionStart` clears the stale
shell title so an agent tab never flashes `user@host` before Claude titles it.

## Consequences
- Agent tab names depend on Claude setting a useful OSC title; if it sets the cwd
  itself, we show the cwd (no worse than before). Revisit with an explicit label
  (e.g. `Claude · <dir>`) if that proves unhelpful.
- Don't reintroduce the shell OSC title as a shell tab's name — that's the
  `user@host` regression this exists to prevent.
