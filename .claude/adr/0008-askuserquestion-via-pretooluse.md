# 0008. Detect AskUserQuestion (and plan approval) via PreToolUse

Status: Accepted
Date: 2026-06-27
Supersedes: 0007

## Context
ADR 0007 claimed `AskUserQuestion` fires no hook, so a tab waiting on a question
couldn't show **blocked**. That was wrong. The official Claude Code hooks docs
list `AskUserQuestion` (and `ExitPlanMode`) among the tools that **`PreToolUse`
matches** — alongside Bash/Edit/Read/etc. The #44326/#59908 issues only say
`Elicitation` and `Notification` don't fire for it; `PreToolUse` does.

`PreToolUse` runs "after Claude creates tool parameters and before processing the
tool call" — i.e. right as Claude is about to present the question and wait. The
answer arrives via `PostToolUse` (the tool "succeeds" with the user's answer).

## Decision
Make `PreToolUse` **tool-aware** (it already carries `tool_name`):
- `PreToolUse[AskUserQuestion]` → **blocked** ("answer needed")
- `PreToolUse[ExitPlanMode]`    → **blocked** ("plan approval")
- `PreToolUse[anything else]`   → **working**
- `PostToolUse[*]`              → **working** (clears blocked when the user answers)

`report.sh` now parses `tool_name` for `PreToolUse` — via **`jq`** (~5ms),
**not** python (ADR 0004's latency rule still holds; jq is fine). Residual
ordering is covered by the mid-turn guard, so the slightly-slower PreToolUse
can't resurrect a finished turn.

## Consequences
- All "waiting on you" cases are now covered: permission, plan approval, MCP
  elicitation, **and** AskUserQuestion.
- `ExitPlanMode` now blocks via both `PreToolUse` and `PermissionRequest` — both
  map to blocked "plan approval", so it's consistent (whichever lands).
- If Claude Code ever stops emitting `PreToolUse` for `AskUserQuestion`, this
  regresses silently — worth a periodic check.
