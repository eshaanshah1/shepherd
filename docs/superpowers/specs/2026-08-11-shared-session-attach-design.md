# Design: this Mac as a second viewer of another member's session

**Date:** 2026-08-11
**Status:** approved, not yet implemented
**Builds on:** `2026-08-11-shep-nets-design.md` (membership),
`2026-08-09-v2-attachment-and-remote-design.md` (R0–R3),
`2026-08-11-t3code-remote-access-teardown.md` (what to steal, what to avoid)

## What this is

Opening a row that belongs to another member of the shep-net **attaches this Mac
as an additional viewer of that session's pty**. Its screen appears here, both
ends stream live, both can type, and the pty's size is arbitrated between them.

Today the row's verb runs over there and *that* machine's window changes, while
nothing appears here at all.

**Done means:** a task row from member B, clicked on member A, opens a terminal
on A showing B's live session; typing on either machine reaches the same pty;
both screens stay correct; **and B's window does not move.** A is a co-equal
client of that pty, exactly as B's own pane is — not a remote control for B's UI.

Two smaller pieces follow, in this order: a row entrance animation, and a
machine picker in the task composer.

## What already exists (and how much of it)

The starting position is much further along than "build a session client":

- **`core/session/viewport.ts`** already implements the arbitration rule —
  min-of-each-dimension among viewers **with an opinion**, undefined meaning
  "nobody has one, leave the pty alone". `host.setViewport` re-arbitrates on
  every change, and `SessionServer` namespaces viewer keys per connection
  (`conn-<id>:<viewerId>`) and clears them on disconnect.
- **`RESPONSE.resized`** plus a following snapshot already tells every viewer the
  pty reshaped, and `pane-sessions.#onHostResize` already applies it with an
  echo guard.
- **`app/src/main/session-client.ts`** is already a complete client for the
  session protocol, and it is already transport-agnostic: it takes
  `connect: () => Promise<ClientSocket>`. It handles hello, attach, per-viewer
  snapshot routing, fire-and-forget writes, reconnect, and re-attach of every
  live viewer.
- **The daemon already serves the session protocol to members.** `RemoteServer`
  is a gate in front of `SessionServer`; the daemon runs one on its data port
  with `sessions: server`. The phone speaks it today.
- **`remote-views.ts`** already draws every member's trees as one merged list,
  qualifying view types as `mac-b∷tasks.tree` and stripping the prefix before
  the call leaves this machine.

So the work is not a protocol, an emulator, or an arbitration model. It is: dial
the member, hand the admitted socket to the client that already exists, and
qualify session ids by member exactly as view types already are.

## Two gaps found while reading

**1. `pane-sessions.ts:433` sends raw `resize`, not `setViewport`.** `host.resize`
resizes the pty and **does not touch the viewport map**, so the next
`setViewport` from anybody snaps the pty back to the arbitrated minimum. A local
pane and a remote viewer would therefore fight: the local `ResizeObserver` says
80×24 authoritatively, the remote viewer's viewport says 60×20, and the two
alternate. This is precisely the thrash the t3code teardown records — the
arbitration was built, and then the Mac's own pane was never made to participate
in it.

**2. `tasks.reveal` opens a pane on B** (`layout.open`, then switch) and returns
`present: { kind: 'session', sessionId }`. The phone relies on exactly that
today. Reusing it for Mac-to-Mac would satisfy "A shows B's terminal" and
violate "B's window does not move".

## The design

### 1. Every viewer declares a viewport

`pane-sessions` stops reporting its emulator's size as a command and starts
declaring it as an opinion:

- xterm's `onResize` → `session.setViewport(sessionId, paneId, { cols, rows })`.
- detach / release / suspend → `setViewport(sessionId, paneId, undefined)`, so a
  pane that is no longer watching stops constraining the pty. That is the
  withdrawal `host.setViewport` documents and nothing currently sends.
- `applyingHostSize` keeps its job unchanged: a host-driven resize must not be
  reported back, which is what stopped 29,825 resizes in ten seconds.

`resize` remains for programmatic callers (`sessions.resize`, a CLI verb, a
smoke). It is no longer how a viewer expresses its window.

**A sole viewer is trivially the smallest, so single-machine behaviour is
unchanged** — which is what makes this safe to land first, before anything remote
exists to test it against.

