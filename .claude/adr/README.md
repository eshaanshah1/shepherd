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
- [0007](0007-askuserquestion-no-hook.md) — AskUserQuestion is not hook-detectable *(superseded by 0008)*
- [0008](0008-askuserquestion-via-pretooluse.md) — Detect AskUserQuestion (and plan approval) via PreToolUse
- [0009](0009-sidebar-custom-rows-not-list.md) — Sidebar: custom ScrollView rows (not List); T3-Code styling
- [0010](0010-terminal-theme-from-shepherd-config.md) — Terminal theme from ~/.config/shepherd, not ~/.config/ghostty
- [0011](0011-tab-names-cwd-and-agent-title.md) — Tab names: cwd for shells, the agent's own title for agents
- [0012](0012-pane-splitting-panes-as-agents.md) — Pane splitting: panes as agents; bracket-grouped collapsible sidebar
- [0013](0013-workspaces.md) — Workspaces: nested model, global attention
- [0014](0014-background-agent-stop-suppression.md) — Background-agent `Stop` suppression: count `[Agent]` vs `SubagentStop` *(superseded by 0015)*
- [0015](0015-background-stop-suppression-via-background-tasks.md) — Background-`Stop` suppression from the `Stop` payload's `background_tasks`
- [0016](0016-pane-click-focus-hit-testing.md) — Click-to-focus a pane: three hit-testing gates (custom Layout + surface hitTest + sidebar allowsHitTesting)
