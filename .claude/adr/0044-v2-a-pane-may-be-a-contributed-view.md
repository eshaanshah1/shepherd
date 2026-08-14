# 0044. (v2) A pane may be a contributed view

Status: Accepted
Date: 2026-08-14
Scope: `v2/` only.
Extends: [0033](0033-v2-extension-ui-is-in-proc-react.md), [0042](0042-v2-a-pane-may-have-no-session-and-that-is-not-a-ghost.md).

## Context

Every leaf of the layout tree was a terminal. `makeRenderPane` returned
`TerminalPane` unconditionally, and `ViewProvider`'s surfaces were `dock` and
`overlay` — a sidebar section and a modal card. So an extension could draw a
list beside the terminals and a form over them, and nothing in between.

That is enough for everything built so far, and it stops being enough at the
first surface with a **subject**. The one that forced this is a task's pull
requests: a list of PRs with their checks, files and review threads is not a
sidebar row (it is a page), not an overlay (you keep it open while you work, and
come back to it after a relaunch), and not a terminal (there is no program). It
is a place, and the app had no way to make one.

The type already said otherwise. `ViewRef` has carried
`{ kind: 'view'; type; state }` since M1 and `layout.open` has taken it since
M1 — declared in the SDK, implemented by nothing, and refused across the port
with a `NotImplementedError` naming a milestone. This ADR is that clause landing.

## Decision

**A `Pane` may carry a `view`, and a pane that carries one shows a contributed
component instead of a terminal.** It never gets a session.

```ts
interface PaneView { readonly type: string; readonly state?: unknown }
```

`layout.split` and `layout.newTab` accept it; `serialize.ts` persists it;
`ExtensionPane` draws it; `ViewProvider` gains `surface: 'pane'` so an extension
can declare that its component is for one.

### The third pane with no session, and the reason it is a third field

`readOnly` (0042) was the second, and folding this into it was the obvious
saving. It is wrong, because the two are absent for opposite reasons: a
read-only pane **had** a session and is replaying what it printed, while a view
pane never had one and never will. One flag meaning both would need a second
field to tell them apart at the point of drawing — which is this one, arrived at
by a longer road.

The enforcement is the same shape 0042's is, and deliberately so: not a branch
inside `TerminalPane`, but the renderer never mounting it. `TerminalPane`
attaches on mount and attaching spawns a pty, so the guard has to sit above it.
A shell running behind a PR list would be visible nowhere, killed by nothing,
and indistinguishable from a pane the user opened.

### `type` is a registered view, never a component name

The renderer resolves `type` against the contributions an extension registered,
and only then resolves that contribution's `component` against the static table
(ADR 0033). Two hops where one would do, and the second hop is the point: a pane
is **persisted**, so a `view` on disk is a value that outlives the process that
wrote it. If it named a component directly it would reach the renderer's table
with no manifest entry behind it and no extension accountable for it — a
persisted record would be a way to draw arbitrary contributed UI. Naming a
registered type means the extension has to be loaded and to have declared the
view before anything is drawn.

It also gives the restore path an honest state. A pane restored before its
extension activates resolves to nothing for a moment, draws "waiting for whoever
draws this", and fills in when the registration arrives — where a component name
would either work (bypassing activation entirely) or fail permanently.

### The view owns the rectangle: no head

A terminal has a pane head because a grid of characters cannot say what it is. A
view can. A shell-drawn title strip over a view that titles itself is §6's
repeated-name rule broken by the shell rather than by an extension, so a view
pane gets no head, no padding and no border — two CSS declarations, `background`
and `overflow`, and no third.

### `state` is the subject, and the kernel never reads it

An id, a path, a pair of them. It round-trips through the store and the
persisted record untouched, reaches the component as `unknown`, and is checked
there — the same bargain `TreeItem.data` already makes, and it has to be: a
kernel that validated it would have to know what a pull request is.

What persists is therefore the **subject, not the contents**. A restored review
pane re-reads its PRs; it does not restore a three-week-old view of them. That
is the difference from 0042, where the bytes *are* the thing.

### A malformed `view` on disk is dropped, not thrown on

`deserializeNode` throws for a bad `axis` and returns `null` here, and the
asymmetry is the cost of the failure: a bad axis is a tree with no shape and
nothing can be drawn, while a bad view is one pane. Restoring it as an ordinary
empty pane loses less than refusing to restore the window.

### `done()` closes it

`ExtensionViewProps.done` is "I am finished" — an overlay closes on it and a
dock section ignores it. For a place, the honest reading is that the place is
finished, so the shell invokes `layout.close` on that pane: the same door ⌘W
uses, so a view cannot end its own life by a path that skips the one terminator
(ADR 0022).

### It is handed `focused`, which a dock section is not

A pane binds keys — Esc, `⌘⇧]`, a letter — and a background pane that still
answered them would fight the one you are looking at. Passed from the snapshot
the grid is drawn from rather than derived, for ADR 0035's reason. That is also
why `ExtensionPaneProps` is its own type rather than a widening of
`ExtensionViewProps`: `focused` and `state` mean nothing to a dock section, and
a shared type would promise both to every contributed component.

## Consequences

- An extension can own a place in the grid. `github` is the first and the reason
  this exists; a diff view, a log viewer and a preview are the shapes that
  follow, and none of them needs anything new here.
- `layout.open` across the port is still unimplemented. A pane opens through
  `layout.split` / `layout.newTab`, which is the funnel every other mutation goes
  through (§4.3) — `open` remains a nicer front door for the same commands and
  can land whenever something wants it.
- `EXTENSION_PANE_UI` starts empty. A build with no pane components can still
  restore a persisted view pane, and says so inside it.
- The tab strip names a view tab from `userTitle`, set by `layout.newTab`'s new
  `title`. Nothing else could: a view pane has no program, so nothing ever sets
  an OSC title on it and every contributed tab would otherwise read `term`.
