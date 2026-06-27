# 0006. Sidebar lists all tabs (filtering deferred)

Status: Accepted
Date: 2026-06-27

## Context
SPEC §1 originally said the sidebar is an "agents only" list. In practice, with
one plain shell the sidebar was empty and disorienting ("where am I?"). We also
considered auto-hiding the sidebar at ≤1 tab.

## Decision
For now the sidebar lists **every tab**, with agent tabs annotated by their state
dot and plain tabs shown as `shell` (dimmed). One row per surface, keyed by
`tab_id`; the attention queue (badge / ⌘⇧A / notifications) is still **agent-only**
(blocked / need-to-check / error), so routing isn't diluted by plain shells.
Prioritize a working terminal first; richer filtering is later.

## Consequences
- The sidebar doubles as the tab navigator and the agent attention surface.
- Deferred: auto-hide the sidebar when ≤1 tab (revealed at 2+), and/or an
  "agents only" filter toggle. Easy to add — the model already distinguishes
  `shell` from agent states.
