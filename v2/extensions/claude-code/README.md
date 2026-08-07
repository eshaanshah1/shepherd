# shepherd.claude-code

The Claude Code adapter — one *kind* registered into `agents-core`, not a
privileged path. It owns the hook protocol, the lifecycle map v1 carried in
`StopPolicy`, and session resume.

**Built in M2, arriving by phase** — see
[`docs/superpowers/plans/2026-08-07-v2-m2-plan.md`](../../../docs/superpowers/plans/2026-08-07-v2-m2-plan.md).

| file | phase | what it is |
|---|---|---|
| `src/stop-policy.ts` | P0 ✅ | `applyEvent`, `backgroundTaskCount`, `sessionEventAccepted` — pure, and the highest-value artifact carried over from v1 |
| `src/index.ts` | P4 | `activate`: registers the kind, subscribes `claude.hook`, holds the ownership lock |
| `src/manifest.ts` | P4 | manifest — declares `dependencies: ['shepherd.agents-core']`, and deliberately **not** `attention` |
| `plugin/` | P4 | `hooks.json` + `report.sh` — pure bash, no `jq`, `curl --unix-socket` |

## Four things that look like bugs and are not

Each cost a real debugging session in v1 and each has an ADR. `stop-policy.ts`
carries the long form; in one line each:

- **The ordering guard** (ADR 0004) — mid-turn events apply only while
  `working`/`blocked`. Hooks are not totally ordered.
- **Background-`Stop` suppression** (ADR 0015) — `Stop` fires while a backgrounded
  agent is still running, so a `Stop` the turn is paused on is a pause.
- **The viewing landing** (ADR 0020) — a turn ending under the user's eyes lands
  `idle`, not `needsCheck`. `viewing` is a **parameter** and stays one.
- **The ownership lock** — a nested `claude -p` inherits this session's env and
  fires hooks tagged with it. Two id spaces: Shepherd's `SessionID` and Claude's
  own `session_id`, and they are not the same thing.

## Imports

`@shepherd/sdk`, plus **type-only** imports of `@shepherd/ext-agents-core` — the
state vocabulary this kind maps onto. Lint-enforced: a *value* import is refused,
because the runtime path is `manifest.dependencies` + `extensions.get`, which the
host gates, and a direct import would route around it.
