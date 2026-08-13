# 0041. (v2) Agent *state* outlives the app too, so the daemon holds the hook socket

Status: Accepted
Date: 2026-08-13
Scope: `v2/` only.
Extends: [0036](0036-v2-a-session-outlives-the-app-so-a-pane-must-be-able-to-find-it-again.md), [0037](0037-v2-the-daemon-can-be-replaced-so-the-mirror-is-re-read-not-remembered.md).

## Context

Reported as "run `pnpm ship`, the app re-opens, every agent shows idle". Measured
on the running build before anything was changed:

```
sessions.list → 4 sessions, all alive, foregroundProcess "2.1.231"  (= claude)
agents.list   → {"agents":[]}
~/.shepherd/v2/agents-core/ → empty
```

The daemon was the process from 15:23 and owned every session's `zsh`; two of
those ptys predated the 19:14 app restart. So four `claude` processes were
running and the app believed none of them existed. The stored task records still
named the right panes — only pane → state was gone.

0036 established that a **session** outlives the app. This is the other half of
the same object: its **state** did not. Three things composed into a permanent
wrong answer rather than a momentary one.

1. **`AgentRegistry` is memory only.** A plain `Map`, no snapshot, and `activate`
   seeded `viewing` and `panes` from `sessions.list` but never state.
2. **Adoption only ever happens on a hook.** The pty survived, so `claude` never
   restarted and will never fire another `SessionStart`. Nothing re-adopted those
   sessions, so they were not agents at all.
3. **The ordering guard then ate the evidence.** With no entry, `current` reads
   `shell`, and `stop-policy` applies a mid-turn event only while
   `working`/`blocked` (ADR 0004). Every `PreToolUse`/`Stop`/`PermissionRequest`
   of the turn in flight was discarded. Only `UserPromptSubmit` escapes — so the
   dot stayed grey until the human typed the next prompt.

**And the hooks fired while the app was down were never anywhere to be found.**
`hooks.sock` was opened by the app (`packages/app/src/main/index.ts`), and
`report.sh` guards on `[ -S "$SHEPHERD_EVENTS_SOCK" ] || exit 0` with `|| true`
on the curl — deliberately, because a wedged listener must never stall the agent
it observes. The consequence was silent, total loss for the duration of a
restart.

A snapshot alone does **not** fix that, and the first attempt at this change
believed it did. The sweep was supposed to correct a stale `working`, but its
input is

```ts
hasForegroundProcess: basename(raw) !== basename(command)   // host.ts
```

— "is anything other than the login shell running". An interactive `claude` at
its own prompt satisfies that whether it is mid-turn or idle, which is why all
four live sessions reported `true`. **The sweep detects "claude exited", not "the
turn ended"** (its own reason string says so). So restoring `working` for an
agent whose turn finished during the downtime would stick at `working` until the
next prompt — a wrong "working" is worse than a wrong "idle", because you wait on
it instead of checking it.

## Decision

**The process that owns the ptys owns the hook socket, and agent state is
restored as the base its replayed events fold onto.** Two halves, and neither
works alone.

1. **The daemon serves `hooks.sock`** (`packages/daemon/src/main.ts`), on a path
   derived from `--socket`'s directory so it cannot disagree with the value
   `SHEPHERD_EVENTS_SOCK` already carries. `EventsIngress` takes a `deliver` sink
   instead of an `EventBus`, because there is no bus in the daemon.
2. **`SessionServer` forwards or journals, never both.** With a greeted `app`
   client it sends a `hooked` frame; with none it appends to `HookJournal`
   (bounded, dropping the **oldest** — a reducer's final state is decided by the
   tail — and reporting the loss count with the batch it belongs to).
3. **The replay is flushed inside the handshake**, which is `PtyFanout`'s
   "snapshot, register and replay are one step" across a process boundary: the
   drain empties the journal, so anything recorded between the reply and the
   flush would be held for a client already live.
4. **`hello` carries a role.** A paired device is a full session client in the
   same table (`remote/server.ts` accepts it there), and nothing on a phone
   reduces agent state — so a connected phone must neither receive hooks nor
   consume the replay the Mac is waiting for. Absent means `device`, the safe
   direction.
5. **The app has its own replay-then-live boundary** (`hook-relay.ts`). Main's
   handshake happens in `whenReady` *before the extension host is forked*, and
   the bus has no retention — the first working version of this replayed onto an
   empty bus and the restart smoke read `working`. `goLive()` is called after the
   startup activation loop, which is the moment main can honestly claim a
   consumer exists; nothing in main can know when a *child* subscribed to a
   topic.
6. **`AgentRegistry` snapshots and restores** (`persist.ts`), filtered against
   the live `sessions.list` and merged *under* anything a live edge already
   adopted. The `slot` is in the snapshot because without it a session is tracked
   but unresumable — `agents.resumeTarget` answered `null` for all four live
   sessions.

### Why the capability is advertised rather than version-gated

`hello`'s reply carries `hooks: <a socket this process really bound>`, and the app
keeps its own `EventsIngress` for when that is false.

A `PROTOCOL_VERSION` bump was the obvious alternative and it is worse. A mismatch
is *refused*, so a new app would find its terminals dead against the old daemon —
and `pnpm ship` always leaves the old daemon running, because it is holding the
user's agents. The only escape would be killing every agent, which is the one
thing this process exists to prevent. So the fallback degrades to exactly today's
behaviour instead: hooks work live, and only the ones fired during a restart are
lost, until that daemon goes away on its own.

## Consequences

- A turn that ends while the app is being replaced is **folded from the real
  event**, not guessed at. `smoke:daemon` asserts it end to end: the runner POSTs
  a `Stop` between the two passes with no app running at all, and pass 2 reads
  `idle` — reachable only with both halves present (`''` means nothing restored,
  `working` means nothing replayed).
- Agent state survives with its vendor slot, so `agents.resumeTarget` keeps
  answering across a restart.
- The journal is the daemon's lifetime, which is the sessions' lifetime — a
  daemon that dies takes its ptys with it, so there is nothing to persist.

## What this deliberately does *not* fix

**`agents-core` is on the wrong side of the process boundary, and everything
above is compensation for that.**

It is there by inheritance, not by design. §7b (2026-08-07) put extension
services in one utility process for *fault isolation* — "a wedged extension
cannot stall the SessionHost or the window" — at a time when sessions lived in
main too, so the app's lifetime was the only lifetime there was. R1 then answered
§7.7 by moving sessions into a daemon, explicitly so "UI restarts/updates without
killing agents". That created a second lifetime and nobody moved the agent state
machine into it.

Nothing in `agents-core` needs a window: it reads `sessions.list`, folds hook
events, writes `attention`. ADR 0033 already put extension *UI* in the renderer
as a separate `ui/` directory, so the service half is headless by construction.
If it ran in a host the daemon owned, the socket would be next to the reducer and
the snapshot, the journal, the role field, the capability flag and the app-side
relay would all be unnecessary.

That move is milestone-scale — command routing becomes bidirectional,
`attention` has to travel outbound, storage and settings need a host — and it is
the daemon seam §7b deferred. Recorded here so the next person reads it as a
known boundary rather than rediscovering it. **Anything added to the list above
is a reason to do the move instead.**
