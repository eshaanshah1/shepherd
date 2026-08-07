# 0031. (v2) A contributed view declares itself, and a row click is the extension's

Status: Accepted
Date: 2026-08-08
Scope: `v2/` only.

## Context
Until M3, exactly one bus topic reached the renderer, by an allow-list main
owned — with its own comment saying "this table is what M3's declarative view
contributions replace". The replacement did not exist at any layer: no `ViewAPI`
(it threw), no `view.*` wire frame, no IPC channel, no `TreeDataProvider`
consumer, no region model, and `activateFor` had zero production callers.

Two things had to be decided to build it.

**How much crosses the port.** A `TreeDataProvider` is functions, which a
structured clone cannot carry.

**Who a row's command runs as.** `TreeItem.command` was documented as invoked
with `caller: {kind:'user'}`, and `authorize` returns an **unconditional ALLOW**
for that. Composed: any extension able to contribute a tree could put any command
id in a row and have it execute with full user trust — including commands its own
grant denies. M1 spent a phase making an extension's reach equal its grant, and
this is the one place that inverts, because the user really did click.

## Decision
**Only the declaration crosses.** The child keeps the provider; the host asks
`view.children` and the child answers; `onDidChange` becomes a **nudge** —
"there is something new to ask for" — rather than a push of data. So the host
decides when to read: a chatty extension cannot flood the renderer, and nothing
is drawn from a snapshot the host did not request.

**A row click is attributed to the contributing extension**, never the user. The
click is genuinely the user's; the command id behind it is not, and they cannot
see it. A contribution that wants a privileged verb declares the permission for
it, like everywhere else. A click on a view nobody owns does nothing — guessing a
caller in order to run it anyway is the failure this rule exists to prevent.

The mechanism was built against a **trivial consumer** (diagnostics contributing
a two-row tree), not against the task tree, because building it against its real
consumer would shape it around one caller. The trivial one carries the three axes
a static list would not exercise: a row whose label changes, a row carrying a
command, and a tint (a token name — an extension never sends a colour).

## Consequences
The dock knows no extension: it asks which views exist and draws them. `tasks`
then contributes its tree with `TreeItem`s and one `onDidChange`, and the core
learned nothing about tasks — which is sketch §2b's test of the view model, and
would have been the signal to redesign had it failed. `smoke:m3` asserts both
trees in the real DOM, because one passing would not distinguish "the mechanism
works" from "the mechanism works for its author".

Three defects found by running it rather than reading it, all now fixed: the
dock stayed empty because extensions activate *after* the window loads and the
renderer's first `list()` predates every registration (registration now
notifies); `ctx.clock.setInterval` does not exist, so the demo extension threw in
`activate` and took its own contribution down with it; and the dock read the
bridge off the global, which only `main.tsx` may do.

## Not decided here
`registerStatusItem` and **panel** views still refuse. M3b needs one dock holding
one tree, and `REGIONS` — declared in the SDK with zero consumers — is where
scope creep would enter.

This is also what blocks the ⌘T composer. A form needs either panel views
(`WebContentsView`, per-extension partitions) or the in-proc React seam (§7b),
both deliberately later; building it directly in the core renderer would hardcode
task-specific UI into the shell, which is the special case this ADR exists to
avoid. A task is creatable from the CLI and visible in the tree until then.
