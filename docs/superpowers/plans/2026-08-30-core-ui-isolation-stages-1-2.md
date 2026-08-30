# Core/UI isolation, stages 1 and 2 — what shipped, and what Stage 3 will find already done

Date: 2026-08-30
Implements: [`2026-08-30-core-ui-isolation-design.md`](../specs/2026-08-30-core-ui-isolation-design.md) §5, stages 1 and 2.
Decision record: [ADR 0052](../../../.claude/adr/0052-v2-a-pane-close-is-a-detach-and-termination-is-a-verb.md).

Stage 3 — the kernel leaving Electron — is **not** started. The design gates it on
M4's dogfood gate and nothing here anticipates it. This document exists so
whoever picks it up does not re-derive what is now settled, and does not walk
into the two things that are deliberately unfinished.

---

## The commitment, and where it currently leaks

Design §7: **the Electron app is a client with no privileged path.** It may do
nothing a socket client cannot, *including being `user`*.

Held, as far as Stage 2 can hold it:

- The renderer's control plane is nine bespoke `ipcMain` channels lighter. Every
  command it runs and every topic it follows goes through the same
  `ControlSurface` that `control.sock` adapts. Adding a command or a topic adds
  nothing to either transport.
- `session:kill` is **deleted**. It was a channel from the page straight to
  `SessionHost.kill` that no socket client had — and that the renderer never
  called. `sessions.terminate` is the verb now.
- `views.activate` / `views.invoke` / `views.present` / `settings.invoke` were
  renderer-only channels. They are commands.

Two leaks remain, and both are named rather than hidden:

1. **The app is still `user`.** `control-ipc.ts` asserts `USER` for the page, the
   way `layout-ipc.ts` did before it. `externalCallerSchema` refuses `user` from
   any socket, so this is precisely the privilege the design says Stage 3 removes.
   Nothing in stages 1 or 2 depends on it *not* having been removed: a
   **principal** (`app`, `device:phone-1`) is a client's name and is already
   separate from the caller kind a command runs as.
2. **The four attribution verbs refuse an external caller**
   (`main/in-process-only.ts`). They run a command *as another principal* — a row's
   verb runs as the extension that contributed the view (ADR 0031 D14), a settings
   page's runs as the extension that contributed the page — and the command id
   comes from the caller. Public, any principal holding `views` could become any
   extension, which is the exact hole D14 closed. The channel used to contain
   that; the guard restates it.

   **The fix, for whoever needs it:** the kernel should remember what a view
   *offered*. Every `views.children` answer passes through main already, so the
   command ids in `TreeItem.command` / `.presents` / `.actions[]` can be recorded
   per view type, and `views.activate` can refuse an id the view never offered.
   That covers trees completely. `component` views (ADR 0033) have no rows and so
   no offered set — their `views.invoke` needs a different answer, and the honest
   one is probably that a client which cannot mount the component has no business
   invoking as it. Nothing needs either until a second client draws a contributed
   tree, which is Stage 4.

---

## Stage 1 — lifetime and viewing (all in `packages/core`)

### Session lifetime

- `core/src/session/lifetime.ts` — `SessionLifetime`. `release(session, by)` ends
  the session **iff no other principal holds it**; `terminate(session)` ends it
  regardless. Holders are **asked** (`principals(id)`), not booked: the layout
  answers for the panes it shows, the viewer set answers for whoever is looking.
  A bookkeeping failure would be a pty held forever by a client that crashed.
- `LayoutStore.SessionSink.kill` → `release`. Still a required constructor
  argument, for ADR 0022's original reason. `CloseOutcome.endedSession` →
  `detachedSession`.
- `sessions.terminate` is registered by `registerSessionCommands` when a
  `lifetime` is supplied; absent, it is **not registered** rather than registered
  and failing — `/commands` is how a client is meant to find that out.

**Stage 3 will find:** nothing in `LayoutStore` decides a pty's fate any more, and
`SessionLifetime.end` is already an injected `(id) => void`. Pointing it at a
daemon `kill` frame instead of a local `SessionHost` is a one-line change at the
wiring, which is what the file's own comment says it is for.