The viewer key is the **pane id**, and the connection prefix `SessionServer`
already adds is what keeps two machines' pane ids from colliding.

### 2. A session client for the Mac

New in `packages/remote/`: `memberSessionSocket(options)`.

It dials `host:dataPort` (the port is in the roster entry) over TLS and performs
**the same handshake `memberclient.ts` performs** — `REMOTE.hello` carrying the
membership chain, a proof over the observed certificate pin, a nonce — then
verifies the `accepted` frame: same net, same root key, chain verifies, proof
answers our nonce, and the certificate matches the one the peer's credential
names.

**`checkMember` is extracted and shared, not copied.** Two verifiers for one
question is two verifiers that drift, and the one that drifts is the one that
stops checking something. `memberclient.ts` and this both call it.

Once accepted, it exposes a `ClientSocket` and every subsequent byte is the
session protocol. `SessionClient` takes it from there — hello, list, attach,
write, setViewport, snapshot, reconnect — with no remote-specific code in it.

**The handover must not lose bytes.** `accepted` can arrive in the same TCP chunk
as session frames. A `FrameDecoder` fed that chunk would decode both and the
second would be stranded in a decoder the `SessionClient` does not own. So the
handshake uses a pure `splitFrame(bytes) → { frame, rest } | 'incomplete'`,
consuming exactly one frame and forwarding the remainder. Small, pure, and
tested against a chunk boundary deliberately placed mid-handover — the class of
bug that otherwise appears only under load.

`remote-service.ts` gains `sessionsAt(memberId)`: one `SessionClient` per member,
cached, mirroring how `invokeAt` caches `memberClient`. A member whose roster
entry carries no `dataPort` is named as such ("that member serves no terminals")
rather than shrugged at — the same distinction `invokeAt` already draws between
"not a member" and "no address".

### 3. Qualified session ids, routed in main

A remote session is addressed as `mac-b∷<sessionId>`, reusing the existing
`qualify` / `unqualify` / `memberOf` that view types already use. A session
router in main satisfies `SessionHostLike`, which is what `SessionBridge` is
written against:

- unqualified id → the local `SessionClient`;
- qualified id → that member's `SessionClient`;
- exit and resize events from a member's client are re-emitted with the qualified
  id, so `SessionBridge` fans them out to the pane with no knowledge that the
  session is elsewhere.

**`kill` on a qualified id is a detach, never a kill.** Closing A's viewer pane
must not end B's pty — A is a viewer, and R1's rule is that viewers go and
sessions do not. `layout.close` is the one terminator (ADR 0022) and it
terminates **local** sessions. This gets a test with the negative control kept
pointing the other way round, the way `pane-sessions.test.ts` does: a test that
only asserts "detach was called" passes just as happily against a router that
also kills.

The renderer is untouched: `terminal-pane.tsx`, `xterm-terminal.ts` and
`pane-sessions.ts` see an opaque session id and one `SessionApi`. A remote
session is the same pane fed from a different source, which is what the handoff
asks for and what stops a second terminal implementation from existing.

### 4. Routing the gesture without moving B's window

New, additive on `TreeItem`:

```ts
/** The verb that ANSWERS what this row stands for, and does nothing else. */
readonly presents?: { readonly id: string; readonly args?: unknown };
```

Declared by the extension, attributed to the contributing extension exactly as
`command` is (M3 D14), and carried by the shell without being interpreted — so
ADR 0031 holds: the shell still does not know what a task is.

`tasks` registers `tasks.presentation`: reveal's liveness check (a recorded
session id is a CLAIM; check it against `sessions.list`) with the `layout.open`
removed. It answers `{ present: { kind: 'session', sessionId } }`, or nothing
when the task has no live session — which is the truth, and better than an empty
terminal pretending otherwise.

Clicking a row of a **remote** view invokes `presents` over there instead of
`command`. `{ kind: 'session' }` opens a pane **here** and binds it to
`qualify(memberId, sessionId)`. `{ kind: 'view' }` focuses that member's already
qualified view. Nothing runs on B.

**Why a verb and not a field on the row.** A row is drawn once and a session can
die between the draw and the click. `tasks.reveal` already carries a comment
about exactly this: presenting a dead session id told a phone to open a terminal
that could never paint, with nothing reporting a fault because nothing had
failed. A static field would be that bug with a longer fuse; a verb re-checks
liveness at click time.

