# Shepherd v2 — an ADE: minimal core, everything else an extension (sketch)

Status: sketch for discussion, 2026-08-06.
Reopens the host-tech decision recorded in
[`2026-07-13-unified-code-surface-editor-design.md`](2026-07-13-unified-code-surface-editor-design.md) §10
under its own revisit clause ("if scope ever balloons to a full IDE, revisit").
References: VS Code (contribution points, built-ins on public API), Obsidian
(the plugin API *is* the product), Pi (radically minimal core, chrome itself is
malleable).

## 1. Thesis

Shepherd v2 is an **ADE — Agentic Development Environment**: a deliberately
small, agent-agnostic core plus an extension runtime, where everything that
makes it *agentic* — including the Claude integration and the task model — is
an extension. Some extensions ship in the box ("core extensions", VS Code
style), but they use the **same public API** community extensions get. That
constraint is the design's immune system: the moment a built-in needs a private
hook, the API is wrong.

The moat is not the terminal grid. It is being the first **hackable substrate
for agentic development** — what Obsidian is to notes. Obsidian is the
existence proof that users forgive a non-native runtime when malleability is
the value.

## 2. What the core is (the kernel)

The core knows nothing about tasks, agents, git, Claude, PRs, or worktrees.
Eight primitives:

1. **Views & regions** — the window is a frame of **regions** (left dock,
   right dock, bottom dock, main grid, status bar), and extensions register
   **view types** that can be placed in *any* region, tabbed, stacked, split,
   or popped out. Three built-in view kinds:
   - *Terminal view*: a grid attached to a PTY. The core's one opinionated
     rendering component.
   - *Panel view*: an extension-owned webview — the workbench, a Slack
     client, Google Calendar, a docs pane, dashboards. If it renders in a
     browser, it can be a view. This is not an edge case; it is the point.
   - *Declarative contributions*: cheap additions to existing views/chrome —
     rows, glyphs, bars, menus, palette entries, settings panes — for
     extensions that don't need a whole surface.
   There is **no core-owned sidebar**. "The sidebar" is whatever view stack
   sits in the left dock; the default task list is itself an extension view,
   replaceable and reorderable like any other. (Obsidian's any-view-any-pane
   model + VS Code's activity-bar viewlets, taken to Pi's conclusion.)
2. **Layout** — one tree of regions/splits/tabs/items with focus, zoom,
   collapse, drag — covering docks *and* the main grid uniformly. Deliberately
   dumb: the core offers *structure*, not *meaning*. Whether the top-level
   grouping is "projects" or "tasks" is an extension's decision. (Direct
   descendant of `SplitTree` — already pure, already tested.)
3. **Process & PTY service** — spawn PTYs and processes, **per-session env
   injection**, stream taps and input injection. Crucially, **a terminal
   session is decoupled from any view of it** (the tmux split): sessions are
   core-owned objects; a terminal view — local pane, phone client, extension
   reader — is an *attachment*, and a session may have zero attachments
   (headless tasks) or several (desktop + phone). Generalizes
   `PtyBroker`/`shepherdd pty`/viewer-not-resizer, which already built the
   half of this remote needed. Sessions living outside the UI process also
   opens UI restart/update without killing running agents (daemon question,
   §7.7).
4. **Event bus** — typed pub/sub between extensions, **plus an external
   ingress socket** so out-of-process things can publish events. This is
   `report.sh → SocketServer` generalized: the hooks bridge stops being a
   special case and becomes "a process publishing events."
5. **Commands, keybindings, palette** — every action is a named command in
   **one typed, exhaustively-dispatched registry**; keyboard, CLI socket,
   remote clients, and extensions are four *transports* into it, never four
   implementations (v1 shipped three: `controlRoute`/`applyRemoteCommand`/
   `ShortcutActions` — see the review §Bad-2). Every invocation carries an
   **attributed caller** (device or extension) and is authorized against it —
   the review's read-side-only-authorization hole (§Bad-3), closed at the
   envelope, with extensions as the fourth caller class it didn't anticipate.
   (`ShortcutCatalog` grows into the display half of this.)
