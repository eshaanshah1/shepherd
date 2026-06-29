# 0014. Background-agent `Stop` suppression: count `[Agent]` launches vs `SubagentStop`

Status: Accepted
Date: 2026-06-29

## Context
When the main agent launches a **background agent** (`Task`/`Agent` run in the
background — the "Waiting for N background agent(s) to finish" case) and yields
its turn to wait, Claude Code fires `Stop` *while the background agent is still
running*. Shepherd treated every `Stop` as "turn finished" → `need-to-check`, so
a busy agent falsely read as done (dock badge, chime, notification all fired),
and the ordering guard ([ADR 0004](0004-plugin-protocol-and-ordering.md)) then
dropped every event from the resumed turn as "not mid-turn" — leaving the tab
stuck on the false "done" until the next `UserPromptSubmit`.

What the event stream does **not** give us (confirmed against the docs + the live
`/tmp/shepherd-events.log`):
- The `Stop` payload carries **no** pending-background-tasks field.
- `SubagentStop` carries **no** background-vs-foreground flag.
- `SubagentStart` is **unreliable** — the log shows 1 `SubagentStart` against 6
  `SubagentStop`s in a single turn — so it cannot be used to count in-flight work.
- A backgrounded turn does not re-fire `UserPromptSubmit` on resume, and a clean
  second `Stop` after resume is not guaranteed.

So background lifecycle can't be tracked precisely from hooks. The one reliable
asymmetry: at `Stop` time a **foreground** subagent has already emitted its
`SubagentStop` (launches == completions), whereas a **background** one has not
(launches > completions).

## Decision
A per-pane transient counter `outstanding` (in `AgentStore.backgroundOutstanding`,
never persisted), folded in the pure `applyEvent` (`StopPolicy.swift`):
- `PreToolUse[Agent]` / `[Task]` (mid-turn) → `outstanding += 1`
- `SubagentStop` → `outstanding = max(0, outstanding − 1)` (floored)
- `Stop` while `outstanding > 0` → **stay `working`** (a pause, not a finish — no
  badge/chime); `Stop` while `0` → `need-to-check` as before.
- `UserPromptSubmit` / `SessionStart` / `SessionEnd` reset it to 0.

During the wait the pane stays `working`; the background `SubagentStop` arrives
mid-turn so resumed work tracks normally; the real `Stop` (counter back at 0)
fires `need-to-check` and pulls you back.

## Consequences
- **No plugin-protocol change** — `report.sh` is untouched; this is app-only and
  keeps [ADR 0004](0004-plugin-protocol-and-ordering.md) intact (the turn is
  never reopened on `PreToolUse`/`PostToolUse`, so the stale-event race stays
  closed).
- **Fails safe, never sticks.** If counting is ever off — notably a `Workflow`
  fan-out, where many `SubagentStop`s have no matching `[Agent]` launch — the
  counter floors at 0 and behaviour reverts to plain finish-on-`Stop`. The worst
  case is the *old* false-done, never a permanently-stuck `working`.
- We deliberately do **not** gate on `SubagentStart` (unreliable, see Context).
- The held `Stop` is logged as `(held: N background agents)` in
  `/tmp/shepherd-events.log`.
- Transition logic now lives in the pure `applyEvent` (`StopPolicy.swift`),
  covered by `ShepherdModelTests` — mirroring the `SleepPolicy`/`SleepGuard` split.
