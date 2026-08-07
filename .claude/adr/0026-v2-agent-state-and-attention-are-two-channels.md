# 0026. (v2) Agent state and attention are two channels, and only one alerts

Status: Accepted
Date: 2026-08-07
Scope: `v2/` only.

## Context
v1 had **one** channel. `AgentState` drove the sidebar dot, the dock badge,
notifications, the keep-awake decision and ⌘⇧A. When the nudges work needed a
second producer (a stopped rebase wants a dot), it could not write `AgentState`
without corrupting the hook lifecycle map — whose ordering guard depends on
nothing else touching that state — so it grew a *parallel* channel unioned in at
the badge. CLAUDE.md records the rule that came out of it: **a nudge never writes
`AgentState`.**

v2 inverted the rule and made attention generic: an extension says how much it
needs you, core owns every consequence. M2 is the first producer, and it exposed
the other half of the problem. `AttentionLevel` is `none | info | attention |
urgent`. It has **no `working` and no `idle`**, because it answers "how much do
you need the user", not "what is this agent doing".

So attention cannot drive the state indicator. Flock rule 8's five sheep states —
standing, walking, grazing, butting the fence, tipped over — are *agent* states.
Driving them from attention would put `working` on the dock badge; driving the
badge from agent state would rebuild v1's single channel with the same defect.

## Decision
**Two channels, one mapping between them, and the mapping is the only place
agent state becomes an alert.**

- `agents-core` owns `AgentState` (`shell | idle | working | blocked | needsCheck
  | error`) and publishes `agents.stateChanged`.
- `attentionFor(state, reason)` maps it: `needsCheck → attention`,
  `blocked | error → urgent`, everything else → `none`, which the store treats as
  a clear. The discriminator is the **state**, never the reason text.
- Core's `AttentionStore` already clears `attention` on the viewed edge and
  deliberately does **not** clear `urgent`. That pairing is load-bearing: it is
  v1's "need-to-check → idle on focus, never blocked" surviving with no second
  implementation. Looking at a permission prompt is not answering it.
- **Only `agents-core` declares the `attention` permission.** `claude-code`'s
  manifest omits it, so the one authorizer in the dispatcher refuses any attempt
  from there. The single-writer rule is enforced, not remembered.

**The alert level rides the event.** `agents-core` emits `agents.stateChanged`
and then calls `attention.set`: two ordered crossings of one port. A consumer in
main receives the event *before* the store has taken the new level, so anything
that asked the store on receipt would read the world from before the change. The
level is therefore computed once, in the mapping, and carried — the same
discipline `viewing` follows.

This was not theoretical. The badge was first written to compute
`attention.count()` when the agent event arrived, and `smoke:m2` measured it
reading **0** for a turn that had just finished. The badge now follows
`attention.onDidChange`, which is the only moment its count is true.

## Consequences
- A second agent vendor changes nothing here: it maps its protocol onto
  `AgentState` and inherits the alert behaviour.
- A future non-agent producer (nudges, PR status) writes **attention** directly
  and cannot disturb the agent lifecycle, which is v1's rule pointed the right
  way round at last.
- One dependency to revisit: main clears attention wholesale when the extension
  host dies, which is sound **only while `agents-core` is the single writer** —
  `AttentionStore` does not record which caller set an entry. The day a second
  writer exists, that clear needs per-caller bookkeeping. It is commented at the
  call site.
- Anything keyed off "a turn ended" reads `turnFinished`, never
  `state === needsCheck`, which misses the viewing landing (ADR 0020).
