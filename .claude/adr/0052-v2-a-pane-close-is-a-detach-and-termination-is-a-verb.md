# 0052. (v2) A pane close is a DETACH, and termination is a verb

Status: Accepted
Date: 2026-08-30
Scope: `v2/` only.
Overturns: the "one terminator" half of
[0022](0022-v2-layout-owns-the-session-binding.md).
Generalises: [0020](0020-viewing-a-pane-is-one-predicate.md)'s `isViewing`,
[0036](0036-v2-a-session-outlives-the-app-so-a-pane-must-be-able-to-find-it-again.md)'s
claim-and-verify.
Implements: Stage 1 of
[`2026-08-30-core-ui-isolation-design.md`](../../docs/superpowers/specs/2026-08-30-core-ui-isolation-design.md).

## Context

ADR 0022 made `layout.close` the one thing that ends a session, and it was
right. The layout was the only structure that could point at a pty; a `close`
arriving over the control socket that removed a node and left the pty running
was a silent leak, while the renderer's own ⌘W path killed it — two paths, one
of them wrong. Binding the terminator to the close, structurally (a `SessionSink`
with no constructor that omits it), closed that.

What made it right was an assumption that has stopped holding: **one client.**
"This pane closed" and "nobody wants this session any more" were the same
sentence because there was nothing else in the world that could want one.

Three things now can. A phone paired to this Mac attaches to a pty and watches
it. A second window is another root over the same session pool — 0022 says so
itself, and calls it modelled rather than shipped. And the design this ADR
implements adds a third on purpose: the app renderer becomes a client among
clients, so that the wire contract has a second consumer before Stage 3 moves
the kernel out of Electron.

With any of them present, ADR 0022's rule kills an agent somebody is watching
because a window closed. That is v1's remounted-pane-is-a-new-pty bug pointed
the other way: v1 destroyed a pty because a *view* was rebuilt; this destroys one
because a *view* went away. Both are a view deciding a process's fate.

The daemon has never had this problem. `SessionServer` treats a client
disconnect as **detach, never kill** — a client going away says nothing about
whether the work should continue. The app was the half that disagreed.

Two smaller things arrived with the same premise:

- **`isViewing` is a boolean about this window.** ADR 0020 made it one
  predicate, computed once and threaded into the state machine, the badge, the
  banner, the chime and the push. With N clients "is the user looking at this"
  has N answers and one aggregate, and a Mac that banners a turn you just watched
  finish on your phone is 0020's original defect with a longer wire.
- **Claim-and-verify runs once, at startup.** ADR 0036 established that a
  restored `sessionId` is a claim the daemon settles, and implemented it inside
  `LayoutStore.#restore` — the only client, at the only moment. A second client
  connects whenever it connects.

## Decision

### 1. `layout.close` detaches; `sessions.terminate` ends

`LayoutStore.close` drops the pane→session binding and calls
`SessionSink.release` — renamed from `kill`, and still a **required**
constructor argument for exactly 0022's reason: there must be no way to build a
layout that closes a pane and tells nobody. `CloseOutcome.endedSession` becomes
`detachedSession`, because that is now what it is.

`SessionLifetime` (`core/session/lifetime.ts`) answers the question the layout is
no longer entitled to answer:

- `release(session, by)` — one principal let go. The session ends **iff no other
  principal holds it**, and the log line names whoever kept it alive.
- `terminate(session)` — end it regardless. This is `sessions.terminate`, a verb
  with a name, reachable from the CLI, a device, an extension and the app on
  equal terms.

A **holder** is asked, not told: `principals(session)` rather than a hold that
somebody has to hand back. The layout answers `['app']` while a pane shows the
session; the viewer set answers with everyone looking at it. Deriving beats
bookkeeping here — a derived answer fails as a wrong answer now, while a
bookkeeping failure is a pty held forever by a client that crashed.

`release` excludes the releasing principal, and that exclusion is load-bearing:
the app releases *as* it closes the pane, before its own viewing resolver has
re-run, so a principal that could hold a session against itself would leak every
close.

**Single-client behaviour is unchanged.** Close the only pane showing a session,
nobody else holds it, it ends — same pty, same moment. The change is only
visible when a second principal exists, which is the whole point.

### 2. `isViewing` becomes the SET of principals viewing a session