**A remote row with no `presents` does nothing and says so.** It must not fall
back to invoking `command`, which is the behaviour this design exists to remove.

**Binding stays in main.** The renderer sends the effect; main opens the pane and
calls `bindSession`. The renderer does not learn to bind, because the layout
store is the authority on which session a pane shows and a second writer of that
fact is the defect ADR 0035 records twice already.

### 5. Restore, and a member that is not there

The persisted pane keeps the **qualified** id, and adoption of a qualified id is
**optimistic**: `SessionSink.isLive` is synchronous and the authority is another
machine, so there is nothing honest to ask at restore time. The binding is taken,
the attach is attempted, and the answer arrives when it arrives.

Unreachable is a state the pane renders — "Mac B is not reachable" — not a black
rectangle and not a thrown effect. **A member that cannot be reached is a missing
section, not a broken window**; these are machines that sleep and move networks.

It heals itself with no new machinery: `SessionClient` already retries with
backoff and re-attaches every live viewer on reconnect, and R0's snapshot makes a
late re-attach *correct* — alt screen and all — rather than merely
resynchronised. That is the property that makes a remote pane survivable at all.

### 6. The loopback-advertise defect

A Mac launched without `--shepherd-remote=wifi` serves control on loopback while
still advertising a LAN port, so its roster entry looks perfectly healthy and can
never be dialled. **A member advertises nothing when its own endpoint is
loopback** — the mirror of what `rosterAddress` already does for peers. This is
the first failure a live two-machine run hits, so it lands before the live gate
rather than after it.

The sibling defect — a listener binding one interface at startup and advertising
it forever, so the work Mac handed out its ethernet address after the cable was
unplugged — is **out of scope here** and stays recorded in the handoff. It needs
address re-resolution on a network change, which is its own piece of work.

### 7. Row entrance animation

New rows slide/fade in rather than appearing via a wholesale list swap. Keyed
per row so an existing row is never re-mounted by a list that reordered — the
same identity rule the pane tree keeps, for the same reason.

### 8. A machine picker in the task composer

Choose which member a new task's session starts on. The composer is a
contributed React component (ADR 0033); the picker's options are the roster,
which the app already reads, and "this Mac" stays the default.

## What this deliberately does not do

- **No capability scopes.** Membership currently grants entry AND everything, and
  the data path is unchanged by this design — a member gets what the phone
  already gets. Narrowing it is queued as its own piece of work (entry and
  authority are two questions), and widening it further is not on the table here.
- **No presentation-only mode for local gestures.** `tasks.reveal` keeps
  behaving exactly as it does for the phone. `presents` is additive beside it, so
  nothing that works today changes.
- **No second terminal implementation, no view mirroring, no new protocol.**
- **No relay and no rendezvous.** Reachability stays a ladder; see the connection
  queue in the handoff.

## Testing

Pure and unit, per package:

- `splitFrame`: a frame split across chunk boundaries at every offset; the
  handover remainder delivered intact.
- The shared `checkMember`, reached from both call sites.
- The router: qualified vs unqualified dispatch; **`kill` on a qualified id
  detaches and does not kill**, with the negative control inverted.
- Viewport participation: two viewers on one session take the min; a withdrawn
  viewport releases the constraint; a host-driven resize is not reported back.
- `tasks.presentation`: a live session is answered, a dead recorded one is not,
  and nothing is opened on the host.
- A second member in any test is issued a **real credential** — `memberOf` in
  `memberclient.test.ts` shows the shape. A relabelled membership is attributed
  to the wrong member, and that is correct server behaviour.

Then the gates that actually decide it:

```sh
env -u NODE_OPTIONS pnpm typecheck && env -u NODE_OPTIONS pnpm lint && env -u NODE_OPTIONS pnpm test
env -u NODE_OPTIONS pnpm smoke:m3
```

A green unit suite is not a working app, and this repo has the scars.

**The real gate is live:** two Macs in one net (`pnpm ship --dev` on both,
launched with `--shepherd-remote=wifi`), open a task row belonging to the other,
see its terminal here, type on both, and watch one pty take both — then resize
the smaller window and watch the larger one letterbox rather than the smaller one
clip.
