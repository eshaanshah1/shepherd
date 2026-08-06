# extensions/

Built-in extensions. Each is an ordinary package whose only workspace
dependency is `@shepherd/sdk` — lint-enforced (`tooling/eslint/boundaries.js`),
so a built-in cannot quietly reach into the kernel and stop being a proof that
the public API is sufficient.

Empty until M2/M3. Occupants, per the
[core design](../../docs/superpowers/specs/2026-08-06-ade-v2-core-design.md) §5:

| directory | id | arrives | what it owns |
|---|---|---|---|
| `agents-core/` | `shepherd.agents-core` | M2 | the agent abstraction: state model, attention, the hook/event ingress that is not Claude-specific |
| `claude-code/` | `shepherd.claude-code` | M2 | the Claude Code adapter — the plugin/hook protocol, session resume, the lifecycle→state map v1 kept in `StopPolicy` |
| `tasks/` | `shepherd.tasks` | M3 | queued/scheduled work over sessions; the first extension with a view of its own |

An extension is a package with a `shepherd` manifest key and an `activate`
function; nothing here is loaded until M1 lands the extension host.
