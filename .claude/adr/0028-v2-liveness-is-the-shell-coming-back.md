# 0028. (v2) Liveness is the shell coming back, not the vendor's name

Status: Accepted
Date: 2026-08-07
Scope: `v2/` only.

## Context
Review §Bad-5: if `claude` dies without a `SessionEnd` (SIGKILL, crash, a missing
socket), v1's pane reads `working` **forever** — blocking update restarts,
refusing `pane close`, hanging `shepherd wait`. The fix is a reconciliation
sweep: state says working, is anything actually running?

Two probes decided its shape, and the second killed the design that was already
written down.

**Probe 1 — the input exists, and costs nothing.** node-pty's `IPty.process`
reports the pty's **foreground** process on macOS. Measured against a real pty:
an idle `zsh` reads `"zsh"`, `sleep 4` running in it reads `"sleep"`, and it
returns to `"zsh"` when the sleep ends. So the sweep needs **no subprocess and no
`ProcessAPI`** — which is M3. Without this the only input would have been a `ps`
shell-out, dragging a whole API a milestone forward to serve one boolean.

**Probe 2 — a vendor's process name is not its command name.** The plan's first
draft had each agent kind identify itself by matching the foreground process
against its own name (`detect(foregroundProcess)`). On a real machine `claude` is
`~/.local/bin/claude` → a binary literally named **`2.1.224`**, and macOS derives
`p_comm` from the *resolved* executable. Measured: the pty reports `"2.1.224"`,
never `"claude"`. That predicate would have matched **nothing**, so the sweep
would have demoted every live agent — while every unit test passed, because a
test would have used the name the test author expected.

## Decision
**The sweep asks whether the session's own command is back in front of it**, and
never matches a vendor name:

```
hasForegroundProcess := basename(pty.process) !== basename(session.command)
```

A pane's command is the login shell. While anything runs the foreground is
*something else* — whatever it is called. When it dies by any means the shell
comes back, which **is** the session's own command. Vendor-blind by construction,
and immune to a version-named binary.

**Which sessions are agents is answered by the hooks**, not by a process name: a
`SessionStart` says so, carrying the vendor's own session id. Reaching for a
process name was a second, worse source of a fact ADR 0003 already established.

Four constraints, all measured, all encoded:

- **The answer is tri-state.** `undefined` means the tty could not be read, and
  node-pty *returns* that rather than throwing — on darwin every failure path
  (bad fd, `tcgetpgrp` -1, `sysctl` -1, empty `p_comm`) yields it. Measured: 0
  throws in 40 samples across a killed pty. Collapsing it to `false` hands the
  sweep its demote signal for a live agent whose tty was unreadable for a tick.
  **The sweep fails toward not demoting.**
- **Consecutive readings, never one.** A fresh pty reports node-pty's own
  `spawn-helper`, and a login shell runs transient helpers for its first moments.
- **A pane must be spawned as the shell's own resolved path.** `/bin/sh` reports
  `bash` on macOS and would read busy forever. Same root cause as probe 2, biting
  the command side. Pinned by a test.
- **The sweep does not travel through a vendor's reducer.** Synthesising an event
  would put a lie in the reducer's input, and Claude's ordering guard would eat
  it — mid-turn events apply only while `working`/`blocked`, which is exactly the
  state a demotion starts from. One internal writer, two sources of evidence.

It demotes to **`needsCheck`, never `idle`**: a dead agent is precisely something
the user has not seen, and `idle` would discard the one alert the sweep exists to
raise.

## Consequences
- `ProcessAPI` stays unimplemented until M3, as planned.
- A session whose *command is itself* the agent (a headless `claude`) inverts the
  predicate, so it is not reconciled from here — its liveness is its exit, which
  is exact.
- The general lesson, which cost two rewrites between them: **a process's name is
  the resolved binary's name.** It is not the command you typed, not the symlink
  you invoked, and not what the vendor calls itself.
