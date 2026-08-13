# 0043. (v2) A placeholder may cover a root of captured screens, and carry a verb

Status: Accepted
Date: 2026-08-13
Scope: `v2/` only.
Extends: [0031](0031-v2-a-contributed-view-declares-itself-and-a-row-click-is-the-extensions.md), [0042](0042-v2-a-pane-may-have-no-session-and-that-is-not-a-ghost.md).

## Context

0042 makes a shelved task's tabs open as read-only panes showing what was on
screen when it was shelved. Two things then have to be true that were not:

1. the user has to be able to tell a photograph from a live terminal; and
2. there has to be a way back to the real thing.

Both are one sentence and one button over the root — and the shell must draw
them without knowing that `tasks` exists, let alone that `tasks.restore` is the
verb.

## Decision

### `placeholderOf` refuses over a LIVE pane, not over any pane

The guard read `if (!state || state.tree !== null) return undefined`. Its own
comment gives the reason, and the reason was never the panes:

> a stale line is the one way this feature can lie: `Creating the worktree` drawn
> over a running agent.

A root whose every pane is read-only has no running agent and nothing on its
way. The lie is unreachable there, so the guard narrows to what it was always
about: **no live pane**. A mixed root still refuses, because one live pane is
enough to make a line lie. `#seed` still clears the placeholder when a real pane
lands, so the state cannot accumulate falsehoods.

Note that `setPlaceholder` already accepted a root with panes — deliberately,
because the caller filling a root does not control when the pane lands. Only the
READ was guarded, and only the read changed.

### The placeholder may carry one verb

`RootPlaceholder.action` is `{ command, label, args? }` — a command id, a label,
and an argument object the kernel does not read (`unknown`, because typing it
would be the layout having an opinion about a value it only passes along). The
page draws a button and runs it through `commands.invoke` without knowing what
it does.

This is the rule 0031 sets for a contributed row's verbs, applied to a root. The
alternative was the shell knowing `tasks.restore` exists, which is the special
case 0031 exists to prevent.

### The banner is its own component, reading the same field

`ArchivedBanner` is not a mode of `EmptyState`: an empty root is drawn INSTEAD
of a tree and this is drawn OVER one. Both read `placeholder` off the same
snapshot, so the shell never holds a second copy of "what is this root" —
[0035](0035-v2-a-row-names-its-root-and-the-shell-derives-the-highlight.md)'s
rule, and the reason the page has no `isArchived` of its own. Core answers with
a placeholder only for a root with no live pane, so restoring replaces the panes
and the banner goes with them; nothing has to remember to take it down.

It is static. A pulse or a shimmer would say something is happening, and the
whole point of the root is that nothing is.

## Consequences

- An archived tab says what it is, in words, over the screens it is showing.
- The one verb that ends the state is on the surface you are looking at when you
  decide, and on the sidebar row, and both are the same command.
- One more consumer of `placeholder`, and it is the first that coexists with a
  tree. A future caller that wants a line over LIVE panes will find this guard
  in its way, which is intended: that caller is the one the original comment was
  written about.
