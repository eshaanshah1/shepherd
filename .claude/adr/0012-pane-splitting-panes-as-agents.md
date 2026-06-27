# 0012. Pane splitting: panes as agents; bracket-grouped collapsible sidebar

Status: Accepted
Date: 2026-06-28

## Context
SPEC §1 deferred splits ("≤1 agent per tab. No splits in v1"); §6 lists them
deferred. The v1 model is flat: **Agent == tab == one libghostty surface == one
`tabID`**, and that `tabID` is the unit of *everything* — the PTY env injection
(`SHEPHERD_TAB_ID`), socket correlation, agent state, the sidebar row, and
persistence.

We now want horizontal + vertical pane splitting. The pivotal question wasn't the
split mechanics — it was identity: **is a pane just layout, or a first-class
agent?** Shepherd's thesis is "run several agents at once, never babysit," so the
high-value answer is panes-as-agents (run and track two Claude sessions
side-by-side in one tab).

## Decision
**1. A tab becomes a container of a recursive binary split tree; the leaf pane is
the agent unit.** A tab no longer owns a surface directly — it owns a layout tree
whose leaves are panes. Each pane is a libghostty surface with its own per-pane id
(today's `SHEPHERD_TAB_ID`, now really a *pane* id) and its own `AgentState`.
Splits nest arbitrarily (split any pane again). **Correlation is unchanged** — the
env var is already injected per *surface*, so the socket/state map just keys off
the per-pane id; the plugin protocol and `report.sh` need no change.

- `⌘D` splits the focused pane **left | right** (vertical divider — iTerm's "Split
  Vertically"); `⌘⇧D` splits **top / bottom**. Dividers drag to resize (default
  50/50).
- `⌘W` closes the **focused pane**, falling through to close-tab when it's the
  last pane (then close-window when it's the last tab — today's behavior).
- `⌘⌥ + arrows` move focus directionally between panes.
- `⌘⇧↩` toggles **zoom** (iTerm's "Maximize Active Pane"): the focused pane fills
  the tab's terminal area (siblings hidden); toggle again to restore the split.
  Zoom is transient view state — not persisted, restored unzoomed.

**2. Sidebar: bracket-grouped, collapsible pane rows.** A split tab renders its
panes as rows gathered by a thin leading **bracket/rail** — no header row, no
forced chevron hierarchy. Unsplit tabs render exactly as today. Each group
collapses to a single line; the default collapsed/expanded state is a
`~/.config/shepherd` value (fits how the theme already lives there — ADR 0010).

- **Collapsed line = a strip of `<state-dot> <pane-number>` pips** (e.g.
  `● 1   ▸ 2   ○ 3`) — no enclosing brackets, no titles, just the number; writing
  each pane's title there is too much. Showing every pane's state dot directly
  *is* the attention rollup: a blocked/done pane stays visible at a glance while
  collapsed, so a collapse can never silently hide a pane that needs you (which
  would also contradict the dock badge, that counts across *all* panes). Pane
  titles surface on hover.
- With no header when expanded, **the bracket is the tab's interactive target**
  (click = select tab; context menu = rename / close-tab), so `⌘1–9`, rename, and
  close-tab still operate on the tab.
- **Zoom is shown in the sidebar:** when a tab has a zoomed pane, that pane's
  dot+number stays bright and the siblings **dim** — in both the collapsed strip
  and the expanded rows — so a tab reads as zoomed (and onto which pane) without
  switching to it.

## Consequences
- **Agent decouples from tab** — the biggest structural change. `AgentStore`'s
  flat `[Agent]` keyed by `tabID` becomes a tab list where each tab holds a pane
  tree; the socket/state map, dock badge, attention-nav (`⌘⇧A`), and notifications
  all move from per-tab to per-pane (the badge already aggregates — now over all
  panes). `ContentView`'s ZStack-of-surfaces becomes a recursive split render of
  the *selected* tab's tree.
- **Persistence becomes a recursive tree** (tree shape + split ratios + per-pane
  cwd), replacing the flat `[Persisted]` array; restore rebuilds the tree of
  surfaces.
- **`displayTitle` and the OSC-title feed move to the pane** (ADR 0011's priority
  applies per pane); the tab's collapsed title is *derived* from its panes.
- Render the group marker as a thin rounded bracket/rail, **not a curly `{`**
  (noisy/blurry at sidebar sizes). Keep sidebar controls `.focusable(false)`
  (ADR 0009) — splits add panes but must not add a keyboard-focus sink, and pane
  focus routing must hand first responder to the focused surface like today.
- **Supersedes** SPEC §1 ("≤1 agent per tab / no splits") and the splits item in
  §6; CLAUDE.md's "one surface per tab" architecture notes update with it.

## Alternatives considered
- **Sidebar — the numbered strip as the *always-on* form** (one row per tab, never
  expanding to per-pane rows). All pane states visible at a glance, but titles
  always behind hover. **A genuinely close call — and we keep the strip:** it *is*
  the collapsed mode (the `● 1   ▸ 2   ○ 3` pips above). What's provisional is
  making it the *only* mode — if the bracket's expanded per-pane rows prove too
  tall or busy in practice, drop expansion and ship the strip always-on.
- **Sidebar — full nested rows** (tab header + a child row per pane, dot + title +
  status always shown). Most informative, tallest, and reads as exactly the strict
  hierarchy the user wanted to avoid.
- **Panes as layout-only** (one tracked agent per tab; extra panes are untracked
  shells). Far smaller change, but throws away the main payoff — running and
  tracking multiple agents side-by-side — so rejected.
