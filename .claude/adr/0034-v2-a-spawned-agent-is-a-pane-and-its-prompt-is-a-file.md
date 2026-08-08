# 0034. (v2) A spawned agent is a pane, and its prompt travels as a file

Status: Accepted
Date: 2026-08-08
Scope: `v2/` only.

## Context
`tasks.spawn` recorded intent and started nothing. The verb, its scoping (an
agent may only spawn into its own task) and its authorization were real and
proven end to end — but a task was a set of worktrees with nobody working in
them, and M4's dogfood week cannot run on that.

Two questions had to be answered to make it live.

**Where does a spawned session live?** The sketch (§4) says tasks are
location-independent: a task can be created on a phone, run on the Mac, and
render **only** on the phone — "creating a task is a session-level verb, not
'new tab'". That describes a session with no pane anywhere.

**How does a prompt reach the agent?** A brief is prose: multi-line, quoted,
apostrophes.

## Decision
**A spawned agent is a pane, today.** `tasks.spawn` invokes `layout.split` with
the worktree as `cwd` and one line to type; the renderer creates the session
when the pane mounts, and the kernel injects the correlation env into it
(ADR 0025), so the agent's hooks, state dot and attention work with nothing
added.

The headless case is **deferred, not rejected**. [ADR 0022](0022-v2-layout-owns-the-session-binding.md)
makes `layout.close` the one thing that ends a session — a session with no pane
therefore has no owner and no terminator, which is new architecture rather than
a wider schema, and it belongs to the milestone that needs it (remote/phone).
M4 needs an agent working in a worktree **that you can watch**, which is exactly
the pane-attached shape.

**The prompt travels as a file.** v1's `AgentLaunch`, ported: the brief is
written to `<dataDir>/.prompts/…`, and the line typed into the pty is

    p=$(cat '<file>'); rm -f '<file>'; claude "$p"

One line, no user text on it, and the file is consumed whether or not the agent
exists. This is not tidiness — a typed newline **is** an Enter press, so a
multi-line prompt typed directly submits its first line and scatters the rest
into whatever runs next, and an apostrophe in prose ends the argument early and
hands the remainder to the shell. Both fail silently. The prompt file lives
outside every task root, because a root is an agent's cwd and a stray prompt
there is junk in the workspace the agent is about to describe.

**`Pane.initialCommand` is where it lands.** The field has existed since M0 with
nothing setting it, and `serialize.ts` already drops it — so a relaunch restores
a pane and never a command. `layout.split`'s schema now carries it, and the
renderer types it **inside `#sync`'s create branch**, which is what makes it
one-shot: `#sync` runs again on every attach, and a command re-typed on a
remount starts a second agent in a pane that already has one.

**The orchestrator starts itself** (§7b: "composer auto-starts the
orchestrator"), after provisioning rather than with it — its whole context is
the synthesized root (ADR 0029), and an agent that opened before the generated
`CLAUDE.md` existed would read a directory that does not describe its task yet.
Guarded on the task having no sessions, which is also what stops `tasks.restore`
— which re-provisions — from opening a second orchestrator beside the first.

## Consequences
`tasks` declares the **`layout`** permission, which is the honest statement of
what it now does: this extension can open panes on your screen, reviewable in
its manifest like everything else.

The session id is learned by a **bounded poll** of `sessions.list` keyed on the
pane id (10 × 500ms, a `setTimeout` chain — `Clock` has no `setInterval`, and
reaching for one took a contribution down in M3b). There is no event to wait on:
the renderer creates the session and what the host publishes is a layout
snapshot. So the record is optimistic — a placeholder id, replaced when the pane
reports — and a pane that never produces one keeps its placeholder **and logs a
warning** (D15), because a task holding a session id that addresses nothing is
worse than one that says it does not know. `TaskSession.pane` is stored for that
reason: it is the only true fact for the moment between the two.

`smoke:m3` asserts the mechanism rather than `claude`, which this box does not
have: a session whose cwd is the task root, a record pointing at its id, and the
**prompt file gone** — true only if the typed line really ran, since the `rm -f`
precedes the agent. Mutation-tested: disabling the renderer's write fails that
check by name and prints the orphaned file.

Two things the first live run found. The smoke's own session spec pinned every
pane to `/tmp` with `exec cat`, so no pane could run anything — it now gives a
real shell to a pane that carries a cwd or a command, and keeps `exec cat` for
the pane the terminal smoke types into, which is what that smoke asserts. And a
pre-existing race surfaced: the smoke waited for the worktree and then asserted
the `CLAUDE.md` written a beat later, so an unrelated failure blamed the wrong
thing — the wait now covers both.

## Not decided here
- **A session with no pane** — the sketch's location-independent case, above.
- **Resume on restore.** `tasks.restore` brings back the worktrees, not the
  agents. Re-spawning would silently drop the transcript the archive exists to
  preserve; a resume verb is its own piece of work (D11's `resumeTarget` is
  already recorded and still opaque here).
- **A launch command per agent kind.** `AGENT_BINARY` is `claude`, hardcoded
  with the seam named: kinds already declare `capabilities` (§7c) and a launch
  command belongs beside them — when there is a second kind to shape it.
