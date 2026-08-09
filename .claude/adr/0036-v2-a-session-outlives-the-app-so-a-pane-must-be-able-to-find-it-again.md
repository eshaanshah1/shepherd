# 0036. (v2) A session outlives the app, so a pane must be able to find it again

Status: Accepted
Date: 2026-08-09
Scope: `v2/` only.
Supersedes: the "fresh pane ids and no sessions" rule in
`packages/core/src/layout/store.ts` (`#restore`), and the `AGENT_BINARY` /
`planResume` hardcode in `extensions/tasks/src/model/launch.ts`.

## Context

R1 moves `SessionHost` into a daemon, so a pty now outlives the Electron process
that opened it. Measured before planning: node-pty loads under
`ELECTRON_RUN_AS_NODE=1` against the same Electron ABI, and a detached child
reparents to `ppid 1` and keeps its ptys running after Electron exits.

That breaks a rule the layout store currently states outright:

> A restored root comes back with **fresh pane ids and no sessions**: live state
> never survives a restart, and reusing an id would let a stale binding from the
> previous run resolve to a new pane.

The rule was correct **while sessions died with the app** — there was nothing to
reattach to, so fresh ids were pure upside: a stale session id, attention entry
or extension record could not silently resolve to a new pane.

With a daemon it inverts. On relaunch the daemon holds N live ptys, the layout
restores N panes with fresh ids and no bindings, each creates a *new* session,
and the original N keep running with nothing pointing at them — invisible and
unkillable from the UI. That is the defect `pane-sessions.ts` documents ("a
SECOND pty per pane while the first kept running") one process up, and it turns
the milestone inside out: instead of surviving a restart, agents are orphaned by
one.

A second question arrives with it. If the pty is genuinely gone — the daemon
crashed, the machine rebooted, the session exited — an idle Claude should still
come back as an agent rather than a bare shell. v1 did this with
`claude --resume <id>`. v2 has the *target* (`claude-code`'s `resumeSessionID`,
reached through `agents.resumeTarget`) but spells the command in **`tasks`**,
which `launch.ts` flags as a known compromise: "this is the seam where an agent
kind should eventually say it … hardcoded until a second kind exists".

## Decision

### 1. Pane ids persist, and so does each pane's session binding

The objection the old rule defended against is answered by the thing that made
the change necessary: **the daemon is the authority on what is alive.** A
restored binding is therefore a *claim*, verified before it is believed:

- session live in the daemon → the pane **adopts** it;
- session gone → the binding is dropped and the pane creates one, exactly as
  today;
- session live but claimed by no restored pane → an **orphan**, listed rather
  than leaked, so something can adopt or reap it.

Stale bindings still fail. They now fail by being *checked* instead of by being
*impossible* — a check that could not exist before, because no process could
answer the question.

`initialCommand` still must not round-trip. `serialize.ts` already says why, and
it becomes more load-bearing here: a reattached pane that re-ran its command
would start a second agent inside a pane that already has one.

### 2. Three rungs, in order, and never two at once

1. **The pty is alive in the daemon → reattach.** Lossless and free: the same
   process, its scrollback, its context. R0's snapshot means the reattaching
   viewer is handed a correct screen however long it was away.
2. **The pty is gone → resume.** The pane restores carrying the agent's resume
   command as its `initialCommand`.
3. **No resume target → a plain shell**, as today.

Resume is strictly worse than reattach when reattach is available — it re-reads
the transcript, costs tokens, and loses the screen — so rung 1 always wins. The
negative control that matters: **a pane that reattached must never also resume**,
or there are two agents in one pane.

### 3. The launch command moves to the kind

R1 supplies the second consumer `launch.ts` was waiting for. Not a second *kind*
— a second *caller*: restoring a pane after a cold start needs a resume command
with no task involved at all. One caller shaped the shortcut; two is when it
stops being justified.

- **`claude-code`** owns the whole command, beside the `capabilities` the kind
  already declares. `claude --resume <id>` appears in no other package.
- **`agents-core`** stays vendor-blind: it asks the kind and passes the string
  through.
- **`tasks`** deletes `AGENT_BINARY` and `planResume` and consumes the same seam.
- **core** persists the Shepherd `sessionId` plus an opaque restore hint written
  by extensions, and carries whatever command it is handed. It never learns what
  a claude is.

This completes D11 rather than bending it: the target was already opaque, but the
binary and flag around it were assumed by `tasks`.

## Consequences

- The two ids stay apart, and `kind.ts` already explains the cost of conflating
  them: `ownerClaudeSessionID` is a **lock** released on `SessionEnd`;
  `resumeSessionID` is a **target** that outlives it, because a session that
  ended is precisely the one worth resuming. Shepherd's own `SessionID` is a
  third thing again — the pty, which is what R1 keeps alive.
- Anything keyed on a pane id may now outlive a restart, so extension records
  and attention entries need the same reconciliation the session binding gets.
  Reconcile against the daemon; do not assume.
- A resumed session is a **new** kernel session with the same Claude transcript.
  `tasks` already records this ("a resumed Claude session keeps its own id … but
  the kernel session is a new one").
- The orphan list is a real surface with no consumer yet. It is logged in R1; the
  UI for adopting or reaping is deliberately deferred rather than invented ahead
  of a caller (ADR 0031's rule).
