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

3. **Scratch (D9)'s persisted list — and ⌘T is already done.** The handoff's
   keystroke problem was solved by a third route it did not consider. `⌘T` is
   `COMMANDS.newTab` → `layout.newTab` (`main/menu-template.ts:99`) and the
   `tasks` composer moved to `⌘N` to free the conventional key; a contributed
   overlay declares its own accelerator through `registerViewType`
   (`main/view-registry.ts:45`), so neither `REGIONS` nor
   `contributes.commands[].key` was needed. That field is still read by nothing,
   and is now moot rather than pending.

   So the zero-ceremony shell exists: `⌘T` opens a loose tab without creating a
   task. **Done 2026-08-24** ([ADR 0047](../../../.claude/adr/0047-v2-a-rail-section-names-itself-and-loose-terminals-live-in-the-home-group.md)),
   and this paragraph asked for the wrong thing: there is no store to build. The
   persisted list was always there — `main/index.ts:1378` opens every persisted
   root at launch and a restored pane reattaches to the session the daemon still
   holds, so loose shells and their live processes already survived a relaunch.
   What was missing was the rail surface: nothing named the home group, so a
   shell was reachable only by closing a task's tabs until `closeRoot` fell back
   to `homeRoot`. It is a section now, named by its view's own title, with ⌘0 to
   reach it.

   **Read `menu-template.ts`'s opening note before binding any key.** AppKit
   resolves a menu key equivalent *before* the page sees the keystroke, so a menu
   item on a key does not compete with a contributed overlay on that key — it
   **deletes** it, silently. This is v1's workbench-keybinding lesson arriving in
   a second form, and it is why a bare-letter accelerator is dropped rather than
   honoured.

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

- **The root `tsconfig.json` references are missing four packages.**
  `extensions/scratch`, `extensions/github`, `extensions/worktree-hook` and
  `extensions/transcripts` are all absent from the list, while `pnpm typecheck`
  is `tsc -b` at the root — so **none of those four is typechecked by it**. This
  is M3's `extensions/tasks` finding in four more places, and it is the same
  silent kind: a planted type error produces no output. Found 2026-08-24 while
  adding `extensions/shell`, which IS in the list and whose reference was
  mutation-tested. Fixing it wants a planted error per package, one at a time —
  each may be hiding real errors nothing has ever compiled.
- **eight smokes → ten.**
- **1011 tests → 2200+** across the workspace.
- The design skill's own §3 claimed settings were "not designed yet" nine days after
  ADR 0040 landed them, and it claimed 22 primitives against `packages/ui/src`'s ~26
  and `v2/CLAUDE.md`'s "seventeen". Counts restated in prose rot; the fix is to point
  at the directory and the ADR instead, which is what it now does.