`ViewerRegistry` (`core/attention/viewers.ts`) holds `session → Set<principal>`.
It is **not a second answer to ADR 0020's question** — that is the rule 0020
exists to enforce, and it is kept. `ViewingResolver` is still the only thing that
decides whether *this window* is looking at a pane, from focus, zoom, overlay and
app-active. It now reports what it decided under this client's principal;
`sessions.viewing` is how a client that is not this window reports its own; and
`isViewed` is the only place anything aggregates.

- The `session.viewing` topic carries `viewers: string[]` alongside `viewing`,
  and `viewing` is `viewers.length > 0`. `agents-core`'s mirror reads the same
  field it always read, and its meaning widened rather than moving.
- `sessions.list` rows carry the aggregate and the set, so the mirror's seed
  (ADR 0041's problem) is seeded with the aggregate too.
- The principal comes from the **caller** the dispatcher verified, never from
  the arguments. A client that could name the principal could suppress another
  client's notifications, or keep a session it does not hold alive.
- The viewer set is a `SessionHolder`. So "nothing may push for a session another
  client is looking at" and "must not kill an agent another client is watching"
  are the same fact consulted twice, rather than two mechanisms that will drift.
- `forget(principal)` exists because a client that dies mid-view would otherwise
  suppress that session's alerts — and hold its pty — for the life of the
  process.

### 3. Claim-and-verify is a client's connect ritual

`reconcile()` is pure (`core/session/reconcile.ts`) and takes the authority's
answer rather than asking, so it does not learn whether "live" means a local
`SessionHost` or a daemon a socket away. `sessions.reconcile` is the verb: a
client hands over what it believes it is showing and is told which claims are
confirmed, which named a session that has ended, and which live sessions **nobody
at all** claims.

That third case is ADR 0036's orphan, which has been named in comments since R1
and computed nowhere. It is now computed, and logged with the verb that ends one.
It is deliberately not reaped: what to do about an orphan is a decision with a UI
attached, and inventing one ahead of a caller is what ADR 0031 declines to do.

"Held by somebody else" is `SessionLifetime`'s notion, injected — so the reaper's
idea of abandoned and the releaser's cannot disagree.

### 4. The page loses its private kill

`session:kill` was an IPC channel from the renderer straight to
`SessionHost.kill` — a path no socket client had, and one the renderer never
used. It is deleted rather than re-pointed. A page that wants a session ended
invokes `sessions.terminate`, which is what a phone, the CLI and an extension do.
This is the design's §7 commitment held in the smallest available case: when the
app's private path and the public verb both exist, the private one goes.

## Consequences

- **A closed pane can leave a live session.** Only when another principal holds
  it, and `sessions.reconcile` is how anything finds it again. Before this, the
  same situation was reachable only by a crash, and the pty was unreachable
  forever.
- `SessionSink.release` reads as a weaker promise than `kill`, and it is — the
  strength moved to `SessionLifetime`, which is a thing with tests rather than a
  side effect of a tree operation.
- Attention now suppresses across clients. A turn that finishes while your phone
  is open on the session lands `idle` here, with no badge and no banner. That is
  ADR 0020's own argument (`need-to-check` means *you have not seen this*)
  applied to the fact that "you" have more than one screen.
- `principalOf(caller)` is one derivation of a client's name, shared by the
  viewer set and the hold set. A second spelling of it is the drift to watch for.

## What this does NOT decide

**Who reaps an orphan.** Listed, logged, and left.

**Whether a client may hold a session it is not looking at.** Today the two
holders are "a pane shows it" and "somebody is viewing it", and a phone in your
pocket is neither. A `sessions.hold` verb is the obvious third, and it waits for
a client that wants one — the same rule that left the orphan surface unbuilt.

**The app being `user`.** It still is, in-process, and Stage 3 is where that has
to end (design §3: once the kernel is out of Electron, even the flagship app
cannot be `user`). Nothing above depends on that not having happened yet: a
principal is a client's name, and the caller kind a command runs as is a separate
question.

## Lesson

ADR 0022's rule was not wrong; its *premise* expired. The tell was that it was
stated as a fact about the layout ("`layout.close` is the one terminator") when
it was really a fact about the world ("there is one client"). A rule whose
justification names a condition should say so, because the day the condition
changes is the day the rule starts doing damage — and it will still read as
correct, because the sentence never mentioned what it depended on.