### Viewing, per principal

- `core/src/attention/viewers.ts` — `ViewerRegistry`: `session → Set<principal>`,
  with `report`, `forget(principal)`, `viewersOf`, `isViewed`.
- **It is not a second answer to ADR 0020's question.** `ViewingResolver` still
  decides for *this window* from focus, zoom, overlay and app-active. It now
  reports what it decided under this client's principal; `sessions.viewing` is how
  a client that is not this window reports its own; `isViewed` is the only
  aggregation anywhere.
- The `session.viewing` topic carries `viewers: string[]` beside `viewing`, and
  `viewing` is `viewers.length > 0`. `agents-core` reads the same field it always
  read — its meaning widened rather than moved, so no extension changed.
- `sessions.list` rows carry the aggregate and the set.
- The viewer set is a `SessionHolder`, so "no push for a session another client is
  looking at" and "no kill for one another client is watching" are one fact read
  twice rather than two mechanisms that will drift.

**Watch for:** `forget(principal)` must be called when a client disconnects. Today
only the app reports, and it reports through `publishViewingEdges`, which is fed
by the resolver — so nothing can be stranded. The first socket client that calls
`sessions.viewing` needs a disconnect hook, and there is none yet: the control
socket's `/invoke` is request/response and has no session identity. That is real,
and it is Stage 3/4's to solve because it needs a client identity that outlives
one request.

### Claim-and-verify as a connect ritual

- `core/src/session/reconcile.ts` — pure. Takes claims, the authority's live list,
  and what somebody else already holds; answers `adopted` / `dropped` / `orphans`.
- `sessions.reconcile` is the verb. The app runs it after the startup activation
  loop, beside `hooks.goLive()`.
