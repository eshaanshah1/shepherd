# Architecture Decision Records

Short, append-only records of the **non-obvious, load-bearing decisions** behind
Shepherd — the "why" — so future sessions don't re-litigate them or accidentally
undo a deliberate choice/workaround.

## Format
One file per decision: `NNNN-kebab-title.md`, numbered sequentially. Each has:

```
# NNNN. Title
Status: Accepted | Superseded by NNNN | Deprecated
Date: YYYY-MM-DD

## Context        — the situation / forces
## Decision       — what we chose
## Consequences   — trade-offs, what this implies, what NOT to do
```

## When to add one
- A choice with real trade-offs you'd otherwise forget the reasoning for.
- A workaround for an external bug/limitation (record the bug + why).
- Anything a future agent might try to "fix" without knowing why it's that way.

**Supersede, don't delete:** mark the old one `Superseded by NNNN` and add a new file.

## Index
- [0001](0001-build-on-libghostty-fresh-swiftui-app.md) — Build on libghostty in a fresh SwiftUI app
- [0002](0002-libghostty-build-on-macos-26.md) — Building libghostty on macOS 26 (the toolchain saga)
- [0003](0003-agent-state-via-claude-hooks.md) — Agent state from Claude Code hooks; Claude-only v1
- [0004](0004-plugin-protocol-and-ordering.md) — Plugin protocol: pure-bash report.sh + ordering guard
- [0005](0005-plugin-install-via-skills-dir.md) — Install the plugin via the skills-dir auto-load
- [0006](0006-sidebar-shows-all-tabs.md) — Sidebar lists all tabs (filtering deferred)
- [0007](0007-askuserquestion-no-hook.md) — AskUserQuestion is not hook-detectable
