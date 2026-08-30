# Isolating the core from its UI — design

Status: proposal, 2026-08-30. Finishes the **daemon seam** that
[`2026-08-06-ade-minimal-core-sketch.md`](2026-08-06-ade-minimal-core-sketch.md)
§7b named and that
[ADR 0041](../../../.claude/adr/0041-v2-agent-state-outlives-the-app-so-the-daemon-holds-the-hook-socket.md)'s
last section asked for by name. It invents nothing: the question is which of the
pieces already built get moved, and in what order.

**The ask, as posed:** *"Entirely isolate the Shepherd daemon and the UI. So I
can create arbitrary UIs, and use them as I see fit, but the core itself is
isolated."*

---

## 1. Where the seam already is

More of this is built than the question assumes.

**Outside the app process today:**

- **The ptys.** `v2/packages/daemon/src/main.ts` owns `SessionHost` and serves a
  framed protocol (`v2/packages/core/src/session/protocol.ts`) that deliberately
  outlives every client ([ADR 0036](../../../.claude/adr/), 0037).
- **Hook ingress and the journal.** The daemon binds `hooks.sock` and journals
  what fired while no app was connected, replaying it in the handshake (ADR 0041).
- **The remote data path.** `RemoteServer`, wired in the daemon, reading the same
  device store the app writes — one persistence mechanism, two processes (ADR 0021).
- **The control protocol.** `control.sock`
  (`v2/packages/core/src/ingress/control-ingress.ts`) is a thin adapter over
  `commands.invoke`: `/invoke` with an attributed caller and a per-call deadline
  (ADR 0030), `/commands` self-describing, and `/subscribe` as a long-lived NDJSON
  stream. `v2/packages/cli` is nothing but a POST to it.
- **A renderer-agnostic vocabulary**, which is the under-appreciated asset:
  `TreeItem` carries token names, glyph names and extension-declared verbs —
  never colours, SVGs or shell-known commands (ADR 0031) — and command answers
  carry `PresentEffect`, so a client learns *what to show*, not how.
  `v2/packages/remote/src/control.ts` already says it: a phone is another shell.

**Trapped inside Electron main** (`v2/packages/app/src/main/index.ts`): the
`CommandRegistry`, `EventBus`, `SqliteStore`, permissions, settings, secrets,
attention, the view registry, the layout store, the remote *control* path, and —
the load-bearing one — the **extension host**, forked by the app, where every
service half runs. Trapped in the renderer: the four component tables in
`v2/packages/app/src/renderer/extension-ui.ts`.

So the socket already exposes the whole command surface headlessly — but only
while Electron runs, because the kernel it adapts lives in app main. CLAUDE.md
states the diagnosis already: `agents-core` is in the app's process *"by
inheritance, not by design"*, and the snapshot/replay machinery around it is
**compensation** for that fact.

## 2. What "isolated core" means here

**Moves to the kernel:** command registry, event bus, store, settings,
permissions, attention *aggregation*, the view registry (it holds declarations,
never components), the extension host with every service half, `control.sock`,
the remote control path, and the task/agent/worktree model riding on all of it.
Nothing in that list touches a DOM.

**Stays in the client:** all rendering — xterm.js, the takeover, the component
tables; notifications and the dock badge; presence signals (§7d); the pairing
approval UI, because a headless process cannot admit a stranger.

**Layout is the interesting case, and it stays client-side.** The sketch already
decided the principle — the task list, not any device's layout, is the
authoritative inventory (§4) — and a TUI, a phone and a 5K desktop cannot share
one split tree. What they share is the *subjects*: tasks, sessions, agent state,
attention. The takeover strengthens this: Home reads contributed trees rather
than layout, and a face is a way of reading a subject the shell already has
(ADR 0051).

But one thing layout currently owns must be taken from it: **session lifetime.**
ADR 0022 made `layout.close` the one terminator; with several clients, one
closing its view must not kill an agent another is watching. The task model
already points the way — closing a task's panes shelves it (ADR 0042) — and the
daemon already treats a disconnect as detach, never kill. So termination becomes
a core verb, a client's pane close becomes detach, and ADR 0036's claim-and-verify
reconciliation becomes every client's connect ritual.