6. **State & storage** — per-extension KV + config, participation in layout
   persistence (an extension can attach data to a layout node and get it back
   on restore — how `sessionID`/cwd survive today).
7. **Attention** — a generic channel: an extension sets an attention level
   (+reason, +color) on a layout node; the core aggregates to dots, dock
   badge, notifications, and next-attention navigation (⌘⇧A). The core does
   **not** know what "blocked" means — `StopPolicy` is extension logic; the
   *rendering and aggregation* of attention is core. `isViewing` stays core
   (only the compositor knows what's front-most) and is exposed as a queryable
   predicate + events.
8. **Extension host** — manifests, activation events, permissions, a TS/JS
   runtime for in-proc extensions, and first-class support for
   **out-of-process extensions over RPC** (any language — the Neovim move; the
   existing control-socket verbs are the seed).

Explicitly **not** core: git, agent lifecycles, project/task semantics, PR
anything, remote protocols, editors, **and the sidebar's contents**.

### 2b. How far customization goes (the bar)

The test cases for "fully customizable," deliberately including ones that
sound stupid: a **tabbed sidebar** (trivially: multiple views stacked in the
left dock — no API needed beyond §2.1); a **Slack view** docked beside your
agents; **Google Calendar** in the right dock; a **Google Docs pane** in the
main grid next to a terminal; an **active-PRs section** in the sidebar (tree
view + Octokit polling); and at the far end, **an extension that is an entire
app** — e.g. a GitHub client built on Octokit with its own views, storage,
background polling, and extension points (v1's ported `PRStatus`/`PRComments`
classifiers and `gh auth token` credential pattern are its natural seed).
All of these are just views in regions —
if any of them needs a special case, the region/view model is wrong. What they
*do* force is honest scoping of two things: panel views get **network access**
(so the permission model, §7.2, is load-bearing, not theoretical) and
**external auth flows** (OAuth redirects into a webview) must work. Neither is
exotic — Obsidian and VS Code webviews both do it — but both must be designed,
not assumed.

## 3. The core extensions (shipped, public-API-only)

| Extension | What it owns | Core APIs it consumes |
|---|---|---|
| `agents-core` | The generic "agent" noun: session attach/detach on a surface, a state machine slot, resume-on-restore contract | PTY env injection, event bus, storage, attention |
| `claude-code` | Hooks→events bridge (report.sh), the lifecycle map (`StopPolicy`), background-Stop suppression, `--resume`, plugin install | `agents-core`, event ingress, attention, slot glyphs |
| `tasks` | **The task-based model** (§4) — the organizing surface | Layout, storage, slots, `agents-core`, `worktrees` |
| `worktrees` | Provision/archive/restore as a *service* other extensions call | Process exec, layout+cwd, dialogs, storage |
| `workbench` | The git review surface | Panel surface, commands/keybindings, file events |
| `remote-core` | The serving protocol: pairing, control session, PTY streaming | PTY taps/injection, layout read, event bus |
| `remote-tailscale`, `remote-lan` | Transports over `remote-core` | `remote-core`, settings slots |

The dependency arrows (`remote-lan → remote-core`, `tasks → worktrees`,
`claude-code → agents-core`) mean extensions must be able to **depend on and
call each other** — an API surface VS Code half-has and Obsidian mostly lacks.
Worth designing deliberately: exported extension APIs, semver'd.

## 4. The task model (the `tasks` extension)

The pivot: today's tools (Superset, Conductor, Shepherd v1) organize by
**project** — a repo you sit inside. The ADE organizes by **task** — a unit of
intent you dispatch and shepherd.

- A **task** = intent (the prompt/brief) + 1..n repos + one orchestrating
  agent (+ spawned workstream agents) + their surfaces + artifacts
  (branches/PRs) + a lifecycle: `draft → running → needs-you → review →
  done/archived`.
- **Repos by path, fuzzy-picked**: added via autocomplete over known repos,
  ranked by usage + recency (the composer's repo picker; selection history is
  extension storage).
- **The task folder is worktrees, never copies**: `~/.shepherd/tasks/<slug>/`
  holds one *worktree per repo* on a task-named branch — copies would break
  remotes, double disk, and orphan the archive machinery; worktrees inherit
  v1's provision/archive/restore per-repo unchanged.
- **Context synthesis**: the orchestrator runs at the task root. Nested
  `CLAUDE.md`s load themselves (Claude Code pulls them in per subtree), but
  `.claude/` (skills/agents/settings) does not propagate — so the extension
  synthesizes the task root: a generated `CLAUDE.md` (task brief + repo map)
  plus an aggregated `.claude/` symlinking each repo's skills/agents,
  conflicts flagged. Pure, testable (`TaskRootSynth`).
- **Subagents, hybrid**: harness-native subagents remain for cheap short-lived
  parallelism (invisible to the app — fine). Real parallel workstreams are
  **app-tracked sessions** the orchestrator spawns via the agent API
  (`task spawn --repo <r> --prompt …` through the skill/MCP): each gets its
  own state dot, attention, and phone-attachability — observability and
  remote attach are exactly what the harness can't provide. The skill teaches
  which to use when.
- The sidebar lists *tasks*, grouped by state, not repos grouped by tab. A
  repo may host many tasks concurrently (worktrees make this safe).
- ⌘T composes a task (v1's composer is 80% of this already: title, branch,
  prompt, worktree toggle — plus the repo picker).
- "Done" archives the task: per-repo worktree archives (v1's two-commit
  format), transcript kept, restorable. The 90-day expiry becomes
  task-garbage-collection.
- v1 mapping: workspace→(gone, or a task-group), tab→task, pane→agent surface.
- **Tasks are location-independent.** Built on §2.3's session/view split: a
  task's sessions run on the host; *views* attach from any device. A task can
  be created from the phone, run on the Mac, and render **only** on the phone
  — the desktop shows it in the task list with no pane anywhere. Two
  commitments this requires: creating a task is a **session-level** verb, not
  "new tab" (the control CLI's `tab new` is the seed); and the task list —
  not any device's layout — is the authoritative inventory of what's running.

Because `tasks` is an extension, the project model can live alongside it —
ship both, let usage decide. The repivot and the platform bet decouple.

## 5. Validation: the four extensions as API consumers

The test for §2's primitive list: each row of §3 must be expressible with *no
private hooks*. The known hard cases, found by walking v1's features:

- **Viewing/attention coupling** ([ADR 0020]): `claude-code` needs
  `isViewing(surface)` *inside* its state machine. → core predicate + event,
  passed into extension handlers. Covered.
- **Env injection before shell start** (correlation): needs a hook at PTY
  creation, not after. → `onWillCreatePTY(surface) → env`. Covered by §2.3.
- **Remote's fd-level streaming**: `remote-core` needs raw tap fan-out with a
  replay ring. Either the core's tap API carries the ring (lean: yes — it's
  generic buffering) or the extension buffers. Decide in design.
- **Workbench needs a real editor**: as a webview panel it brings its own
  (CodeMirror/Monaco) — which retires the entire vendored CESE stack and its
  gotcha list. This is the strongest single argument for the pivot.

## 6. What this implies about host tech

The requirement that decides it is **Tier-3 malleability**: extensions (and
`tasks` itself) own top-level chrome, not just slots. That means the chrome
must be written in the extension language — TS — and rendered by the same
runtime extensions target. Combined with node-pty, xterm.js, and where
extension authors actually are, that points to **Electron** (Tauri's WKWebView
was already rejected once; its Rust core buys little here). The terminal grid
becomes one surface among several rather than the identity; xterm.js with the
WebGL renderer is the same terminal VS Code ships, which is good-enough for a
tool whose value is the substrate.

**UI framework: React** (decided, not drifted into): Monaco/xterm.js wrappers,
extension-author familiarity, and contribution-UI patterns. Dev-only tooling,
excluded from production bundles (dev/prod isolation applies to tooling too):
**`react-grab`** — element → component-source context for agent-driven
debugging, collapsing the screenshot→guess→grep loop v1 lived with — plus
`react-scan`/DevTools, which make the remount bug class (v1's
`_ConditionalContent` → dead-PTY family) *visible live* instead of forensic.

What carries over from v1: every pure model as a spec (`SplitTree`,
`StopPolicy`, `RowPlan`, persistence shapes), the plugin protocol byte-for-byte
(`report.sh` doesn't change), the remote wire protocol, the Android client, and
two months of recorded gotchas as the test plan.

## 6b. Lessons ledger — mistakes v2 must not recreate

Companion: [`2026-08-06-architecture-review.md`](2026-08-06-architecture-review.md)
(full findings; its "Rebuild checklist" is normative for v2). The mapping onto
this sketch, plus the deltas the extension architecture adds:

- **View-owned PTYs (review §Ugly-1)** → dissolved structurally by §2.3's
  session/view split, which goes further than the review's "main-process
  registry": the daemon option also restores what it concedes losing from
  `shepherdd pty` (shells surviving an app/UI crash) — as one deliberate
  decision instead of the tap-helper machinery.
- **God objects (§Bad-1)** → the review's six-module decomposition *is* the
  core/extension map (`AgentLifecycle`→`claude-code`, `AttentionRouter`→core
  attention, `RepoServices`→`worktrees`, `RemoteHub`→`remote-core`,
  `ControlRouter`→core ingress). The extension boundary makes the split
  compiler-enforced, not aspirational. Same for `src/core/**` importing
  nothing but stdlib — lint-enforced, replacing the 86-path hand-list.
- **Untyped routing (§Bad-2/4)** → the risk *reincarnates* in the extension
  bridge: `[String: Any]` becomes untyped JSON-RPC unless the extension API is
  schema'd and exhaustively dispatched. Unknown frame = log-and-skip, never
  discard-the-batch; protocol version actually negotiated.
- **Read-side-only authorization (§Bad-3)** → §2.5's attributed caller on
  every command, with **extensions as a caller class**: an extension's
  permission grant is checked at the same envelope as a device's workspace
  entitlement. One authorization seam, two identity kinds.
- **Liveness (§Bad-5)** → heartbeats + machine-readable rejection codes on the
  attachment protocol from day one (it is now the *local* path too, so "host
  gone vs idle" ambiguity would hit every pane, not just remote); plus the
  local reconciliation sweep (state says working, no foreground process ⇒
  demote) as an `agents-core` duty.
- **Subprocess sprawl / `gh` (§Bad-6/7)** → one `runGit` with
  timeout/AbortSignal and structural `gitRead`(`GIT_OPTIONAL_LOCKS=0`)/`gitWrite`
  split, exposed *as the core process API extensions get* — so extensions
  inherit the fix instead of hand-rolling runner #4. Octokit in the relevant
  extension; keep the pure classifiers.
- **Config/persistence (§Bad-8)** → comment-smuggled keys die with the
  ghostty parser (xterm.js takes a theme object); one schema-validated config;
  versioned JSON with `schemaVersion` in the payload; debounced writes;
  select-by-id. Extension storage (§2.6) gets the same discipline so 34
  string-literal UserDefaults keys don't respawn per-extension.
- **Hook channel (§Ugly-4)** → HTTP-over-unix-socket ingress (`curl
  --unix-socket`), one `jq -cn` envelope, sequence numbers, `pane_id` named
  honestly, single-instance lock. This is §2.4's external ingress — hooks are
  just its first client.
- **Editor fork (§Ugly-2)** → the workbench extension brings Monaco/CodeMirror;
  incremental model updates + view zones from day one, never
  full-replace-and-remount; `RowPlan`/`EditMap`/`PatchSynth`/`Diff3` + tests
  port pure; `StitchMap` is not ported.
- **fd-keying / pairing (§Ugly-3)** → connection-id strings over `Duplex`;
  **keypair device identity** (deletes `altSecrets`/host-relocation); keep the
  authorization-vs-authentication split and the SAS ceremony.
- **Untestable state machines (§Bad-9)** → injected clocks/spawns are core API
  policy, so the coalescing watcher / update phases / sleep tiers get their
  fake-timer tests — and extensions can be tested the same way.

## 7. Decided (2026-08-06)

- **v2.0 cut line**: the dogfood threshold — core + terminal sessions +
  `agents-core`/`claude-code` + `tasks`. Workbench, remote, nudges, onboarding
  follow. v1 stays the daily driver until v2 can host its own development.
- **SDK: yes** — `@shepherd/sdk` on npm: typed API, extension scaffolder, test
  harness (injected clocks/spawns). **Distribution: GitHub as registry**
  (nvim/Obsidian community-list style) for now; marketplace later.
- **API stability**: everything lands as `proposed.*`, usable only in dev-mode
  builds; built-ins are *required* to consume proposed APIs (the proving
  ground); graduation to stable requires two built-in consumers; stable is
  semver'd, deprecations survive two minors; listings declare tested API range.
- **Agent API**: first-class — the control surface exposed as MCP + the
  control socket, shipped with a `controlling-shepherd`-successor skill.
  Agents are expected extension *authors and callers*.
- **Multi-window**: model decided now (a window is another layout root over
  the same session pool — falls out of the session/view split), feature
  shipped later.
- **Platform skeleton**: macOS-only v2.0, but all platform-specific bindings
  (presence, notifications, dock, keychain, PTY quirks) live behind a
  `src/platform/` interface with a darwin implementation — lint-enforced like
  core purity — so win32/linux slot in later without core surgery.
- **License: MIT** (core and SDK). The substrate play wants ecosystem
  velocity; brand + marketplace are the control points, not the license.
- **Panel isolation: yes** — contextIsolation everywhere, per-extension
  session partitions, `WebContentsView` (never the deprecated `<webview>`).


## 7b. Decided (2026-08-07 interview)

- **Community extension UI: in-proc React** (Obsidian posture) — granted
  extensions render real views; webviews remain available for app-like
  panels. Power rides the permission grant.
- **Extension services run in one utility process** — a wedged extension
  cannot stall the SessionHost or the window.
- **Permissions: review-at-install, grant once**; new capabilities in an
  update re-prompt. No first-use interrupts, no silent grants.
- **Loose shells exist: a persistent Scratch section** — ⌘T-with-defaults is
  a zero-ceremony shell; promote-to-task later. Scratch persists cwd + title
  only (v1 restore discipline).
- **Task store is SQLite** (better-sqlite3, main process, versioned
  migrations). Task folders stay derived, never authoritative. Rule:
  machines write DBs, humans write files (user config stays text).
- **Sessions in the main process for v2.0**; daemon later behind the
  SessionHost interface.
- **v1 migration: clean start + one-time read-only seed** (devSeedState
  pattern, sessionIDs stripped) offering v1 cwds as Scratch sessions.
- **Composer auto-starts the orchestrator; resume ships in M2**
  (resumeSessionID + `claude --resume`, v1's proven seam).
- **CLI-first, no MCP in v2.0** — agents in panes have Bash; the `shepherd`
  CLI + skill is the agent API. MCP would be a thin later adapter over the
  same command registry. (Supersedes §7's "MCP +" phrasing.)
- **Post-M4 order: workbench first**, then remote/phone, then nudges.
- **Identity: same name, `com.shepherd.Shepherd.v2` (+ `.v2dev`)** bundle
  ids, own ports/sockets/support dirs, sheep icon vs v1's goat.
- **v1 is maintenance-only** for the duration; feature energy goes to v2.
- **v2 lands on master early and often** — this branch merges once M0 is
  green; `v2/` evolves in small PRs (it touches nothing in `spike/`).

## 7c. Decided (2026-08-07, during M1) — the SDK ships batteries for agents

The question that prompted it: does an extension author who wants one smart
feature (`claude -p` behind a button) write their own spawn plumbing and
NDJSON parser, or does the SDK make it a line?

**It is a line, and the primitive is ours.** §4.1's third tier already said an
extension *could* run `claude -p --output-format stream-json` and render its own
view; that is a note about what is possible, not a primitive anybody gets. If
every extension hand-rolls it, they each do it badly and differently, and the
"hackable substrate for agentic development" claim is hollow — the same argument
that made one `ProcessAPI` with `gitRead`/`gitWrite` correct rather than letting
each extension write git runner #4.

Where it lives is the part that needs discipline: **the kernel stays
vendor-blind** (§2 — core knows nothing about tasks, agents, git, or Claude). So

- **`agents-core` exports the seam** (M2): `complete({prompt, cwd})` for a
  one-shot structured answer, `stream(…)` for `stream-json` events. Typed,
  vendor-agnostic, reached through `extensions.get<AgentsAPI>`.
- **`claude-code` implements the Claude kind behind it** (M2). A second vendor
  is a third extension and touches neither the kernel nor a consumer.
- **It is its own permission, `agents`** — not a corollary of `process.exec`.
  It spends the user's model budget, which is not a consequence "can run
  programs" prepares anyone for. Added to the manifest vocabulary in M1, ahead
  of the M2 implementation, so extensions declare against a stable set.
- **Cross-extension calls are declared, not discovered**: a manifest lists
  `dependencies`, and `extensions.get(id)` resolves only those ids. This is the
  §3 dependency table becoming enforceable, and it gives the host a place to
  check a dependency is active *before* activating the dependent.

Storage stays as it is: `KV`, namespaced and schema-validated, is the right size
for now. Raw SQL to extensions is a bigger grant than it looks (migrations,
corruption blast radius) and nothing needs it before `tasks` — if M3 proves KV
too thin, that is the moment to widen it, with a real consumer to shape it.

## 8. Open questions (each needs a decision before code)

1. In-proc TS vs out-of-proc RPC as the *primary* extension form (VS Code runs
   extensions out-of-proc for crash isolation; Obsidian in-proc for power).
   Leaning: in-proc for UI, out-of-proc allowed for services.
2. Permission model — Obsidian's "trust on install" vs manifest-declared
   capabilities. An ADE runs agents with shell access; the bar is higher.
3. Does the core ship *any* editor, or is even "open a file" an extension?
   (Pi says extension. Leaning: extension.)
4. Layout persistence versioning across extension-owned node data.
5. Terminal: pure xterm.js, or a native-terminal escape hatch later? (Don't
   build the hatch now; note it.)
6. Name/branding of v2 vs an in-place migration of the repo.
7. **Session/view split depth**: (a) sessions in the Electron main process
   (free with node-pty; lost on app quit) vs a small session daemon
   (tmux-server style: UI restarts/updates without killing agents — the ADE
   answer to restart-when-idle). (b) Attachment protocol: raw bytes + replay
   ring with per-viewer emulation (v1's shipped model) vs a headless VT
   emulator in the host with grid-state diffs to viewers (mosh-style; gives
   consistent scrollback, thin clients, and "read the screen" as an extension
   API). Lean: bytes now, protocol shaped so screen-state can slot in behind
   it; daemon decided by whether headless tasks are v2.0 or v2.1.
8. **Presence sensing** (review §Ugly-5): `isAway` gates the phone-push
   channel and Electron has no clamshell API. Budget native-module work; make
   presence an explicit multi-signal input (idle time, lock/unlock, display
   state) behind the existing `decide()` seam, `viewing` stays a reducer
   parameter.
