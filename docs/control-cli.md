# Shepherd control CLI

`shepherd` is a thin CLI that drives a **running** Shepherd instance — for Claude
Code (orchestrating other panes or managing its own environment) and for any
shell script. It talks to the app over a local unix socket
(`~/.shepherd/control.sock`, also injected into every pane as
`$SHEPHERD_CTL_SOCK`); no network, no pairing — access is gated by filesystem
permissions (mode `0600`).

The binary is the bundled `shepherdd` helper; `shepherd` is a symlink created by
`scripts/install-shepherd-cli.sh`. Inside a pane you can also invoke it as
`shepherdd <verb>`.

## Install

```sh
./scripts/install-shepherd-cli.sh        # symlinks ~/.local/bin/shepherd -> the built helper
shepherd ping                            # -> pong  (confirms the channel)
```

## Addressing

Everything is addressed by **short handles** shown in `ls`: workspaces `ws1…`,
tabs `t1…`, panes `p1…`. Handles are stable while the entity lives. Raw UUIDs are
also accepted everywhere. `whoami` prints the calling pane's own handles.

## Protocol

One JSON object per connection (no framing): the client writes a request and
half-closes; the server replies and closes.

```
Request:  { "cmd": "<verb>", "<field>": <value>, ... }
Reply:    { "ok": true,  "data": <any> }   |   { "ok": false, "error": "<message>" }
```

## Verbs

### Discovery
| Command | Description |
|---|---|
| `shepherd ls` | Print the workspace → tab → pane tree with handles, state, title. |
| `shepherd whoami` | Print the calling pane's `ws`/`t`/`p` handles (needs `$SHEPHERD_TAB_ID`). |
| `shepherd state <pane>` | Print a pane's agent state + reason. |

### Workspaces / tabs / panes
| Command | Description |
|---|---|
| `shepherd workspace new` | Create a workspace (prints its handle). |
| `shepherd workspace rename <ws> <name>` | Rename. |
| `shepherd workspace switch <ws>` | Make it active. |
| `shepherd workspace rm <ws> [--force]` | Delete (refuses with live agents unless `--force`). |
| `shepherd tab new [<ws>]` | New tab in `<ws>` (default: active). Prints tab + pane handles. |
| `shepherd tab rename <t> <name>` | Rename a tab. |
| `shepherd tab switch <t>` | Switch to a tab. |
| `shepherd tab close <t> [--force] [--archive]` | Close; refuses on live work unless `--force`; `--archive` keeps a resumable worktree archive. |
| `shepherd pane split <p> [--down]` | Split right (default) or down. Prints the new focused pane. |
| `shepherd split <p> [--down]` | Alias for `pane split`. |
| `shepherd pane close <p> [--force]` | Close a pane (refuses on a live agent unless `--force`). |
| `shepherd focus <p>` | Focus a pane (crosses workspaces if needed). |
| `shepherd zoom <p>` | Toggle zoom of a pane. |

### Talking to panes
| Command | Description |
|---|---|
| `shepherd tell <p> "<text>" [--no-enter]` | Type text into a pane's PTY (+ Enter). Mid-turn agents queue it natively. `--no-enter` holds the newline. |
| `shepherd view <p> [--lines N] [--raw]` | Read a pane. Agent panes → clean session-transcript tail; shell panes → ANSI-stripped ring tail (requires *serve* on). `--raw` forces raw ring bytes. |

### Config
| Command | Description |
|---|---|
| `shepherd config list` | List known keys with values and backend (`file`/`app`). |
| `shepherd config get <key>` | Read a key. |
| `shepherd config set <key> <value>` | Set a key. File keys (`theme`, `worktree-base`, ghostty keys) rewrite `~/.config/shepherd/config` + live-reload; app keys (`sleep.mode`, `serve.remote`) mutate app state. |

### Orchestration
| Command | Description |
|---|---|
| `shepherd wait <p> --state s[,s] [--timeout secs]` | Block until the pane hits a listed state (`idle`/`blocked`/`need-to-check`/`error`/`working`/`shell`). |
| `shepherd wait <p> --any-attention [--timeout secs]` | Block until `blocked`/`need-to-check`/`error`. |

## Orchestration example

Spawn a pane, hand it a task, wait, read the result — the terminal as the
conductor's bus:

```sh
shepherd ls
# note the pane handle that `tab new` prints:
shepherd tab new
shepherd tell p3 "cd ~/repo && claude"
shepherd wait p3 --state idle --timeout 60
shepherd tell p3 "run the test suite and fix the first failure"
shepherd wait p3 --any-attention --timeout 900
shepherd view p3 --lines 60
```

## v1 limitations

- Shell-pane `view` requires *Serve to remote devices* enabled (the capture ring
  only runs then). Agent-pane `view` always works (reads the session transcript).
- `tell --raw` literal-keystroke injection, `view --follow`, and `view --screen`
  (rendered viewport) are deferred.
- Single running Shepherd instance (single-window v1).