**Viewing becomes per-principal.** ADR 0020's `isViewing` feeds the state machine
and suppresses notifications; with N clients it becomes the *set* of principals
viewing a session — reported by clients, aggregated by core. A small schema
change with real value: no push for a session your phone is looking at.

## 3. The protocol

Keep **two channels**, as the daemon already does: a control plane (JSON commands
and subscriptions) and a data plane (framed bytes for pty). Do not unify them —
base64 on the hot path inflates it by a third and reintroduces the multi-byte
boundary bug the byte frames exist to prevent.

**Commands:** the existing `/invoke` shape extends cleanly — command, args,
attributed caller, per-call `timeoutMs`, typed errors, a self-describing verb
list. Answers stay `unknown`; a cast is not a check, and that discipline is
exactly what a second client needs anyway.

**Subscriptions** need two things the CLI never did:

- **Snapshot-then-delta on connect** for stateful topics, generalising
  `PtyFanout`'s "snapshot, register, replay are one step" to the control plane —
  so a reconnecting client never folds deltas onto nothing.
- **Back-pressure as pull-with-nudge, not push.** ADR 0031 already chose this for
  views: the change signal is a nudge, the reader reads when it wants, and a
  chatty extension cannot flood anyone.

**Principals.** `externalCallerSchema` refuses `user` and `kernel` from any
socket, and that rule stays. Its consequence has to be faced: once the kernel is
out of Electron, **even the flagship app cannot be `user`**. A UI client becomes
a *device* with a shell entitlement — what `local-cli` and paired devices already
get — authenticated by socket ownership locally and keypair identity remotely.

**Versioning:** capabilities advertised in `hello`, degrading gracefully. Bump the
version only when a field changes meaning. ADR 0041 is the lesson: refusing on
version strands an old daemon holding live agents.

## 4. What breaks

**The extension model does not have to split — ADR 0033 already split it.** An
extension is two directories with a lint boundary, and what crosses is a *name*.
Service halves move to the kernel with their wire protocol re-transported from a
MessagePort to a socket; their shape is unchanged.

What breaks is the UI half on non-Electron clients:

- A **web client** barely breaks — the renderer already is a web app.
- A **TUI or native client** renders the declarative vocabulary (trees, attention,
  verbs, `PresentEffect`, terminal attach), which is most of the product. For
  `kind: 'component'` views the name indirection is the escape hatch: the table is
  per-client by construction, so a TUI ships its own. A name a client does not
  implement draws the honest failure ADR 0033 specified, and the capability
  survives regardless — `tasks.create` is a command, and the CLI creates tasks
  today with no composer.
- The casualty list is short and enumerable: `tasks.composer`,
  `tasks.sessionSearch`, `diagnostics.card`, `worktree-hook.editor`, the editor,
  review and scratch panes, and the three faces. Each is per-client work or an
  accepted absence.
- **Third-party contributed UI** is unaffected, because it does not exist on any
  client yet — the static table has no loader. Multi-client makes that loader
  harder to design later; it breaks nothing shipped.

Also displaced: ADR 0045's login-shell `PATH` harvest must run where sessions
spawn; `safeStorage` secrets need a home outside Electron.

## 5. Migration

Each stage ships alone and leaves the app working.

**Stage 0 — done.** Daemon ptys, hooks and journal, remote data path, control
socket, CLI.

**Stage 1 — lifetime and viewing semantics.** Termination moves out of
`layout.close`; pane close becomes detach; viewing becomes per-principal. Pure
model work inside today's processes. It also fixes multi-window and phone-viewing
semantics. **Buys:** the ground every later stage stands on, with nothing moved.

**Stage 2 — the app becomes its own second client.** Route the renderer's control
plane through the same command and subscription surface the socket serves, while
still in-process. **Buys:** a wire contract hardened by a demanding consumer
before any process moves — because a protocol with exactly one in-process
consumer is a protocol nobody has tested.

