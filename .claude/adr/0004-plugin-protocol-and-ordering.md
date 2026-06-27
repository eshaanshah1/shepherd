# 0004. Plugin protocol: pure-bash report.sh + state-machine ordering guard

Status: Accepted
Date: 2026-06-27

## Context
The hook script `report.sh` originally used `python3` to parse the hook's JSON
stdin (extract `tool_name` etc.) and to build the message. python's ~50ms
startup made parsing events (e.g. `PreToolUse`) land ~half a second behind the
parse-free `Stop`. Each hook is an independent fire-and-forget socket write with
no delivery-order guarantee, so the late `PreToolUse` (→ working) arrived after
`Stop` (→ need-to-check) and flipped the tab back to **working** every turn.

## Decision
Two parts:
1. **`report.sh` is pure bash — no interpreter spawn on the common path.** State
   is decided by the **event name** (passed as `$1`) + `tab_id` (env), so the
   latency-critical events (`Stop`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`)
   parse nothing. Only the 3 cosmetic-"reason" events (`PermissionRequest`,
   `StopFailure`, `Subagent*`) parse one field, via `jq` (~5ms; grep fallback).
2. **Ordering guard in `AgentStore.apply`:** mid-turn transitions (tool /
   permission / Stop) apply only while the tab is `working`/`blocked`. A finished
   turn (`need-to-check`) is left **only** by a real new turn (`UserPromptSubmit`)
   or by user focus. Deterministic — independent of socket arrival order.

## Consequences
- **Do not reintroduce `python3` into `report.sh`** — it reintroduces the latency
  that caused the bug.
- The guard is intentional. A stale mid-turn event after `Stop` is *ignored*
  (logged as "ignored: not mid-turn" in `/tmp/shepherd-events.log`).
- Protocol is `{tab_id, event, detail}` over the unix socket; `detail` is cosmetic.
- `Notification` was dropped from the hook set — `PermissionRequest` + `Elicitation`
  cover every blocked case with better detail.
