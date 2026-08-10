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
- [0017](0017-workspace-folders-accordion-sidebar.md) — Workspace folders: accordion sidebar (all tabs in one view)
- [0018](0018-worktree-archive-and-provisioning.md) — Worktree archive/restore + optimistic provisioning feedback
- [0019](0019-markdown-rendered-diff.md) — Rendered markdown diff in the review panel (block-level, per-file Rendered⇄Raw toggle)
- [0020](0020-viewing-a-pane-is-one-predicate.md) — "The user is viewing this pane" is one predicate, and the state machine consults it (a turn that finishes under your eyes reads idle, not done)

### v2 (`v2/`, the ADE rewrite)
Same log, same numbering — one chronological record for the repo. These apply to
`v2/` only; v1 is maintenance-only for the duration.
- [0021](0021-v2-store-is-node-sqlite.md) — The store is `node:sqlite` (not better-sqlite3: stdlib, no ABI rebuild, no new boundary exception), versioned in `PRAGMA user_version` so no data operation can erase the marker
- [0022](0022-v2-layout-owns-the-session-binding.md) — The layout lives in the kernel, and `layout.close` is what ends a session — enforced by a constructor that cannot omit the `SessionSink`
- [0023](0023-v2-permissions-granted-once-checked-always.md) — Permissions: review-at-install, grant once, checked always in the one dispatcher; a built-in is pre-granted by a WRITE, not by an exemption, so `revoke` bites it
- [0024](0024-v2-a-pane-never-inherits-another-shepherds-env.md) — A pane never inherits another Shepherd's correlation env; v2 was one dogfood run from driving the LIVE v1 app, and a distinct variable name is necessary but not sufficient
- [0025](0025-v2-the-kernel-injects-correlation-env.md) — The KERNEL injects `SHEPHERD_SESSION_ID` + the socket paths, not `claude-code`: `onWillCreate` is synchronous by design and a message port is not, and the values were never vendor-specific
- [0026](0026-v2-agent-state-and-attention-are-two-channels.md) — Agent state and attention are two channels with one mapping between them; `AttentionLevel` has no `working`, and only `agents-core` declares the `attention` permission so the single-writer rule is enforced rather than remembered
- [0027](0027-v2-the-hook-envelope-has-no-client-sequence.md) — The hook envelope carries no client `seq` (a raced counter yields a duplicate, and a duplicate is DROPPED before delivery) and no `jq` (nothing is extracted, so nothing needs escaping)
- [0028](0028-v2-liveness-is-the-shell-coming-back.md) — Liveness is the session's own shell returning to the foreground, never a vendor's name: `claude`'s binary is named after its version, so name-matching matches nothing; the reading is tri-state and the sweep fails toward NOT demoting
- [0029](0029-v2-a-tasks-context-is-synthesized-because-claude-does-not-inherit-it.md) — (v2) A task's context is synthesized, because Claude Code does not inherit it
- [0030](0030-v2-the-transport-deadline-is-the-callers-not-a-constant.md) — (v2) The transport deadline is the caller's, not a constant
- [0031](0031-v2-a-contributed-view-declares-itself-and-a-row-click-is-the-extensions.md) — (v2) A contributed view declares itself, and a row click is the extension's
- [0032](0032-v2-tasks-uses-the-same-kv-a-third-party-gets.md) — (v2) `tasks` uses the same KV a third party gets
- [0033](0033-v2-extension-ui-is-in-proc-react-behind-a-name.md) — (v2) Extension UI is in-proc React (§7b's taxonomy, not a preference) and what crosses the port is a NAME the renderer resolves; a component's `invoke` is attributed like a row click
- [0034](0034-v2-a-spawned-agent-is-a-pane-and-its-prompt-is-a-file.md) — (v2) A spawned agent is a PANE (the headless case is ADR 0022's ownership problem, deferred to remote) and its prompt travels as a FILE, because a typed newline is an Enter press
- [0035](0035-v2-a-row-names-its-root-and-the-shell-derives-the-highlight.md) — (v2) A contributed row names the layout ROOT it stands for and the shell derives the highlight from the same snapshot value the stage draws from; the first repair — a bus topic mirrored by the extension — was the same second copy one process along
- [0036](0036-v2-a-session-outlives-the-app-so-a-pane-must-be-able-to-find-it-again.md) — (v2) A session outlives the app, so a pane must be able to find it again
- [0037](0037-v2-agents-core-spawns-the-model-so-a-kind-does-not.md) — (v2) `agents-core` spawns the model so a kind does not: one owner for the deadline, the output cap and the child's environment — which is an ALLOW-LIST of exactly `{ HOME, USER }`, because a child handed only HOME reports itself logged out