**Stage 3 — the kernel leaves the app.** A `shepherd-kernel` process beside the
daemon takes the registry, bus, store, settings, permissions, attention, view
registry, extension host, control socket and remote control. Electron main shrinks
to window glue plus a client. **Buys:** `pnpm ship` and app crashes cost nothing —
not even journal replay — and it *deletes* ADR 0041's compensation machinery.
Keep it a **separate process from the daemon**: ADR 0037 survives faults only
because almost nothing runs there, and extension code in the pty process would
put every agent behind every extension's worst bug.

**Stage 4 — a second client for real.** Web first (it reuses the renderer over the
remote transport) or a TUI (it reuses the phone's surface). Only now does
per-client component work exist.

## 6. Cost, and the recommendation

**Slower — measured, not assumed** (live app, M4, kept-alive unix socket):

| | p50 | p99 |
|---|---|---|
| in-process `CommandRegistry.invoke` | 0.13µs | 0.58µs |
| socket `/invoke`, kernel handler | **133µs** | 616µs |
| socket `/invoke`, extension-host handler | 487µs | 1.43ms |
| socket `/invoke`, ext-host + 50KB payload | 673µs | 1.02ms |

Raw unix-socket RTT is **4µs**; HTTP framing adds ~21µs, this stack ~29µs, and
dispatch ~79µs — most of it the per-invoke debug log line, since schema validation
and the permission check together are under a microsecond. A command whose handler
lives in the extension host already pays the ~350µs utility-process hop today and
would keep paying it; a socket changes its transport, not its cost class.

Against real traffic this is a **non-problem**. `app.log` over a 39-hour window
holds 44,692 commands — mean 3.0/s, and the busiest second ever logged is **42**.
At the worst measured per-call cost that is 28ms spread across a full second, under
3% of one core. The chattiest paths are extension beats, not the renderer:
`agents.lastSaid` at 18,435 calls off the tasks extension's 500ms correlate beat,
and `tasks.list` at 6,326 off `github`'s 10s sweep. ADR 0031's pull-with-nudge
already prevents the one design that could go quadratic — a tree cannot be made to
re-read per row.

**The one pattern to design against** is a long serial chain of dependent calls on
a paint path: at 0.13–0.7ms a link, ~23–107 links fit in a 16ms frame. Nothing in
the log comes within an order of magnitude, but a future path that walks a list
one call at a time before first paint should be batched or made a subscription.
Concurrency queues rather than collapses — 16 in flight still cleared 9,460
calls/s. Pty bytes stay on the daemon's data plane and are unaffected either way.

Reproduce with `scratchpad/bench.mjs` against `~/.shepherd/v2/control.sock`.

**Harder to debug:** four processes instead of three. The tuition is paid — the
unified log discipline exists because multi-process debugging burned this repo
twice — and the `smoke:daemon` pattern of driving a process with no app running
generalises.

**Invariants:** ADR 0041's snapshot-and-replay gets *easier*; the reducer moves
next to the socket and the journal dies. ADR 0004's ordering guard is untouched,
being inside the reducer that moves whole. What genuinely hardens: ADR 0036's
claim-and-verify extends to every client's every subject, and version skew becomes
a permanent operational fact — hence capability advertisement everywhere.

**Recommendation.** Stages 1 and 2 **now**: cheap, in-process, and they improve
the single-client app on their own. Stage 3 as its own milestone **after M4's
dogfood gate** — it is the payoff ADR 0041 already argued for, and it removes
machinery rather than adding it. Stage 4 **only when a second client has a user**.

And explicitly: **do not rewrite in Rust, GPUI or anything else.** The isolation
that feels missing is a process boundary and a wire contract, both mostly built.
The vendor-blind, declarative-contribution discipline in this codebase is the
moat, and it is language-independent. Superlogical's lesson is server-authoritative
*state*, which Stage 3 delivers without discarding a line of the extension runtime.

## 7. The decision this rests on

Commit — or refuse to commit — that **the Electron app is a client with no
privileged path**: it may do nothing a socket client cannot, including being
`user`.

Everything above is a consequence of that one sentence. Without it, every stage
quietly grows a private hook and the isolation never actually happens.
