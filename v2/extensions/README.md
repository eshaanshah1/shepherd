# extensions/

Built-in extensions. Each is an ordinary package whose only workspace
dependency is `@shepherd/sdk` — lint-enforced (`tooling/eslint/boundaries.js`),
so a built-in cannot quietly reach into the kernel and stop being a proof that
the public API is sufficient.

`agents-core` and `claude-code` are being built now (M2, by phase — see the
[M2 plan](../../docs/superpowers/plans/2026-08-07-v2-m2-plan.md)); `tasks` is M3.
Occupants, per the
[core design](../../docs/superpowers/specs/2026-08-06-ade-v2-core-design.md) §5:

| directory | id | arrives | what it owns |
|---|---|---|---|
| `agents-core/` | `shepherd.agents-core` | M2 | the agent abstraction: state model, attention, the hook/event ingress that is not Claude-specific |
| `claude-code/` | `shepherd.claude-code` | M2 | the Claude Code adapter — the plugin/hook protocol, session resume, the lifecycle→state map v1 kept in `StopPolicy` |
| `tasks/` | `shepherd.tasks` | M3 | queued/scheduled work over sessions; the first extension with a view of its own |
| `worktree-hook/` | `shepherd.worktree-hook` | M3 | a script you choose, run in every worktree a task creates — the first extension to plug into another's point |
| `github/` | `shepherd.github` | M4 | the pull requests a task has open; the first extension to own a PANE (ADR 0044) |

An extension is a package with a `shepherd` manifest key and an `activate`
function.

**One extension may TYPE-import another and may not VALUE-import it.** Sharing
types is how a vendor extension speaks the noun it plugs into; duplicating the
union instead would drift. Sharing values is a different thing: §7c decided
cross-extension calls are *declared, not discovered*, so the runtime path is
`manifest.dependencies` + `extensions.get`, which the host can review and gate. A
direct value import reaches the same code with no manifest entry and no gate.
Lint-enforced in `tooling/eslint/boundaries.js`, proven with a planted violation.
