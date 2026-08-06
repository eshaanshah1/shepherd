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
| `shepherd workspace hook get <ws>` | Print the workspace's worktree hook (nothing, exit 0, when unset). |
| `shepherd workspace hook set <ws> (--file <path\|-> \| "<script>")` | Install the hook. `--file -` reads stdin. |
| `shepherd workspace hook clear <ws>` | Remove the hook. |
| `shepherd tab new [<ws>] [--cwd <dir>]` | New tab in `<ws>` (default: active). Prints tab + pane handles. `--cwd` opens the pane there instead of the workspace's default directory; relative paths and `~` resolve against *your* shell, and a missing directory is an error rather than a silent fallback. |
| `shepherd tab new [<ws>] --worktree <branch>` | New tab in a fresh `git worktree` of the workspace's directory, exactly like the sidebar's *New Worktree Tab…* — reusing `<branch>` if it exists, else branching off origin's default. Runs the workspace's worktree hook. Conflicts with `--cwd`. |
| `shepherd tab new [<ws>] --profile <name>` | Run the tab's Claude under a named profile (a separate `CLAUDE_CONFIG_DIR`, i.e. a different account) instead of the workspace's. Names resolve case-insensitively; `Default` is always valid. Composes with `--cwd`/`--worktree`. |
| `shepherd tab rename <t> <name>` | Rename a tab. |
| `shepherd tab switch <t>` | Switch to a tab. |
| `shepherd tab close <t> [--force] [--archive]` | Close; refuses on live work unless `--force`; `--archive` keeps a resumable worktree archive. |
| `shepherd pane split <p> [--down]` | Split right (default) or down. Prints the new focused pane. |
| `shepherd split <p> [--down]` | Alias for `pane split`. |
| `shepherd pane close <p> [--force]` | Close a pane (refuses on a live agent unless `--force`). |
| `shepherd focus <p>` | Focus a pane (crosses workspaces if needed). |
| `shepherd zoom <p>` | Toggle zoom of a pane. |

**The worktree hook is per-workspace app state, not a config key.** It is the bash
Shepherd runs right after `git worktree add`, with cwd = the new worktree and
`WORKTREE_DIR` / `WORKTREE_SRC` / `WORKTREE_BRANCH` / `WORKTREE_NAME` / `REPO_NAME` in
the environment; a non-zero exit warns in the app but keeps the worktree. It lives in
`shepherd.workspaces.v1`, so it is reached through `workspace hook`, not
`config set` — `~/.config/shepherd/config` is parsed by libghostty and Shepherd's own
keys have to ride `# shepherd:` comment lines there, which a multi-line script cannot
survive. The workspace is always an explicit argument: `shepherd` also runs from
terminals that are not Shepherd panes, where there is no current workspace to infer.

`hook get` writes the script raw, so `shepherd workspace hook get ws1 > hook.sh`
round-trips byte-for-byte through `hook set ws1 --file hook.sh`.
`scripts/worktree-hook.sh` is this repo's own hook — it links the gitignored deps a
fresh worktree lacks (`vendor/`, `android/app/google-services.json`), without which
`xcodegen generate` and the Android build fail there:

```sh
shepherd workspace hook set <ws> --file scripts/worktree-hook.sh
```

`tab new --worktree` replies as soon as the tab exists, which is **before** git
finishes — the pane opens in a provisioning state and the printed handles are already
valid. A `git worktree add` or hook failure therefore surfaces in the app (the tab is
removed / an alert is shown), not in the CLI's exit status.

### Talking to panes
| Command | Description |
|---|---|
| `shepherd tell <p> "<text>" [--no-enter]` | Type text into a pane's PTY (+ Enter). Mid-turn agents queue it natively. `--no-enter` holds the newline. |
| `shepherd tell <p> --file <path\|-> [--no-enter]` | Same, with the text read from a file (`-` = stdin). Trailing newlines are stripped so `--no-enter` really holds. |

**Multi-line text is pasted, not typed.** Typed newlines *are* Enter presses, so a
multi-line prompt typed into an agent submits its first line and orphans the rest.
Any text containing a newline — from `--file` or from a quoted argument — goes
through libghostty's paste path instead, so the receiving program's
bracketed-paste mode decides whether a newline is content or a submit. `tell`
then sends one Enter at the end (unless `--no-enter`). If a pane won't take a
paste the text is typed as a fallback and `tell` **exits non-zero** saying so —
it never silently mangles a long prompt.
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
p=$(shepherd tab new --cwd ~/repo)
shepherd tell "$p" "claude"
shepherd wait "$p" --state idle --timeout 60
shepherd tell "$p" "run the test suite and fix the first failure"
shepherd wait "$p" --any-attention --timeout 900
shepherd view "$p" --lines 60
```

A brief too long for one line rides a file:

```sh
shepherd tell "$p" --file /tmp/brief.md
```

## v1 limitations

- Shell-pane `view` requires *Serve to remote devices* enabled (the capture ring
  only runs then). Agent-pane `view` always works (reads the session transcript).
- `tell --raw` literal-keystroke injection, `view --follow`, and `view --screen`
  (rendered viewport) are deferred.
- `tab new --cwd` is local-workspace only: a **mirror** workspace's tabs are
  created by the host, which owns the directory, so the flag is ignored there.
- `tab new --worktree` and `workspace hook` are local-workspace only for the same
  reason — the host owns the repo. `--worktree` on a mirror is an error rather than a
  tab with no handle to print.
- Single running Shepherd instance (single-window v1).
