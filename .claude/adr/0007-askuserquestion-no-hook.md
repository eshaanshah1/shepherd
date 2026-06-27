# 0007. AskUserQuestion is not hook-detectable (accepted limitation)

Status: Accepted
Date: 2026-06-27

## Context
The most-wanted "blocked" case is when Claude asks the user a multiple-choice
question (the `AskUserQuestion` tool) and waits. We wanted that to show
**blocked**.

## Decision
**Accept that we cannot detect it via hooks today.** `AskUserQuestion` fires
*no* hook — not `PreToolUse`, not `Notification`, not `Elicitation` (documented
Claude Code limitations: anthropics/claude-code#44326 and #59908). So a tab
waiting on an AskUserQuestion stays **working** until the turn ends. The other
"waiting on you" cases are covered: permission prompts and plan approval via
`PermissionRequest`, MCP forms via `Elicitation`.

## Consequences
- Don't burn time trying to detect AskUserQuestion via hooks — it's not possible.
- Revisit when Claude Code ships a hook for it (watch the linked issues), then
  add `AskUserQuestion` → blocked in `AgentStore.apply`.
- A non-hook workaround (e.g. PTY/output heuristics) was explicitly rejected as
  too brittle (see ADR 0003).