- **ADR 0036's orphan case is now computed.** It had been named in comments since
  R1 and calculated nowhere: a live pty that no client claims is logged with the
  verb that ends one. Deliberately not reaped — that is a decision with a UI
  attached (ADR 0031's rule).
- "Held by somebody else" is `SessionLifetime`'s notion, injected, so the reaper's
  idea of abandoned and the releaser's cannot disagree.

---

## Stage 2 — the app as a second client

### The surface (`packages/core/src/control/`)

| file | what it owns |
|---|---|
| `subscription.ts` | `SubscriptionState` — snapshot-then-delta, pull-with-nudge, nudge keys. Pure. |
| `topics.ts` | `TopicRegistry` — a topic's delivery mode, its snapshot provider, its key extractor. |
| `surface.ts` | `ControlSurface` — `invoke`, `list`, `subscribe`. Owns no verbs. |

**Snapshot-then-delta.** `subscribe` takes the snapshot and registers the listener
with no `await` between them, and the surface is the only place that can, because
only it holds both halves. A client that read and then subscribed would lose what
landed in between; one that subscribed and then read would apply it twice. The
renderer had exactly that, with a merge-under rule in `app.tsx` and a comment
explaining why it was correct — both gone.

**Pull-with-nudge.** A nudge carries no payload and at most one is outstanding per
subscriber; the reader acknowledges with `pull`. Over the socket the
acknowledgement is `POST /pull` naming the subscription (which the stream's first
`open` frame gives it), because HTTP has no upstream channel inside a response
body. A nudge names the **subjects** that changed, capped at
`MAX_NUDGE_KEYS` — without that, back-pressure on the view topic would trade one
flood for another, since every nudge would fan out into a read per contributed
tree and each of those crosses a process boundary.

**Undeclared topics still work**, as stateless push streams. `shepherd wait`
follows `*`, and refusing it would break the CLI for a guarantee the socket cannot
give anyway: opening `control.sock` already means being the user.

### What the renderer's namespaces became

| bridge member | now |
|---|---|
| `commands.invoke` / `.list` | `control:invoke` / `control:list` |
| `agents.get` | **deleted** — the subscription's first frame is the snapshot |
| `agents.onChanged` | `subscribe('agents.indicators')`, push + snapshot |
| `views.list` / `.children` | `control:invoke` of `views.list` / `views.children` |
| `views.activate` / `.invoke` / `.present` | new commands, in-process callers only |
| `views.onChanged` | `subscribe('views.changed')`, **nudge** + keys |
| `settings.list` / `.set` / `.reset` / `.setOpen` | existing commands, through `control:invoke` |
| `settings.invoke` | new command, in-process callers only |
| `settings.onChanged` | `subscribe('settings.changed')`, push |
| `settings.onVisibility` | `subscribe('settings.visibility')`, push + snapshot |

The bridge's namespaces survive on purpose. **They are what keeps the page from
naming a topic** — the preload passes constants, so the allow-list
`agent-relay.ts` used to hold in main is now the shape of `BRIDGE_SURFACE`, which
a test reads. `main/agent-ipc.ts`'s "this table is a deviation" comment is gone
with the table.

### What did NOT move, and why

- **The layout.** `layout:get` / `layout:changed` stay their own channels.
  `LayoutSnapshots` is the whole envelope on every push, so calling it a delta
  would be a lie without real diffing, and the page keeps every root mounted from
  it. Moving it is worth doing when somebody wants to diff it; it buys nothing
  today.
- **The session data plane.** Design §3: two channels, deliberately. Base64 on the
  hot path inflates it by a third and reintroduces the multi-byte boundary bug the
  byte frames exist to prevent.

---

## Measurements

`v2/tooling/scripts/bench-control.mjs`, three runs each side, 3000 kept-alive
`/invoke` calls per row, own app instance with throwaway directories.

| | before (`ac9488f`) | after (`fbf05e5`) |
|---|---|---|
| kernel handler, p50 | 117.4µs | 118.3µs |
| kernel handler, p90 | 137.9µs | 141.7µs |
| kernel handler, p99 | 291–408µs | 320–399µs |
| extension-host handler, p50 | 396.9µs | 401.3µs |
| extension-host handler, p99 | 4.54–4.76ms | 4.62–4.83ms |

p50 moved under 1%. p99 ranges overlap on both sides — that spread is GC, not
signal, and the max sample is tens of milliseconds in every run. The design's §6
baseline was 133µs p50 / 616µs p99; nothing regressed past it, and this machine is
simply faster than it was when that was written.

The renderer side is not on this bench (it is IPC, not a socket) but its call
count went **down**: agent state costs one subscribe instead of a subscribe plus a
read, and a burst of view changes costs one frame per read instead of one per
change.

---

## Gates

`pnpm typecheck`, `pnpm lint`, `pnpm test` green. `smoke:m3`, `smoke:daemon`,
`smoke:takeover` and `smoke:m2` all pass every check — including the two the brief
listed as a known-failing baseline, which pass here.

`smoke:m3` is the load-bearing one for Stage 2: it drives the real settings screen
through the new path (open, render, `settings.set`, verify the theme, reset,
close) and the real composer through `views.invoke`, in the real DOM.

---

## For Stage 3

Already done, so do not redo it:

- **The wire contract exists and has two consumers.** Whatever the kernel process
  serves, it serves `ControlSurface`; Electron main becomes a third adapter, not a
  new protocol.
- **Nothing in the layout kills a pty.** `SessionLifetime.end` is injected.
- **Viewing is per-principal already**, so a kernel with N clients does not need a
  schema change — it needs `sessions.viewing` callers with identities.
- **`sessions.reconcile` is the connect ritual**, not a startup branch. A client
  that connects to a kernel it did not start runs the same verb.
- **`agent-relay.ts`'s allow-list is gone.** Topic declarations replaced it.

Still to decide, and deliberately not decided here:

- Who reaps an orphan.
- Whether a client may hold a session it is not looking at (`sessions.hold`).
- A disconnect hook for `ViewerRegistry.forget`, which needs a client identity
  that outlives one request.
- The offered-command check that would let the four attribution verbs go public.
- `safeStorage` secrets and ADR 0045's login-shell `PATH` harvest, both of which
  the design already names as displaced by Stage 3 and neither of which is touched
  here.
