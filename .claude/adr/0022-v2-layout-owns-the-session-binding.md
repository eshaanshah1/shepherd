# 0022. (v2) The layout lives in the kernel, and closing a pane is what ends a session

Status: Accepted
Date: 2026-08-07
Scope: `v2/` only.

## Context
v1's root architectural fault, and the single biggest thing this rewrite exists to
delete: **a PTY was owned by the view that displayed it.** A SwiftUI subtree
rebuild — a `_ConditionalContent` flipping, a tab switch remounting a pane —
created a fresh `ghostty_surface_t`, a fresh PTY, and hung up on the old shell with
its running `claude`. The tell was never an error; it was a changed `tty` and lost
scrollback, because a remounted plain shell is indistinguishable from the original.

v2's M0 fixed the *session* half by construction: `SessionHost` lives in the main
process, keyed by `SessionID`, created and destroyed only by explicit `create`/
`kill`, and a React unmount cannot reach it. That is the win the whole rebuild
rests on.

But M0 left the **layout tree in the renderer** (`renderer/commands.ts` held
`runCommand`, `app.tsx` held `useState<LayoutState>`), with the pane→session
mapping beside it. That was right for M0 and wrong from M1 onward, for three
reasons of ascending seriousness:

1. `LayoutAPI`, attention aggregation, and `isViewing` are all core concerns per the
   design, and extensions read the tree.
2. A second window would need a second copy of the same reducer.
3. The load-bearing one: **`layout.close` could not be what ends a session.** With
   the binding in a renderer, a `layout.close` arriving over the control socket
   (or from an extension, or from a phone) removes a node and leaks a live PTY,
   while the renderer's own ⌘W path kills it — two paths, one of which is silent.
   `app.tsx` called itself "THE one place a session is ended", and that sentence
   was about to stop being true the moment a second transport existed.

## Decision
**Core owns the layout.** `LayoutStore` (in `v2/packages/core/src/layout/`) holds
the tree, focus, zoom, the pushed viewport rect, and the pane→session map. The
renderer becomes a **projection plus a transport**.

The binding is enforced structurally rather than documented:

- **`LayoutStore` takes a required `SessionSink`** (`{ kill(id) }`). There is no
  constructor that omits it, so there is no way to build a layout that forgets to
  end sessions. A test asserts the converse directly — focus, rename, an observed
  cwd, a zoom, a viewport push and a re-projection must never reach `kill`.
- **Every mutation is a registered command**, all requiring the `layout`
  permission. ⌘D, a palette entry, `shepherd pane split`, and an extension are four
  *transports* into one funnel. v1 grew three routing paths that each
  re-implemented "and now fix up the focus", and they disagreed.
- **The ⌘W fall-through lives in one place.** `close` reports `wasLastPane`, and
  only that case reaches `onLastPaneClosed`. Any other pane closing a window is the
  classic Electron bug where a split vanishes because one of its panes was closed.

Where the session id is **not**: on `Pane`, which documents itself as carrying only
what the layout needs and what survives a relaunch; and not in `SplitTree`, which
stays pure geometry because it is the one core subpath the renderer may import
directly. A live session id belongs to neither.

Four supporting decisions, each of which v1 had already learned:

- **The viewport is pushed, not measured.** Core has no DOM and `neighbor` needs a
  rect, so the renderer publishes its content rect on resize and core caches it —
  exactly what v1's `ContentView` did. The consequence is the point: a focus
  command takes no rect argument and is therefore invokable from the CLI.
- **A divider drag previews locally and commits once**, on mouse-up. `setRatio` per
  mousemove through a command registry is a 60Hz IPC storm against the one funnel,
  with a debounced sqlite write behind it.
- **Persistence is debounced, with a `flush()` on quit.** v1 re-encoded its whole
  state on every `cd`; batching is only safe if quitting ends a batch.
- **A restore mints fresh pane ids and binds no sessions.** Live state never
  survives a restart, and reusing an id would let a stale binding from the previous
  run resolve to a new pane. A corrupt tree or an unrecognized `schemaVersion`
  starts fresh rather than refusing to open a window.

## Consequences
- The renderer can no longer answer "what is the layout?" from local state; it
  renders a snapshot pushed from main. A dropped `layout:changed` message is
  therefore a visible desync rather than a silent one — which is the correct
  failure mode, but it means that channel must never be allowed to fail quietly.
- The snapshot crosses as plain `SplitNode` data (already class-free readonly
  interfaces, so structured-clone safe). It deliberately does **not** go through
  `serializeNode`/`deserializeNode`: the latter mints fresh pane ids, which is
  right for a restart and would destroy identity on every update.
- React identity now matters more, not less. With every mutation arriving as a
  freshly-structured tree, a positional recursion would remount a pane's terminal
  view on a leaf→split reshape. The session survives (that is M0's win) but the
  reattach is visible, so nodes are keyed by pane id.
- Multi-window falls out: another window is another root over the same session
  pool. It is modelled, not shipped.
- Do not add a second path that mutates the tree, and do not put the session
  binding back on a view. If a new surface needs to close a pane, it invokes
  `layout.close`.

## Lesson
M0 moved sessions out of views and called the bug class closed. It wasn't: the
*binding* between a pane and its session was still view-side, so the same failure
was one new transport away from returning — this time as a leaked PTY rather than a
killed one. Fixing "who owns the object" is only half of it; the other half is
**who owns the association**, and the way to make that stick is a constructor that
cannot be satisfied without it.
