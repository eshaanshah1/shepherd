# shepherd.agents-core

The **vendor-blind** agent noun: the state model, the mapping onto core's
attention channel, the reconciliation sweep, and the extension point vendor kinds
register through.

Nothing here knows what Claude is. That is the whole design (sketch §7c): a kind
maps its own protocol onto `AgentState`, so `codex` / `opencode` / `gemini-cli`
are each a third-party extension registering into `agents.kinds` rather than a
fork. `claude-code` is one kind, not the shape of the API.

**Built in M2, arriving by phase** — see
[`docs/superpowers/plans/2026-08-07-v2-m2-plan.md`](../../../docs/superpowers/plans/2026-08-07-v2-m2-plan.md).

| file | phase | what it is |
|---|---|---|
| `src/state.ts` | P0 ✅ | `AgentState`, `StateTransition`, `rollUp` — pure vocabulary, no vendor |
| `src/index.ts` | P3 | `activate`: the `agents.kinds` point, the registry, the sweep, the attention mapping |
| `src/manifest.ts` | P3 | the manifest — the **only** one in this repo declaring `attention` (plan D8) |

## Two things to know before changing it

- **`AgentState` is not `AttentionLevel`.** Core's attention channel has no
  `working` and no `idle` — it answers "how much do you need the user", not "what
  is this agent doing". They are two channels on purpose (plan D7); conflating
  them would put `working` on the dock badge.
- **This is the only writer of attention for agent sessions** (v1's "a nudge never
  writes `AgentState`" rule, pointed the other way). A second writer breaks the
  ordering guard, which depends on nothing else touching that state.

Imports allowed: `@shepherd/sdk` only. See `v2/tooling/eslint/boundaries.js`.
