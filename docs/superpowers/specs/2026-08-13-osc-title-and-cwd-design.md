# OSC title and cwd reach the layout

**Date:** 2026-08-13
**Status:** design, approved
**Scope:** `v2/` only.

## The problem, as reported

> Whenever I create a new tab inside a task, it does not update with the OSC
> title. I believe this is because a tab is created with a `userTitle` in place,
> which is not letting the OSC title come through. But the `userTitle` is just
> the cwd.

The symptom is real. The diagnosis is not, and the difference is the whole
design.

## What is actually happening

`displayTitle` (`v2/packages/core/src/layout/pane.ts:57`) resolves a pane's name
in three steps: the user's name, else the program's OSC title, else a two-component
tail of the cwd. The tab strip and the sidebar both read it, and `layout.listRoots`
resolves it once so they cannot drift.

Three findings, in the order they matter:

1. **A new tab inside a task already has `userTitle: null`.** `layout.newTab`
   (`layout/commands.ts:373`) passes no title. Verified against the running app
   over its control socket: the only panes carrying a `userTitle` are task anchor
   tabs, and theirs is the task's own name, never the cwd.

2. **`Pane.title` — the OSC title — is always the empty string, because nothing
   in v2 ever writes it.** `LayoutStore.observe()` (`layout/store.ts:799`) is the
   only writer of `title` and `cwd`, and it has **zero callers**. The renderer's
   `TerminalLike` exposes `onData` and `onResize` and nothing else; xterm's
   `onTitleChange` is never subscribed to, and no OSC 7 handler is registered
   anywhere.

3. So every pane falls through to the third step and shows its cwd tail forever.
   Setting `userTitle` to null would change nothing — it is already null.

The same absence freezes the cwd. A pane's `cwd` is whatever it was created with
for the life of the pane, because `observe` is the only thing that could move it.

There is real data arriving and no listener. The user's shell (oh-my-zsh,
`lib/termsupport.zsh`) emits **OSC 2** on `preexec` and `precmd` (line 21) and
**OSC 7** as `file://<host><percent-encoded-path>` on `precmd` (line 158). The
OSC 2 branch is gated on `$TERM` matching `xterm*`, and sessions are created with
`TERM=xterm-256color` (`core/src/session/host.ts:37`), so it is live today.

## Where the sequences get picked up

**`TerminalMirror`** (`v2/packages/core/src/session/mirror.ts`) — a headless
xterm, in the daemon, fed every byte of every session, described by its own
header as "the host's authoritative view of what a session's screen IS". It
already parses these sequences and throws the result away.

The alternative was the renderer: subscribe xterm's `onTitleChange` in
`xterm-terminal.ts` and invoke a new `layout.observe` command. Smaller — about
four files against seven — and rejected, because **a pane that is not the active
tab is suspended and holds no terminal at all** (`pane-sessions.ts:152`). Every
background tab's title would freeze at whatever it was when you last looked at
it, which is most of the tab strip. The mirror never stops parsing, so it has no
such hole, and it covers remote sessions by the same route everything else does.

## The seam

One fact travels from the pty to the layout store, on the route `onResize`
already travels. Each step is a copy of the `onResize` step beside it:

```
TerminalMirror                      report title (onTitleChange) and cwd (OSC 7 handler)
  -> PtyFanout                      passthrough
  -> SessionHost.onObserved         new listener set, twin of onExit / onResize
  -> protocol.ts RESPONSE.observed  new frame kind
  -> session/server.ts              broadcast, beside RESPONSE.resized
  -> session-client.ts              new listener set, beside the resized branch
  -> SessionRouter.#announceObserved   local + per-member, copy of #announceResize
  -> main/index.ts                  store.paneForSession(id) -> store.observe(pane, patch)
```

Main owns the layout store directly, so the last step is a direct call: no new
command, no new permission, nothing crossing the extension port.

`displayTitle`, the renderer, the tab strip and the sidebar are **untouched**.
They already do the right thing with a `title` that is no longer always empty.

## What the mirror reports

**Title** — `terminal.onTitleChange`, which xterm fires for OSC 0 and OSC 2.
It does not fire for OSC 1, the "tab name" oh-my-zsh also sends; that is fine,
OSC 2 carries the same string and OSC 1 is the narrower of the two.

**cwd** — `terminal.parser.registerOscHandler(7, ...)`. The payload is
`file://<host><percent-encoded-path>`, ST-terminated. Two rules:

- Percent-decode the path.
- **Ignore the sequence when the host is neither empty nor this machine's own.**
  An OSC 7 from an `ssh` session running inside the pane names a directory that
  does not exist here, and writing it would make the pane restore into nothing.

The handler returns `false` so xterm's own dispatch is unaffected.

## Noise control

`observe()` gains a no-op guard: identical title and cwd returns without touching
the tree. Without it every shell prompt rewrites the pane, pushes a full layout
snapshot to the renderer (`layout-ipc.ts:184`, not debounced) and schedules a
persist.

Genuine changes still fire twice per command, since oh-my-zsh re-titles on both
`preexec` and `precmd`. That is human-rate. The bus announcement downstream is
already debounced at 100ms, and the comment on it (`main/index.ts:849`) predicted
exactly this feature: *"an OSC title landing during a build is a burst of them"*.

## What this also fixes

- **cwd stops being frozen.** `cd` is tracked, so a new tab inherits the
  directory you are actually in and a restored task tab comes back where you left
  it rather than where it started.
- **Background tabs keep up**, which is the case the renderer-side alternative
  would have missed.

## Out of scope

Task-spawned agent panes keep their `userTitle` (`"<task> · <repo>"`, set at
`extensions/tasks/src/index.ts:1254` and `:1328`) and still beat the OSC title.
That is a deliberate keep: the sidebar rows and the tab strip key on those names,
and dropping them would leave a spawned pane unnamed until its agent happened to
emit a title.

Human rename and quick-agent naming remain future work. `displayTitle`'s
priority order already supports both the day they arrive — neither needs anything
from this change.

## Testing

- `mirror.test.ts` — feed OSC 2 and OSC 7 byte sequences and assert what is
  reported; assert a foreign-host OSC 7 is ignored; assert a sequence split
  across two `feed` calls still parses.
- `store.test.ts` — `observe` with identical values notifies nobody and schedules
  no persist.
- `session-client.test.ts` — the new frame reaches its listeners, following the
  shape of the existing `resized` test.
- **`smoke:m3`** is the one that decides. A unit suite cannot tell you a real
  pty's title reached a real tab strip, and this repo's scars are all of that
  kind. Open a tab, write `printf '\e]2;hello\a'` into its session, assert
  `layout.listRoots` reports `label: 'hello'`.

## Risk

cwd tracking is the sharp edge: `cwd` is persisted and feeds both tab restore and
new-tab inheritance, and today it cannot move. The behaviour is right, but it is
a live change to something that has been static. If it misbehaves, the title half
stands alone — the two are independent patches through the same seam.
