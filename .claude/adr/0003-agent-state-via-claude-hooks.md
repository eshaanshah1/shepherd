# 0003. Agent state from Claude Code hooks; Claude-only first-class in v1

Status: Accepted
Date: 2026-06-27

## Context
"Knowing what an agent is doing" needs a source. Two options: (a) scrape the
terminal output, or (b) have the agent emit signals. Scraping a repainting TUI
is brittle and breaks on every harness UI tweak. An interactive agent like
Claude Code is also *one long-running process* that loops internally — it never
returns to the shell prompt between turns, so shell-level signals (OSC 133, PTY
activity) can't distinguish working/blocked/done *within* a session.

## Decision
Drive state from **Claude Code's own hook lifecycle**, not scraping. Shepherd
injects `SHEPHERD_TAB_ID` + `SHEPHERD_SOCK` into each tab's PTY; a Claude plugin's
hooks report `{tab_id, event, detail}` to an in-app unix socket; `AgentStore`
maps events → state. Correlation is by the per-tab env var (inherited by
`claude` and its hook subprocesses), not PID guessing.

**Claude Code is the only first-class agent in v1.** Other CLIs (codex, aider,
gemini) are plain terminal tabs (`shell` state). This deleted the entire
"Tier-B" fallback/scraping subsystem from v1 — less to build, and the fragile
part is the part we cut.

## Consequences
- No scraping, no per-harness parsing — robust against TUI changes.
- Generic non-Claude agents are deferred (would need the Tier-B PTY/process layer).
- Depends on Claude Code's hook events; see ADR 0007 for the AskUserQuestion gap.
- State model: `shell / working / blocked / need-to-check / idle / error` — the
  `need-to-check`→`idle` transition is *user-focus-driven* (unread→read), not agent-driven.
