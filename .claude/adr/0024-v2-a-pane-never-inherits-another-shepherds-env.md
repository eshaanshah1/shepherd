# 0024. (v2) A pane never inherits another Shepherd's correlation env

Status: Accepted
Date: 2026-08-07
Scope: `v2/` only, but the hazard it closes reaches **v1, while v1 is running**.

## Context
v2 sessions inherit `process.env` almost whole. `shellDefaultsFrom`
(`packages/platform/darwin/src/shell.ts`) strips a short list — the variables that
describe *Electron* rather than the shell — and copies every other key through.
That is right: a pane should have the user's PATH, their `LANG`, their editor.

v2 is developed **inside v1**. `pnpm dev` is typically run from a v1 Shepherd
pane, and v1 injects `SHEPHERD_TAB_ID`, `SHEPHERD_SOCK`, `SHEPHERD_CTL_SOCK` and
`SHEPHERD_PTY_SOCK` into every pane it opens. So v2's Electron main process
inherits a live v1 pane id and a live v1 socket path, and hands both to every
session it creates.

v1's globally-installed Claude plugin fires on exactly
`[ -n "$SHEPHERD_TAB_ID" ] && [ -n "$SHEPHERD_SOCK" ] && [ -S "$SHEPHERD_SOCK" ]`
(`claude-plugin/hooks/report.sh:24`). Measured in the session that wrote this ADR:
that predicate was satisfied.

M2 is the milestone that puts a real `claude` in a v2 pane. Without a fix, the
first dogfood run would have posted `{tab_id: <a v1 pane>, event: Stop|…}` to the
**running v1 app** — flipping an unrelated v1 pane through working / blocked /
need-to-check, badging its dock, and firing its notifications, driven by an agent
in a different application. `SHEPHERD_CTL_SOCK` is the same leak one door along:
v1's `shepherd` CLI, run in a v2 pane, drives v1.

Two things made this hard to see. It is not a bug in any single component — every
part behaves correctly in isolation — and the safety people assumed came from a
guard in v1's `report.sh`, a file v2 is *replacing*, rather than from anything v2
does.

## Decision
**The app strips every `SHEPHERD_*` variable it or any sibling Shepherd injects,
and injects its own afterwards.** `INHERITED_SHEPHERD_VARS` in `shell.ts` names
them; `STRIPPED` consumes it.

Three properties, each deliberate:

- **The list includes v2's own names**, not only v1's. The hazard is any Shepherd
  launched from any other, including v2-dev from v2-daily. It does not expire
  when v1 does.
- **It lives in the strip, not in the injection.** `WillCreatePatch` merges and
  has no delete channel (`session/host.ts`), so `onWillCreate` *cannot* express
  this. The one place that already decides what a session does **not** inherit is
  the only place it can go.
- **Two tests, one of which uses the real environment.** A fixture test proves the
  filter; a second asserts `shellDefaults()` — reading the actual `process.env` —
  carries no `SHEPHERD_*`. The second has teeth exactly when the suite is run from
  inside a Shepherd pane, which is the situation it protects, and is vacuous
  elsewhere. Removing the strip fails both.

Naming v2's variables differently (`SHEPHERD_SESSION_ID` / `SHEPHERD_EVENTS_SOCK`,
see the M2 plan's D10) is **necessary and not sufficient**: a distinct name does
nothing while the *other* app's name is still in the environment. Both halves are
required and they close different holes.

## Consequences
- A v2 pane cannot drive v1, and vice versa. The two plugins coexist by using
  different variables *and* different install paths (`~/.claude/skills/shepherd`
  vs `shepherd-v2`), with neither app editing the other's files.
- Anything that adds a `SHEPHERD_*` variable to a session must add it here too. A
  test asserts that every variable v2 injects appears in the strip list, so the
  omission fails rather than leaks.
- The general rule, worth stating beyond this case: **an app that injects
  correlation env must never pass one along.** Inheriting an identity is
  indistinguishable from having one.
