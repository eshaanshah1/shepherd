# 0037. (v2) The daemon can be *replaced*, so the mirror is re-read, not remembered

Status: Accepted
Date: 2026-08-10
Scope: `v2/` only.
Extends: [0036](0036-v2-a-session-outlives-the-app-so-a-pane-must-be-able-to-find-it-again.md).

## Context

0036 established that a session outlives the app. This one is the mirror image,
and it was found in a live app rather than reasoned about: **the app can outlive
the daemon**, and `SessionClient` had no way to notice.

Measured on the running build. Main had been up since 15:19 and was talking to a
daemon started at **16:34** — the one it booted with was gone. `sessions.list`
reported four sessions; `ps` found processes for two of them. The other two were
ptys of the dead daemon, and their panes had been black ever since, while panes
opened after 16:34 streamed normally. The user's report was "streaming is broken
on some panes", which is exactly what that looks like from the outside.

Three layers each did the locally-correct thing, and the composition was a lie:

1. **The mirror is filled once.** `#sessions` is cleared and repopulated only in
   `start()`. A reconnect ran `#reattachAll()` and nothing else, so main kept
   believing in every session the previous daemon held.
2. **The refusal was discarded.** `#reattachAll` sent its attach through `#send`,
   which registers no `#pending`. The daemon *does* refuse — `SessionHost.attach`
   returns `unknown-session` and `SessionServer` replies `err` — but the reply
   carried a seq nobody was waiting on, so `#onFrame` dropped it. This is the
   same defect the hello handshake had already been fixed for once: the one
   message that explains the failure, received and thrown away.
3. **An unknown session reads as an idle one.** `SessionHost.foreground` answers
   `{ hasForegroundProcess: false }` for an id it has never heard of — correct in
   isolation ("gone is running nothing"), but against a stale mirror it renders a
   dead session as a healthy shell sitting at a prompt.

Nothing polls for a session's absence: panes learn it from `onExit` and nowhere
else. With no exit ever announced, the pane stayed black for the life of the app.

And the daemon's own exit left **no trace at all**. `spawnDetached` used
`stdio: 'ignore'`, so why it went is unrecoverable — the process that owns every
pty in the product was the one process that could not say why it died.

## Decision

**1. A reconnect re-reads the inventory; only a first connect trusts `start()`.**
`#connect` reads `#everConnected` *before* setting it and, on a reconnect, awaits
`#resync()`: list the daemon, adopt what it has, and `#bury` anything we hold
that it does not — delete it from the mirror and announce its exit through the
same `#announceExit` a normal pty exit already uses. No new downstream wiring;
the pane takes the path it takes when a shell exits.

**2. A failed resync buries nothing.** Same rule `foreground` keeps one process
along: "I could not look" must not be reported as "nothing is there". A daemon
too slow to answer is not a daemon with no sessions, and guessing wrong costs the
user every agent they had running. The ids to judge are also snapshotted *before*
the request, so a session created while it is in flight is not condemned by an
inventory taken before it existed.

**3. `#reattachAll` reads its answer.** It goes through `#request`, logs a
refusal, and buries the session on one. Two sources disagreeing is the case
worth handling: only the refusal was measured against a real pty.

**4. The daemon gets somewhere to die.** `spawnDetached` takes a `logFile` and
the launcher passes `<support>/daemon.log` — a file, never a pipe, because a pipe
to a departed parent eventually blocks the writer. It rotates at 8 MB at spawn
time, the one moment nobody holds the fd.

**5. The daemon survives an uncaught fault instead of exiting.** It installs
`uncaughtException` / `unhandledRejection` handlers that log loudly and stay up,
plus an `exit` handler so an unnamed route still leaves a line.

## Consequences

The trade in (5) is the one to revisit, and it is deliberately not the usual
answer. Swallowing an uncaught fault leaves a process in an undefined state. But
the asymmetry settles it: exiting **guarantees** the loss of every agent the user
is running, continuing merely **risks** a degraded daemon, and the faults this
actually catches live in the remote/pairing/sqlite paths that a Mac's own
terminals never touch. It is only honest because it is loud — if `daemon.log`
ever shows one of these without a matching bug being findable, reverse it.

Two things this does **not** do. It does not make a dead pty come back: the
session is gone, and the pane now says so instead of pretending. Reviving it is
0036's resume seam, which already knows how. And it does not explain the
16:34 exit — that daemon logged nowhere, which is precisely why (4) exists.

Covered by `session-client.test.ts` › "a daemon that restarted underneath us":
that a vanished session is buried, that a surviving one is kept, that a viewer is
not re-attached to a ghost, that an unlisted-but-present session is adopted, that
a refused re-attach is reported, and that an unanswered inventory keeps
everything.
