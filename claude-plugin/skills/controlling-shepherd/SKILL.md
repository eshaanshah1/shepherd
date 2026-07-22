---
name: controlling-shepherd
description: Use when running inside a Shepherd terminal pane and you need to drive the terminal itself — spawn or command other panes/agents, split/focus/zoom/close panes, create/switch/rename workspaces or tabs, read another pane's output, change Shepherd config, or orchestrate parallel agents across panes.
---

# Controlling Shepherd

## Overview

Shepherd is an agent-native macOS terminal. From inside a pane you can drive the
whole app with the **`shepherd`** CLI, which speaks to the running app over a
local unix socket. This lets you spawn helper panes, command other agents, read
their output, and reconfigure the terminal — without the user touching the
keyboard.

## First: confirm the channel

```sh
shepherd ping      # -> pong  (channel live)
```
If `shepherd` is missing or `ping` hangs/fails, the control channel isn't
available in this pane (the running app may predate it, or `$SHEPHERD_CTL_SOCK`
is unset) — fall back to asking the user, don't guess.

Panes/tabs/workspaces are addressed by **handles** — `p1`/`t1`/`ws1` from
`shepherd ls`; `shepherd whoami` gives your own. Raw UUIDs also work.

## Quick reference

| Command | Does |
|---|---|
| `shepherd ls` | workspace → tab → pane tree with handles + state |
| `shepherd whoami` | your own handles: `pane tab workspace` |
| `shepherd state <p>` | one pane's agent state (bare word) |
| `shepherd tab new [<ws>]` | new tab; prints the **new pane handle** |
| `shepherd pane split <p> [--down]` | split right, or down; prints the **new pane handle** |
| `shepherd focus <p>` / `zoom <p>` / `pane close <p> [--force]` | focus / zoom / close |
| `shepherd workspace new\|rename <ws> <name>\|switch <ws>\|rm <ws> [--force]` | workspace CRUD |
| `shepherd tab rename\|switch\|close <t> [--force\|--archive]` | tab ops |
| `shepherd tell <p> "text" [--no-enter]` | type text (+Enter) into a pane |
| `shepherd view <p> [--lines N] [--raw]` | read a pane's output |
| `shepherd config get\|set\|list [key] [value]` | config (theme, worktree-base, sleep.mode, serve.remote) |
| `shepherd wait <p> --state s[,s] [--timeout secs]` | block until a state (also `--any-attention`) |

## Output shapes

- **`ls`** prints an indented tree; **`view`** prints text; **`config`** prints
  `key = value (backend)` lines.
- **Handle-returning verbs print one bare, scriptable token** — capture with
  `$(...)`: `tab new` and `pane split` print the new **pane** handle,
  `workspace new` the **workspace** handle, `state` the **state word**, and
  `whoami` prints `pane tab workspace` (space-separated).
- **`tell` / `focus` / `zoom` / `close`** print nothing on success (check the
  exit code).

## Running something in a pane

There is **no inline-command split** and no `--cwd`. Create the pane, capture its
handle, then `tell` it:

```sh
p=$(shepherd tab new)
shepherd tell "$p" "tail -f /tmp/build.log"
```

## Orchestrating another agent

```sh
p=$(shepherd tab new)
shepherd tell "$p" "cd $(pwd) && claude"
shepherd wait "$p" --state idle --timeout 60         # let it boot
shepherd tell "$p" "run the test suite; report each failure with file:line, then stop"
shepherd wait "$p" --any-attention --timeout 1200    # blocked / need-to-check / error
shepherd view "$p" --lines 120                        # agent panes read the clean transcript
```

`view` is target-aware: an **agent pane** returns its Claude session transcript
(no `serve` needed); a **shell pane** returns the ANSI-stripped output ring (only
when *Serve to remote devices* is on).

## Common mistakes

- **Inventing flags.** No `--cwd`, no `--sock`, no `--column`, no `split -- <cmd>`.
  Split axis is `--down` (default is right). Set a directory by `tell`-ing a `cd`.
- **Skipping the boot wait.** After `tell "$p" "… && claude"`, `wait --state idle`
  before sending the real prompt, or it types into a bare shell.
- **`wait` timed out.** It exits non-zero on timeout — re-wait for long jobs; a
  pane that goes `blocked` returns early (a permission/plan prompt you can answer
  by `tell`-ing it, or surface to the user).
- **Destructive ops refuse.** `pane close` / `tab close` / `workspace rm` on live
  work need `--force` (or `--archive` for a worktree tab).

## v1 limits

- No verb to create a *worktree* tab yet — use `tab new` + `tell` a `cd`.
- No `tell --raw` keystrokes, no `view --follow`, no `view --screen`.
- Single running Shepherd (single-window).
