# 0015. Background-`Stop` suppression from the `Stop` payload's `background_tasks`

Status: Accepted — supersedes the counting mechanism in [ADR 0014](0014-background-agent-stop-suppression.md)
Date: 2026-06-30

## Context
[ADR 0014](0014-background-agent-stop-suppression.md) solved a real bug — a `Stop`
fired while a backgrounded agent is still running was read as "turn finished", so
a busy agent falsely chimed/badged/notified. But it solved it with a heuristic
**counter** (`PreToolUse[Agent]`/`[Task]` launches minus `SubagentStop`s) built on
a stated premise:

> "confirmed against the docs + the live `/tmp/shepherd-events.log`: The `Stop`
> payload carries **no** pending-background-tasks field."

That confirmation was unsound. `/tmp/shepherd-events.log` records Shepherd's own
**state transitions** (`event=Stop … working->needsCheck`), never the raw hook
**stdin payloads** — so it cannot establish the presence or absence of a payload
field. In fact, since Claude Code **v2.1.145** the `Stop` (and `SubagentStop`)
payload carries a **`background_tasks`** array, documented precisely to *"let hooks
distinguish 'session is done' from 'session is paused waiting for background work
to wake it back up.'"* The field was available the whole time on the versions we
run; the counter was built on a false negative.

The counter was also fragile by construction: it infers in-flight work from event
arithmetic across events that do **not** pair 1:1. ADR 0014 itself recorded "1
`SubagentStart` vs 6 `SubagentStop`s in one turn"; `SubagentStop` can outnumber
`[Agent]` launches, and a launch event can be missed. Any imbalance let a genuine
background pause read as done — the false notification kept happening.

## Decision
Decide background-ness from **ground truth at `Stop` time**, not from counting.

- `report.sh`, on `Stop` only, reduces `background_tasks` to a count of the tasks
  the turn is actually paused on and passes it through `detail` (via `jq`):

  ```
  [.background_tasks[]? | select(.type=="subagent" or .type=="workflow" or .type=="shell")] | length
  ```

- `StopPolicy.applyEvent` (pure): a **mid-turn `Stop` with count > 0** stays
  `working` (paused, no badge/chime); **count 0** (or empty/unparseable `detail`)
  → `need-to-check`.
- The per-pane `outstanding` counter (`AgentStore.backgroundOutstanding`) and all
  `PreToolUse[Agent]`/`[Task]` increment / `SubagentStop` decrement logic are
  **removed**. `applyEvent` drops its `outstanding` parameter and field.

### Which task types hold the notification
Allow-list, not "anything ≠ monitor":
- `subagent`, `workflow`, `shell` → **hold** (suppress the "done" notification).
- `monitor` → **do not hold** — a monitor is a passive watcher; the turn is
  genuinely done, so it still notifies.

An allow-list is chosen over a deny-list (`type != "monitor"`) because it does not
depend on guessing the exact `monitor` type string, it encodes the three explicit
rules directly, and an unknown future type fails toward **notify** (the milder,
pre-0014 behavior) rather than wrongly suppressing on a monitor.

## Consequences
- **Deterministic; fixes the bug at its root.** Each `Stop` re-reads the live set
  of background tasks. No cross-event state, so it is immune to `SubagentStart`
  unreliability and to unbalanced `SubagentStop` counts — the exact failure modes
  behind the residual false-done.
- **Fail-safe, never sticks.** No `jq`, empty array, missing field, or malformed
  payload → `detail` empty → treated as `0` → plain finish-on-`Stop`. Worst case is
  the *old* false-done, never a permanently-stuck `working`.
- **Plugin-protocol change** (unlike ADR 0014, which was app-only): `report.sh`
  now parses `background_tasks` on `Stop` (~5ms via `jq`). This does **not**
  reintroduce the [ADR 0004](0004-plugin-protocol-and-ordering.md) ordering hazard:
  `Stop` is the last event of a turn, so nothing races behind it; the common path
  still does zero JSON parsing.
- **Version floor.** Requires Claude Code **v2.1.145+** for `background_tasks`. On
  older versions `detail` is empty → finish-on-`Stop` (degrades to pre-0014
  behavior, not to the counter).
- `heldForBackground` is kept for the debug log; a held `Stop` logs
  `(held: N background task(s))` in `/tmp/shepherd-events.log`.
- Covered by the rewritten `StopPolicyTests`; the `jq` allow-list is verified
  separately against sample payloads (subagent/shell/workflow → hold, monitor →
  notify, empty/missing/malformed → notify).

## Lesson
To confirm what a hook payload does or does not contain, inspect the **raw payload**
— not a downstream log of decisions derived from it. ADR 0014's negative was
asserted from a log that structurally could not contain the answer.
