# M4 — the dogfood gate, as a punch list (2026-08-12)

Supplements [`2026-08-08-v2-handoff.md`](2026-08-08-v2-handoff.md), which names M4
as "a week of v2 inside v2" and says "everything it needs exists". **Everything the
milestone's own exit criterion names does not exist**, which is what this file is
for.

The bar, from [`../specs/2026-08-06-ade-v2-core-design.md`](../specs/2026-08-06-ade-v2-core-design.md) §7:

> **M4 — dogfood gate**: develop v2 inside v2 for a week; minimal CLI
> (`ls`/`state`/`tell`/`view`/`wait`) rides the control socket. Exit = the cut line.

## The headline

`packages/cli/src/argv.ts:31` is the whole verb table:

```
task            new list spawn archive restore delete
session         list
agent           list quick-model
worktree-hook   get set clear test-run
```

**None of `state`, `tell`, `view` or `wait` exist.** `session list` is the only thing
near `ls`. `raw` reaches any registered command, so some of the machinery underneath
may be there, but the agent-facing verbs are not — and those four are how an agent
inside a pane drives the app at all. v1's entire `controlling-shepherd` skill is
built on `tell`/`view`/`wait`. Together with the handoff's own "no `shepherd` shim on
PATH", the loop that makes this thing agent-native is the largest hole in the gate.

## Blockers, in the order to take them

1. **The `shepherd` PATH shim.** Nothing else matters until an agent can type
   `shepherd`. v1's `CLIShim` is the reference *including its scar*: an in-place
   update dangles the symlink, `which` skips a dangling link, PATH falls through to
   `Shepherd.app/Contents/MacOS`, and a case-insensitive filesystem matches the GUI
   binary — so typing `shepherd` launches a second copy of the app. Create-or-repair,
   never replace (ADR 0005's rule).

2. **`tell` / `view` / `wait` / `state`.** `argv.ts` owns no verbs and says the
   registry is the one verb table, so this is table entries plus whatever commands
   are missing under them. Two things v1 measured that carry over: a multi-line
   prompt must be **pasted, not typed** (a typed newline is an Enter press — ADR
   0034 already re-learned this for `tasks.spawn`, which is why a prompt travels as
   a file), and `wait` is a client-side poll rather than a subscription.

   **This is the first-party fast path's first customer.** Four verbs for one user:
   no manifest, no permission ceremony, no name resolution.

3. **⌘T, and then Scratch (D9).** One item, not two. The handoff has Scratch as
   "another `component` view plus a store, same shape as the composer", but both
   need a keystroke and `contributes.commands[].key` **is read by nothing today**.
   Read the key field. Do **not** open the `REGIONS` door — ADR 0031 names it as the
   scope-creep door and it is not needed for a keystroke. Without Scratch, opening a
   plain shell means creating a task, which is the friction that makes you close the
   app.

4. **Plugin-install robustness.** `~/.claude/skills/shepherd-v2` is a hand-made
   symlink and `pnpm ship` replaces the bundle it may point into. v1's failure mode
   here is silent: hooks fire nothing, every pane sits at `shell` forever, and it
   looks exactly like agent tracking being broken. A launch-time repair check beats
   ADR 0005's five-case classifier for now.

5. **Address re-resolution on a network change.** Listed as deliberately open, and
   it should not stay that way through a dogfood week on a laptop that moves between
   ethernet and wifi — the recorded bug is the work Mac advertising its ethernet
   address after the cable came out.

## Verification debt the week would run on top of

- **The two-Mac R4 gate.** This Mac has LEFT the net (`remote.leaveNet`), so re-join
  from the other machine first.
- **⌘, in a shipped build**, both contributed pages, and the quick-model round-trip
  in both directions (the screen follows a CLI write because the push comes off the
  bus).
- **W5a and W5b** owe live runs, though those are v1's.

## The gap M4 does not measure

**v2 has no workbench.** v1's ⌘G — staging, blame, conflict resolution, PR review
threads — is the differentiator and it does not exist here, gated behind panel views
that currently refuse. M4 can pass while v2 is still worse than v1 for the thing the
day is mostly spent on. Decide up front whether the week is allowed to keep v1 open
for review work; if it is, say so, because otherwise the gate is set below the bar
that matters.

## The smoke suite is a tax on the wrong cadence

There are **ten** smoke scripts, not the eight the handoff documents —
`smoke:mirror` and `smoke:daemon` are undocumented. Running them serially at the end
of a session costs ~30 minutes, and the accretion is structural: one smoke per
milestone means M1's boot-and-split assertions are paid forever, while `smoke:m3`
cannot run without booting the app, opening a terminal and creating a task anyway.

Their value is not in question. The archive-on-close defect was wired to a pane id
the layout regenerates on restore, and **every unit test passed because each supplied
both halves of the correlation** — a test that provides both sides of an agreement
cannot discover that the sides disagree. That is the irreplaceable class.

Two measurements before cutting anything, because M3 found **three gates that were
passing without checking anything**:

1. **Time each script.** The likely finding is that the 30 minutes is Electron boot
   paid ten times rather than assertions, in which case sharing one booted instance
   beats deleting anything and costs no coverage.
2. **Mutation-test each script** — break what it claims to protect, confirm red.
   Anything that stays green is deletable today at zero risk.

Then split by what they protect rather than by which milestone shipped them: a
**gate smoke** (boot, one pane, one pty, one command through the bus, clean quit) on
every change, and the **full suite** hung off `pnpm ship`, which is already the only
path to the app you use. And change the rule for new ones — a smoke exists to cover
**a correlation a unit test structurally cannot**, not because a milestone ended.

> Not run here: ten Electron smokes spawn apps and touch instance locks while the
> daily driver is running. That is the user's call to schedule, not a thing to launch
> underneath them.

## Doc staleness found while writing this

The handoff is drifting in the direction that flatters the project, so these are
worth correcting at the same time:

- **eight smokes → ten.**
- **1011 tests → 2200+** across the workspace.
- The design skill's own §3 claimed settings were "not designed yet" nine days after
  ADR 0040 landed them, and it claimed 22 primitives against `packages/ui/src`'s ~26
  and `v2/CLAUDE.md`'s "seventeen". Counts restated in prose rot; the fix is to point
  at the directory and the ADR instead, which is what it now does.
