# Shepherd v2 (ADE) — v2.0 slice design: core API + first three extensions

Status: draft for review, 2026-08-06.
Parent: [`2026-08-06-ade-minimal-core-sketch.md`](2026-08-06-ade-minimal-core-sketch.md) (thesis, primitives, decisions).
Normative companion: [`2026-08-06-architecture-review.md`](2026-08-06-architecture-review.md) (its Rebuild checklist binds this design).

## 1. Goal

Ship the dogfood slice: **core + terminal sessions + `agents-core` +
`claude-code` + `tasks`** — the point where future Shepherd development can
happen *inside* v2. Everything else (workbench, remote, nudges, onboarding)
arrives as later extensions against the API this slice proves.

Method: the API is designed *against its consumers*. Every primitive in §4
exists because §5's extensions need it; anything no extension needs is cut.

## 2. Repo & package layout

Monorepo, new top-level `v2/` in this repo (split later if ever; history and
docs stay adjacent). pnpm workspaces + TypeScript project references.

```
v2/
  packages/
    core/            # the kernel: session host, layout, commands, events,
                     # attention, storage, extension host. Imports: stdlib +
                     # node-pty only. NO electron, NO react (lint-enforced).
    sdk/             # @shepherd/sdk — the public types + test harness.
                     # What extensions import. core implements these types.
    platform/        # platform interface + darwin impl (presence, notifs,
                     # dock badge, keychain). core consumes the interface.
    app/             # Electron shell: main-process wiring + React renderer
                     # (regions, docks, xterm.js views, chrome).
  extensions/
    agents-core/     # built-ins: ordinary packages depending only on sdk
    claude-code/
    tasks/
  tooling/           # eslint rules (import boundaries), scaffolder
```

Lint-enforced import boundaries (the review's §Good-1 made structural):
`core` → stdlib+node-pty; `extensions/*` → `sdk` only; `platform/darwin` is
the only place OS APIs appear. React/`react-grab`/`react-scan` are dev-gated
in `app`.

## 3. Process architecture

Three process kinds (Electron's split used, not fought):

- **Main process**: the core. Owns the **SessionHost** (node-pty registry keyed
  by session id — lifetime tied to the model, never to views), the extension
  host for *service* extensions, both unix-socket ingresses, persistence.
- **Renderer** (one per window): React chrome rendering regions/layout;
  terminal views are xterm.js instances attached to sessions over IPC. Strict
  isolation: contextIsolation, no nodeIntegration, preload exposes only the
  typed attachment + command bridge.
- **Panel webviews**: `WebContentsView` per panel view, per-extension session
  partition. Not in v2.0's critical path (no built-in needs one until
  workbench) but the seam is reserved in the view registry.

**Sessions in the main process for v2.0** — behind `SessionHost` so the
tmux-style daemon can replace it without touching callers (sketch §7.7's
"bytes now, daemon later"). The renderer attachment protocol (replay ring →
live bytes, viewer-not-resizer) is the same protocol remote will speak.

Single-instance lock (`app.requestSingleInstanceLock()`) before either socket
is created — v1's silent CLI-theft bug, closed at startup.

## 4. The core API (`@shepherd/sdk`)

An extension is a package with a manifest and an activate function:

```ts
// manifest (package.json "shepherd" key)
{ id: "shepherd.tasks", api: "^1.0.0",
  activation: ["onStartup" | "onCommand:tasks.create" | "onView:tasks.sidebar"],
  permissions: ["sessions", "process.exec", "storage", "views"],
  contributes: { commands: [...], views: [...], keybindings: [...] } }

export function activate(ctx: ExtensionContext, api: Shepherd): void
interface ExtensionContext {
  subscriptions: Disposable[]     // auto-disposed on deactivate
  storage: KV                     // namespaced, schema'd, versioned
  secrets: SecretStore            // keychain-backed via platform
  log: Logger                     // the v1 logging rule lives here
  clock: Clock                    // injected time — nothing calls Date.now()
}
```

### 4.1 Sessions

```ts
interface SessionAPI {
  create(opts: { cwd: string; command?: string[]; env?: Env;
                 location?: LayoutTarget }): Promise<Session>
  get(id: SessionID): Session | undefined
  list(): Session[]
  // The env-injection seam (correlation key, ADR 0003's successor):
  onWillCreate(fn: (draft: SessionDraft) => { env?: Env }): Disposable
  onDidExit(fn: (s: Session, code: number) => void): Disposable
}
interface Session {
  readonly id: SessionID          // THE correlation key, everywhere
  write(data: string | Uint8Array): void        // raw input
  paste(text: string): void       // bracketed-paste semantics (v1 gotcha kept)
  attach(opts?: { replay?: boolean }): Attachment  // ring replay → live bytes
  resize(cols: number, rows: number): void      // authorized callers only
  hasForegroundProcess(): Promise<boolean>      // the liveness reconciler's input
  kill(signal?: string): void
  meta: MetaBag                   // typed per-extension attachments, persisted
}
```

The ring is a real circular buffer (review: `removeFirst` was O(n)). `paste`
vs `write` preserves v1's hard-won newline/bracketed-paste distinction.

**Reading a session, three tiers** (decided 2026-08-07; the custom-agent-UI
use case — "my own Claude Code UI over the CLI" — is the driver):
1. `attach()` — raw bytes (Option A, shipped in M0).
2. `screen()` — **B-lite**, post-M4: on-demand host-side `@xterm/headless`
   fed from the same ring + live stream, exposing text/cursor/scrollback to
   extensions. Per-session, only-when-read — an extension API, *not* a
   migration of the attachment protocol (full Option B stays deferred).
3. **Semantic events** — the right seam for replacement UIs: an extension
   runs `claude -p --output-format stream-json` (or the Agent SDK) in the
   session and renders its own view from structured events; hooks remain the
   lifecycle source. The stock TUI is just one peer view of the engine.

### 4.2 Layout & views

```ts
interface LayoutAPI {
  roots(): LayoutRoot[]           // one per window; multi-window = more roots
  open(view: ViewRef, target: LayoutTarget): LayoutNode
  split(node: NodeID, axis: 'row' | 'column'): LayoutNode
  focus(node: NodeID): void; zoom(node: NodeID): void; close(node: NodeID): void
  isViewing(node: NodeID): boolean          // ADR 0020's predicate, core-owned
  onDidChangeViewing(fn): Disposable
  node(id): LayoutNode | undefined          // tree read; mutations via commands
}
interface ViewAPI {
  registerViewType(type: string, provider: ViewProvider): Disposable
  // providers: { kind: 'terminal', session } | { kind: 'panel', url/html }
  //          | { kind: 'tree', dataProvider }   (declarative sidebar lists)
  registerStatusItem / registerBarItem(...): Disposable   // cheap contributions
}
```

The layout tree is the ported `SplitTree` (pure, tested) with regions as
first-class roots' children. **Every mutation is a command** (§4.3) — the tree
object is read-only to extensions, so invariants live in one normalizing
funnel (the review's §Bad-10 fix).

### 4.3 Commands — the one verb table

```ts
interface CommandAPI {
  register<A, R>(id: string, spec: { schema: Schema<A>,
    handler: (args: A, caller: Caller) => Promise<R> }): Disposable
  invoke<A, R>(id: string, args: A): Promise<R>
}
type Caller = { kind: 'user' } | { kind: 'extension'; id: string }
            | { kind: 'device'; deviceId: string }
            | { kind: 'agent'; sessionId: SessionID }
```

Keyboard, palette, CLI socket, MCP, remote, and extensions are transports into
this registry. The envelope carries the attributed `Caller`; authorization
(extension permission grant, device workspace entitlement, agent-session
scoping) runs **in the dispatcher**, before any handler. Unknown command /
failed schema = typed error, logged, never a silent no-op. `caller.kind ===
'agent'` exists because §5.3's orchestrator invokes commands about *its own
task* — scoping an agent to its task is one predicate here, not N checks.

### 4.4 Events + external ingress

```ts
interface EventAPI {
  emit<T>(topic: string, payload: T): void
  on<T>(topic: string, fn: (p: T, envelope: Envelope) => void): Disposable
}
// Envelope: { seq, ts, source: Caller } — sequence per source, gap-detectable
```

Two unix sockets, both HTTP (framing/ack/timeout/size-limits for free):
- **event ingress** (`events.sock`): `curl --unix-socket … -d @-` from hooks;
  body = one `jq -cn` envelope; `pane_id` named honestly; per-session `seq`
  so the `PreToolUse`/`PermissionRequest` race is *detectable*.
- **control** (`control.sock`): the CLI (CLI-first by decision — MCP
  deferred; it would be a thin adapter over the same registry if ever
  needed), a thin adapter over
  `commands.invoke` with `caller: {kind:'device'|'agent'}`. `wait` is a
  long-lived NDJSON subscription (never 200ms polling).

### 4.5 Attention

```ts
interface AttentionAPI {
  set(target: SessionID | NodeID, a: { level: 'none'|'info'|'attention'|'urgent',
       reason: string, color?: Token } ): void
  // Core aggregates → dots, dock badge, ⌘⇧A ring, notification routing.
  // Routing policy (banner/chime/push, isViewing suppression) is core,
  // ported from NotificationRoutingPolicy; *meaning* stays in extensions.
}
```

### 4.6 Process execution

```ts
interface ProcessAPI {   // permission-gated
  exec(cmd: string[], opts: { cwd, env?, stdin?, timeoutMs, signal? }):
    Promise<{ ok: true; stdout: string } | { ok: false; code: number; stderr: string }>
  gitRead(args: string[], opts): Promise<...>   // always GIT_OPTIONAL_LOCKS=0
  gitWrite(args: string[], opts): Promise<...>  // env MERGED, never replaced
}
```

One runner; the review's §Bad-6 fixes are structural. `GIT_EDITOR`-style
substitutions are arg arrays, never interpolated strings.

### 4.7 Cross-extension APIs

```ts
api.extensions.get<TasksAPI>('shepherd.tasks')   // typed, semver-checked
```

Built-ins export typed APIs (`tasks` exposes spawn/list; later `worktrees`
exposes provision/archive). This is the dependency-arrow mechanism from the
sketch's §3 table.

**Extensions are platforms.** The SDK ships a standard extension-point
primitive, so *any* extension can declare seams others plug into — not just
the core (the gap VS Code half-has: its contribution points are core-owned):

```ts
// declared by an extension, registered into by others
const repoSuggestions = api.points.define<RepoSuggestionProvider>(
  'tasks.repoSuggestions', { order: 'priority' })
repoSuggestions.register(provider)         // any extension
repoSuggestions.all() / .first(input)      // the owner consults
```

Rule (the dogfood rule, one level deeper): **a built-in routes its own
pluggable decisions through its own extension points** — the tasks composer's
repo picker is a `RepoSuggestionProvider` consumer and the usage-ranked
default is just the default provider, so "auto-pick repos from the prompt
text" is a third-party extension, not a fork. Cost, accepted knowingly: an
extension's points are public API under the same proposed→stable process —
which is why seams should be few and coarse (well-chosen providers), not
hooks on everything.

## 5. The first three extensions (the API's proof)

### 5.1 `agents-core`

Generic agent session tracking; knows no vendor.

- Exports `registerAgentKind({ id, detect, stateMachine })` and a typed API:
  `agentFor(sessionId)`, `onTurnFinished`, `state(sessionId)`.
- Owns the **reconciliation sweep** (review §Bad-5): state says
  working/blocked but `session.hasForegroundProcess()` false ⇒ demote, log why.
- Maps agent state → `attention.set` (the *only* writer of attention for
  agent sessions — v1's "a nudge never writes AgentState" rule, inverted and
  kept).

### 5.2 `claude-code`

- `sessions.onWillCreate` → inject **`SHEPHERD_SESSION_ID`** +
  `SHEPHERD_SOCK` (event ingress path). Correlation preserved exactly.
  *(Corrected 2026-08-07 while building P3, which fixes the wire format: this
  said `SHEPHERD_PANE_ID` (= session id), which is v1's `tab_id`-holding-a-pane-id
  lie in new clothes — the exact thing §4.4's "`pane_id` named honestly" is
  about. A hook correlates to the session, and `SessionID` is declared to be
  "THE correlation key, everywhere", so both the env var and the ingress field
  say session.)*
- Subscribes to ingress topic `claude.hook`; reduces via the **ported
  `StopPolicy.applyEvent`** (first artifact ported, tests first) with
  `viewing: layout.isViewing(...)` threaded as a parameter, unchanged.
- Persists `resumeSessionID` in `session.meta` (split from ownership — review
  §Ugly-4's `ownerSessionID`/`resumeSessionID` fix); restore seeds
  `claude --resume` through the composed-command seam.
- Ships the plugin: `report.sh` byte-compatible, transport swapped to
  `curl --unix-socket`, envelope via one `jq -cn`, per-session `seq`.

### 5.3 `tasks`

- Task store (**SQLite** via better-sqlite3 in main, schema-versioned
  migrations; machines write DBs, humans write files — user config stays
  text): `Task = { id, title, brief,
  repos: RepoRef[], state, sessions: SessionID[], createdAt }`.
- **`TaskRootSynth`** (pure): given repo list → the task root's generated
  `CLAUDE.md` (brief + repo map) + `.claude/` symlink aggregation plan,
  conflicts flagged. Materialized under `~/.shepherd/tasks/<slug>/` beside
  one **worktree per repo** (ported `WorktreeService` semantics via
  `gitWrite`).
- Composer view (⌘T): title/brief/repo fuzzy-picker (usage+recency ranked,
  history in `ctx.storage`).
- Commands: `tasks.create`, `tasks.spawn` (`{repo, prompt}` → new tracked
  session in the task — callable with `caller.kind === 'agent'`, scoped to
  the caller's own task), `tasks.archive` (per-repo two-commit archive +
  transcript), `tasks.restore`.
- Sidebar tree view: tasks grouped by state; per-task session dots ride
  attention.
- Ships the **skill** (CLI-first) teaching orchestrators: harness subagents
  for cheap parallelism; `tasks.spawn` for tracked workstreams.

## 6. Testing

- Pure ports land **tests-first** (the ~2,600 lines translate mechanically):
  `StopPolicy`, `SplitTree`, persistence DTOs, `TaskRootSynth`, ring buffer.
- The SDK test harness fakes `Clock`, `ProcessAPI`, and sessions — the review
  §Bad-9 state machines (debounce/floor/queue) get their fake-timer tests.
- One Playwright smoke per milestone: boot, open terminal, run `claude`
  (stub), see state dot change, create task, archive it.
- The `-only-testing` vacuous-pass class dies with vitest, but keep the habit:
  a green run counts only when the test count moved.

## 7. Milestones

- **M0 — skeleton**: workspaces, lint boundaries, Electron boots, one xterm.js
  view on a main-process node-pty session, splits (ported SplitTree), dev/prod
  isolation (`userData` split), single-instance lock.
- **M1 — kernel**: extension host + manifest/permissions, command registry with
  attributed callers, event bus + both HTTP-over-unix ingresses, storage,
  attention aggregation, terminal/layout re-expressed through the API (the
  app's own chrome becomes caller #1).
- **M2 — agents**: `agents-core` + `claude-code` live; StopPolicy ported with
  tests; plugin transport swapped; badge/notifications; reconciliation sweep.
- **M3 — tasks**: composer, worktree-per-repo provisioning, `TaskRootSynth`,
  spawn/archive/restore, sidebar tree, the skill + CLI verbs.
- **M4 — dogfood gate**: develop v2 inside v2 for a week; minimal CLI
  (`ls/state/tell/view/wait`) rides the control socket. Exit = the cut line.

Each milestone ends with its ADR(s) for anything decided along the way — the
v1 habit that made this rewrite tractable is not optional in v2.
