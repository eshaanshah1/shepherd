# Shepherd Architecture Review — Before the Electron Rebuild

*2026-08-06 · reviewed at `fable-architecture-review` (master @ f646ef8) · five parallel deep-reads over `spike/seam1/Sources/`, `claude-plugin/`, and the ADRs*

---

## Verdict

The *ideas* in this app are strong and mostly portable; the *debt* is concentrated in two god objects and, above all, in one root decision — **terminal lifetime is coupled to view lifetime** — whose shadow accounts for a shocking fraction of the codebase's complexity. Electron dissolves that decision and the 24k-line editor fork for free, which makes this a genuinely good moment to rewrite.

Roughly: of the ~36k-line workbench surface, only **~11% is portable domain logic**; of `AgentStore`'s 3,385 lines, only **~900 are actually the app model**.

---

## The Good — port these, some near-verbatim

### 1. The pure-policy / imperative-shell pattern is the crown jewel

`StopPolicy.applyEvent`, `SleepPolicy`, `IdlePolicy`, `NotificationRoutingPolicy`, `RowPlanner`, `Diff3`, `PatchSynth`, `SequencePolicy`, `pairingDecision`, `StormDetector`, `NudgeRegistry`, `CLIShim.state`, `OnboardingPolicy`… every one is a total function over values, takes `now`/`viewing`/randomness as *parameters*, and carries its reasoning in doc comments. That's ~40 files and ~2,600+ lines of tests that port to TypeScript almost mechanically.

In the rebuild, make the boundary structural: `src/core/**` may import nothing but the stdlib (lint-enforced), instead of an 86-path hand-list in `project.yml` — which is currently so much friction that the config parser ended up living in `WorktreeService.swift` because that file was already on the list.

### 2. Specific decisions worth protecting

- **Hooks, not scraping** (ADR 0003) and **pane-id as the universal correlation key** injected via PTY env. The socket, CLI, remote protocol, notifications, and view identity all key off one UUID. Non-negotiable; keep exactly.
- **`isViewing` as one predicate** (ADR 0020) feeding the reducer *and* every alert channel, plus **`turnFinished` as a semantic event** separate from state. Return facts from reducers; don't make consumers infer them from state transitions.
- **Host-authoritative mirroring with idempotent full-tree snapshots.** No client optimism, no merge, no CRDTs; reconnect = re-snapshot. This is why the protocol survives having no sequence numbers. The snapshot-filtered-as-well-as-deltas workspace projection is the right instinct.
- **Narrow persisted DTOs.** `Pane` encodes 3 of 12 fields, so a restored pane *cannot* claim to be `.working`. Every added field is optional with the reason inline — one migration in the project's history, and it was painless.
- **Security reasoning.** Authorization (6-digit code = "a human is at the host") vs channel authentication (SAS over cert hash) kept as separate jobs; SAS confirmed by picking from three decoys, never an Allow button; pin stored only after SAS confirmation; a refused handshake is terminal and never retried; QR-carried pin skips the ceremony because the measured user behavior made the ceremony worse.
- **Data-only FCM as *wake*, never content** — no terminal text transits Google; the woken app raises the notification locally. Dead-token pruning and push coalescing close the loop.
- **`Diff3` + the git craft.** The zdiff3 three-way merge over index stage blobs (never marker parsing — marker text depends on `merge.conflictStyle` and rebase inverts the sides); `GIT_EDITOR="cp '<file>'"` substitution (the failure mode is a hang, not an error); `headMoved` as the only reliable `--continue` discriminator; `-m --first-parent` for merge commits (which also makes stashes readable for free); per-path `checkout HEAD` never `reset --hard`; env merged never replaced. Days of rediscovery encoded in ~150-line files.
- **The two-detached-commit worktree archive** under `refs/shepherd/archived-worktrees/<id>`: staged tree via `commit-tree`, working tree via throwaway `GIT_INDEX_FILE`, parented so restore reproduces the staged/unstaged split with one `read-tree`. A data format, so it ports unchanged.
- **`RepoWatcher`'s coalescing model**: floor-not-debounce (a re-arming debounce lets a rebase burst postpone the read forever), one read per *checkout* fanned out to all panes, one-in-flight-one-queued, `immediate` may only pull a queued read earlier, refcounted vnode watches, pause-while-inactive remembering *which checkouts* went stale. Port it as a **generic** keyed debounce+fan-out primitive — PR polling currently hand-rolls the same shape, worse, on a blind 60s timer.
- **The event-first layering** (nowhere written down, load-bearing everywhere): semantic events (`turnFinished`, `didFocus`) are authoritative; filesystem watching is the backstop for changes Shepherd didn't cause; polling never. Write this down in the rebuild.
- **`GIT_OPTIONAL_LOCKS=0`** on watcher-triggered reads — git's own switch for "a read must not write, or the watcher feeds itself." (See The Ugly: it's applied in exactly one place.)
- **Dev/prod isolation** (`AppMode`): dev target with its own defaults domain, support subtree, sockets, ports, icon; seeded from the daily app's layout with session IDs stripped so it never hijacks live agents. Gets *better* in Electron: `app.setPath('userData', …)` + a build-time constant, and cross-instance seeding becomes an explicit, versioned JSON read.
- **The logging rule**: *"every branch that ends in 'and then nothing happens' logs why."* Millisecond timestamps because lines get correlated against tcpdump; grep-able categories; level re-readable at runtime; dependency-free so every test target compiles it.
- **The skills as API docs** — `controlling-shepherd`'s "Common mistakes" section written against observed model hallucinations, and `handoff`'s "point, don't paste" brief-in-a-file design.
- **Create-or-repair, never replace** (ADR 0005) for everything installed outside the sandbox — the five-case `CLIShim.State` / `ClaudePluginInstaller` classification. The motivating bug (dangling symlink → PATH fall-through → case-insensitive match on the GUI binary → typing `shepherd` launches a second app) **recurs verbatim in Electron**, whose binary is also named after the app. Port the classification as-is.

---

## The Bad — real debt, fix in the rewrite

### 1. Two god objects

**`AgentStore` (3,385 lines) owns 24 distinct concerns**: 37 `@Published` properties, ~222 methods, 4 `NSLock`s inside a `@MainActor` class, 3 `NSAlert`s constructed in the store, 154 silent `else { return }` no-ops. ~35% of it (~1,200 lines) is remote/LAN/pairing/push code that has nothing to do with terminals; another 310 lines are a stringly-typed CLI router. It appears in **zero** of 86 test files — the modal dialogs and `Process` calls inside it are why.

**`WorkbenchSession` (2,748 lines)** is the same story: ~24 responsibilities from scope state machine to blame caching to `NSTextStorage` plumbing. ~27–33% of it is pure editor workaround that Monaco deletes.

The decomposition is obvious and the rewrite's process boundary forces half of it:

| Module | Owns |
|---|---|
| `WorkspaceStore` | workspaces/tabs/panes/selection, split-tree ops, persistence; workspace-scoped by default |
| `AgentLifecycle` | socket → reducer → state write; emits semantic events, nothing else |
| `AttentionRouter` | badge, banner, chime, push, ⌘⇧A — subscribes to events |
| `RepoServices` | PR polling, review threads, nudges, worktree provisioning/archive; returns values, never presents UI |
| `RemoteHub` | serving + client roles + pairing + device registry |
| `ControlRouter` | the CLI verb table, as a thin adapter |

### 2. Three command surfaces implement the same verbs

`controlRoute` (310 lines of `[String: Any]`), `applyRemoteCommand`, and `ShortcutActions` are three implementations of one verb set. **One typed command union, three transports (keyboard, CLI socket, network)** is the single highest-value refactor and maps perfectly onto Electron IPC.

Related: remote commands today work by *puppeteering the host's UI* — `cmdSplit` reveals the pane then splits "the focused one"; `cmdReorderTab` switches the host user's workspace to index into it. This fails the moment two clients act concurrently or the host user is mid-action. Commands should be addressed mutations (`split(paneId, axis)`), with focus changes a separate, explicitly-authorized command.

### 3. Authorization is read-side only

Workspace projection carefully filters what a device can *see* (snapshot and deltas both), but `applyRemoteCommand` receives no device identity — a device synced only to workspace A can `cmdClosePane` a pane in workspace B. Data-channel admission checks only that the nonce is live, never workspace entitlement; pane UUIDs are the only protection. Thread device identity into every mutation and every data-channel admission, and run the same `syncs(workspaceID)` predicate on both. Cheap now, painful retrofit later.

### 4. Protocol evolution is aspirational

- `kRemoteProtocolVersion = 2` is transmitted and **never read** — no negotiation, no minimum, no capabilities.
- One unknown enum case makes `JSONDecoder` throw, discarding the *entire* decoded batch including known frames — silently (`try? … ?? []`). This directly contradicts the "keep messages additive" contract stated three times in the file.
- The hand-maintained command allowlist has **already drifted**: `cmdSetWorkspaceDirectory` and `cmdNewWorktreeTab` are defined, implemented, and sent by the Mac client — and hit `default: break`. Two shipped features are dead on the Mac→Mac path right now.

Rebuild: exhaustively-dispatched discriminated unions (a total `switch` that fails to compile when the protocol grows), per-frame decoding with an explicit log-and-skip unknown branch.

### 5. No liveness protocol, anywhere

- On the wire: `ping`/`pong` exist but nothing sends them. A client can't distinguish "host gone" from "host idle," so its only move is re-dial — that *is* the reconnect storm; `StormDetector` deliberately only observes it. Rejections are prose strings the client string-matches to decide whether to retry. Fix: heartbeat + miss budget on both sides; machine-readable rejection codes with server-dictated `retryAfterMs`.
- Locally: if `claude` dies without `SessionEnd` (SIGKILL, crash, missing `nc`), the pane reads `working`/`blocked` **forever** — blocking auto-update restarts, refusing `pane close`, hanging `shepherd wait`. The app already computes the reconciling signal (`paneIDsRunningProcess`) and uses it only for update-idleness. Add a "state says working but no foreground process ⇒ demote" sweep.

### 6. Subprocess sprawl

Three-and-a-half git runners with contradictory semantics: `env:` **replaces** the environment in `Git.run` and **merges** in `GitStaging.run` (whose header names the other's error-swallowing as the mistake it exists to avoid — while `DiffReader.git` is still there doing it, and can deadlock on a full stderr pipe). No timeouts or cancellation anywhere — an unreachable remote hangs worktree provisioning indefinitely with no cancel path. `GIT_EDITOR` values are shell-interpolated strings one refactor away from injection.

Rebuild: **one** `runGit(args, {cwd, env, stdin, timeoutMs, signal})` returning `{ok, stdout} | {code, stderr}`, and separate `gitRead()` (always `GIT_OPTIONAL_LOCKS=0`) vs `gitWrite()` so the watcher-feedback fix is structural, not remembered.

### 7. `gh` as the only GitHub client

`nil` means all of: no PR / not authed / rate-limited / offline / gh crashed — and `refreshPR` deletes the cached status on nil, so **losing wifi silently erases every PR icon** rather than showing them stale, with no log line (the exact silent-nothing the logging rule forbids). Two processes per checkout per minute, no ETags, no rate-limit handling. Rebuild with Octokit (`gh auth token` as the credential source, one spawn, cached): conditional requests, typed errors, one connection. **Keep `PRStatus.swift`'s pure classification unchanged** — that's the product value.

### 8. Config and persistence

- The `# shepherd:` comment-smuggling scheme has **three independent parsers** whose key lists have already drifted: `config set log-level` writes a *native* ghostty line that the log system never reads — a live bug. (Note: the file isn't actually ghostty's config; it's Shepherd's own file in ghostty syntax, because `ghostty_config_load_file` only accepts files. The reason evaporates with xterm.js, which takes a theme *object*.)
- `save()` re-encodes every workspace/tab/pane tree on **every `cd` in every pane** (OSC PWD → `setCwd` → full JSON encode). No debounce, no dirty tracking; encode failures silently persist nothing.
- Selection persists **by index** while ids regenerate; a tab silently dropped during restore shifts every subsequent index and restores the wrong selection.
- 34 UserDefaults keys as string literals at point-of-use; known hosts reconstructed by prefix-scanning `dictionaryRepresentation()`. Three different persistence patterns for three blobs.

Rebuild: one schema-validated config file with one `{key, parse, render}` table; versioned JSON state with `schemaVersion` *in* the payload; debounced writes; select-by-id; one typed settings module; terminal theme generated from the same token module as the chrome CSS (making the hand-synced duplicate palette structurally impossible).

### 9. The tests stop exactly where the hard parts start

`RepoWatcher`, `SleepGuard`, `UpdateController` — the most intricate state machines in the services layer — have **zero tests**, because they're fused to `Timer`/`DispatchQueue`/`@MainActor`, untestable by construction. Everything around them is tested. With injected clocks and injected spawns in TypeScript, the debounce/floor/queue/pause interaction is a ~50-line fake-timer test. Write those tests in the rebuild; they're the highest-value tests in the layer.

### 10. Miscellaneous debt worth naming

- `store.tabs` is a computed property with a setter: one split = three get-modify-set cycles = three full copies of every pane tree + three publishes. It also spawned **12 duplicated `inWorkspace:` method overloads** when the accordion sidebar needed to act on non-active workspaces.
- `ephemeralPanes` as a parallel container for a variant of the same entity = **7 hand-written forks** at every per-pane operation. One collection, a `location` discriminator.
- `locatePane` is an O(everything) linear scan called 24 times, up to 3× per hook event, with no paneID→location index.
- Seven model invariants (selection validity, focused-pane-is-a-leaf, global pane-id uniqueness…) held only by convention, violations silently no-op. One of them (`collapsingAllExcept`) shows the right answer: a pure normalizing funnel every mutation routes through.
- Model files import SwiftUI (`AgentState.color`, `ShortcutCatalog`'s `KeyEquivalent`) — the state machine knows what color amber is.
- `Theme.mode` is process-global mutable state; a test helper mutates and restores it in a `defer`.
- Tier-2 keep-awake depends on undocumented passwordless sudo (`sudo -n pmset`), silently working only for users who hand-edited sudoers, mutating global system state that outlives the process. Electron: `powerSaveBlocker` for Tier 1; make Tier 2 an explicit privileged helper or drop it.
- The updater's integrity story is `codesign --verify` on an *ad-hoc-signed* bundle — a corruption check, not identity. Ship signed + notarized, use electron-updater for the mechanism, **keep `UpdateController`'s policy layer** (eligibility gate, 24h floor, skip-version, restart-when-idle) — restart-when-idle is the product feature for a terminal running long agent turns.
- Onboarding: script-as-data, the offline deterministic sandbox, and per-invocation `-c user.name=… -c commit.gpgsign=false` git config are excellent — port verbatim. But cleanup is keyed on `goal` (steps sharing a goal share cleanup; a residue-leaving step with `goal: .none` gets none) across three teardown paths that must agree; make cleanup per-step `{enter, exit}` plus one idempotent manifest-driven reconcile. And replace the 0.25s goal-polling timer with a reactive selector.

---

## The Ugly — one-way doors you get to un-choose

### 1. Terminal lifetime == view lifetime (the finding)

Because the PTY lives inside an `NSView` owned by the SwiftUI tree, "keep it alive" can only be spelled "never unmount it." Everything downstream of that one coupling:

- The all-mounted flat `ForEach` + opacity gating across every tab of every workspace (every surface a live Metal layer + PTY + shell, no cap, no LRU);
- **Three** independent visibility gates in three files that must agree, plus a manual `hitTest` override because `.allowsHitTesting` doesn't propagate into raw NSViews, plus a fourth `hittableOverride` axis reading a global singleton;
- Zoom starving siblings to 0×0-but-mounted;
- `PaneChrome` and `OnboardingAnchorIf` — two files existing solely to hold the "never conditionally wrap a pane" workaround, two test files pinning it (with negative controls), an ADR, and three CLAUDE.md sections;
- **Issue #1** — "a workspace switch no longer kills your agent" — and the same `_ConditionalContent` bug class shipping a *second* time via the nudge bar;
- A real resource leak (`discardWorkbenchSession` written and never called) from non-deterministic view-driven teardown;
- Three `NotificationCenter` broadcast side-channels because there's no addressable handle to a surface — every surface receives every `injectText` and filters by pane id.

The blast radius of a *cosmetic layout tweak* is a dead `claude` session — invisible in review, invisible at runtime, detectable only by a changed tty/pid and lost scrollback.

**In Electron: PTYs live in the main process, owned by a registry keyed by pane id, lifetime tied to the model.** Unmounting a component closes nothing; hidden panes render nothing at all (better than occlusion); hit-testing is CSS; teardown is `registry.close(paneID)`. And note you've **already proven this architecture works**: the remote path (`PtyBroker` + `shepherdd attach`, "the PTY lives on the host; the attach process just carries its bytes") *is* main-process PTY ownership. Use it locally too. Keep the ring + viewer fan-out + replay-before-live-bytes semantics (a real circular buffer this time — `removeFirst` is O(n) per burst). Keep the "stable keys, unconditional wrappers" instinct anyway: the failure mode softens from dead agent to lost scroll position, but it's still a failure.

### 2. The 24,015-line editor fork

247 files vendored — **no upstream pin, no patch series, no vendor script** (unlike CodeEditLanguages, which got all three) — to change ~50 lines and un-private two functions. ~7,000 lines are disabled subsystems (Find, Minimap, CodeSuggestion, LineFolding…). And the fork *still* couldn't express the model, so the app grew:

- **Four coexisting answers** to "make a band clickable" (gutter arrows, rail actions, drawn+hit-tested overlay, hosted SwiftUI cards) — all because `TextView.hitTest` swallows every click;
- **Three views** independently reconstructing the editor's line geometry from a shared closure set (with a documented drift bug when one used arithmetic instead of the layout manager);
- Block heights via **line-fragment inflation** paired with manual sum-tree updates, leaking `topInset` patches into caret/selection math and forcing `visibleRect.union(dirtyRect)` draw-bounding;
- An `NSHostingView` **measure-and-cache loop** for note heights with an async width-feedback channel;
- 50 lines reconstructing copy text because removals aren't in the document, requiring a new upstream delegate method.

**The document model itself is correct** — new-side-only rows, removals as bands, `RowPlan` as the single layout authority, provenance as one type — and it is precisely Monaco's multi-model + view-zones design, arrived at independently for the right reasons. In Electron: `RowPlan`/`EditMap`/`PatchSynth`/`StageSelection`/`Diff3`/`SequencePolicy` (+ ~2,600 lines of their tests) port as pure functions; `PlannedBlock` becomes an `IViewZone` descriptor with a real DOM node; word-diff spans become decorations; ~29,000 lines are deleted.

**One warning:** don't port full-document-replacement-plus-remount (`revision += 1` → `.id(revision)` → new editor, new scroll view, reattach everything — and N blob loads = N remounts). That single decision is the root cause of most of the reattachment machinery. Design for incremental model updates (`applyEdits` + `changeViewZones`) from day one and four of the ugliest workaround families never come back. Also delete `StitchMap` — it's superseded by `RowOrigin`, no longer trusted for its one job, and still built and published every rebuild.

### 3. fd-keyed networking

Coherent in Swift, but it forces: fd-recycling defenses in four places ("writing would inject this dead connection's bytes into a live client's stream"), a ~30-line prose contract for who may `close` vs `shutdown` across three files, comment-argued lock ordering, thread-per-connection blocking reads (O(N+M+K) OS threads against libdispatch's ~64-thread ceiling, during exactly the reconnect storms that matter), and the entire `LANBridge` socketpair — which exists *only* because `RemoteServer` is fd-keyed. In node, both listeners yield one `Duplex`; key by connection-id string; ~350 lines of scar tissue gone with the same topology preserved. Keep the *policies* (drop a client that won't drain; per-connection write ordering; bind `0.0.0.0` once rather than enumerate interfaces).

Likewise the **PTY tap helper**: `shepherdd pty` = two nested PTYs per pane + a helper process + `$SHEPHERD_PTY_SOCK` + `PtyHub` + `ptyHello` + `TapRetry` + a hand-duplicated wire codec + a three-way size-authority triangle with two documented bugs. node-pty owning the PTY deletes all of it. What it loses — shells surviving an app crash, crash isolation from a wedged reader — is worth one deliberate decision (own PTYs in a utility process, not the renderer), not the current machinery.

And fix pairing at the root: **device identity should be a keypair, not a per-address shared secret.** `altSecrets` (six retained secrets per device), the `relocateLANHost` trial-TLS-dial-and-migrate-three-UserDefaults-keys dance, and the re-approval carve-out for secret mismatches are three individually well-reasoned patches that collectively say the schema is wrong. Key trust by device public key and all three cases stop existing.

### 4. The hook socket can stall the agent it observes

`SocketServer` does one blocking `read()` inline on the accept thread — no timeout, no read-to-EOF loop, 8KB buffer:

- A short read (legal at any size on a stream socket) or an oversized `AskUserQuestion` payload = **the entire event silently dropped** — the pane never goes blocked, no banner, no push;
- A client that connects and writes nothing wedges the accept loop **forever**, freezing state for every pane in the app;
- `report.sh` pipes through `nc` with no `-w`, and hooks are synchronous — so a wedged server hangs the hook, which hangs the agent's turn. **The observer stalls the observed.**

Adjacent debt: `report.sh`'s "zero parsing on the common path" invariant is no longer true (it runs `jq` on every event — the exact latency class ADR 0004 exists to prevent, crept back once the guard made it survivable); the hand-rolled JSON escaper misses newlines (invalid JSON = silent drop); `payload` is JSON double-encoded into a JSON string because bash can't compose JSON; there's no sequence number, so the `PreToolUse` → `PermissionRequest` race can overwrite `blocked` with `working` with no re-notification and no way to detect it; and `tab_id` carrying a pane id is a load-bearing lie across ~10 files whose original justification (external plugin compat) expired when the plugin moved into the app bundle.

**Best rebuild move:** make the hook channel **HTTP over a unix socket** (`http.createServer` + `curl --unix-socket … -d @-` instead of `nc`): framing, a real ack, request timeouts, and body-size limits for free — and `curl` is far more universally present with consistent flags than `nc -U`. Keep the hook itself as shell (node's ~40ms startup would reintroduce the original ordering bug). Build the envelope with one `jq -cn` (fixes escaping, double-encoding, and one process per event), add a per-session sequence number, rename `tab_id` → `pane_id`. Also: `~/.shepherd/control.sock` is unconditionally `unlink`ed at startup with no single-instance check — a second app instance silently steals the CLI from the first; `app.requestSingleInstanceLock()` is one line.

Two more traps recorded for the rewrite: `shepherd wait` is 200ms client-side polling (up to 1,500 round-trips) that *samples states* and misses fast transitions — make it a long-lived NDJSON subscription; and `Pane.sessionID` does double duty as ownership lock *and* resume target, held apart by a side-effecting clear in an unrelated function — split into `ownerSessionID` / `resumeSessionID`.

### 5. `isViewing`'s presence sensor is the portability risk

The *policy* layering is right (pure `decide()`, three destinations, phone strictly last). But `isAway = lid closed && no external display` is a heuristic wearing a predicate's clothes — an iMac is never "away," a laptop in another room is never "away," a locked screen isn't "away" — and it gates whether the user is told *anything* when absent. Electron has no clamshell API; `powerMonitor` + display enumeration only approximates it. Budget native-module work here (it gates the one channel the phone exists for), make presence an explicit multi-signal input (idle time, lock/unlock, display state) behind the existing `decide()` seam, and keep `viewing` as a *parameter* into the reducer, as it already correctly is.

---

## Rebuild checklist

### Port near-verbatim
Every `*Policy`/pure file + its tests (`StopPolicy` first — highest-value single artifact); `SplitTree` (331 dependency-free tested lines); `RowPlan` + the workbench pure layer; `Diff3` + `ConflictReader.readState`; the git craft (editor substitution, headMoved, first-parent, env-merge); `PRStatus`/`PRComments` classification; `NudgeRegistry` + `PaneFacts`; `WorktreeArchive`; `CLIShim.State` / plugin-installer classification; `OnboardingPolicy.script` / `OnboardingGoal` / the demo sandbox; `UpdateController`'s policy layer; `Log`'s design and rule; the persistence-DTO discipline; the mirror-snapshot protocol; the pairing/SAS reasoning; both SKILL.md files; dev/prod isolation.

### Redesign before writing code
1. **PTYs in the main process**, keyed by pane id, lifetime owned by the model — the single biggest win; deletes an entire bug class plus ~10 workaround artifacts.
2. **One typed command union**, exhaustively dispatched, device-attributed and workspace-authorized, serving keyboard + CLI + remote.
3. **Split the store**: workspace-store / agent-lifecycle / attention-router / repo-services / remote-hub / control-router.
4. **One `runGit`** (timeout, AbortSignal, concurrent drain, `{ok}|{err}`), with `gitRead`/`gitWrite` split so `GIT_OPTIONAL_LOCKS=0` is structural.
5. **Liveness both places**: heartbeat + miss budget + machine-readable rejection codes with `retryAfterMs` on the wire; a foreground-process reconciliation sweep locally.
6. **HTTP-over-unix-socket hook channel** with sequence numbers; single `jq -cn` envelope; `pane_id`; single-instance lock on the control socket; subscription-based `wait`.
7. **Monaco with incremental model updates + view zones**; never full-replace-and-remount; one mechanism for clickable bands.
8. **Keypair device identity** — deletes `altSecrets`, host relocation, and per-address secrets.
9. **Octokit over `gh`** (keep `gh auth token` as credential source); one schema-validated config file; versioned JSON persistence, debounced, select-by-id.
10. **Write the missing state-machine tests** (coalescing watcher, sleep tiers, update phases) with injected clocks/spawns — cheap now, impossible before.

### Don't recreate
The editor fork; fd-keying and `LANBridge`; the PTY tap helper (`shepherdd pty`/`PtyHub`/`TapRetry`/`HelperFrame`); the four-way clickable-band split; full-document remount; comment-smuggled config keys; `sudo -n pmset` (use `powerSaveBlocker`; explicit privileged helper for Tier 2 or drop it); the hand-rolled updater mechanism; untyped `[String: Any]` routing; computed-property views with setters; parallel containers for pane variants; model files importing the view framework; `save()` on every `cd`; index-based selection persistence; `/tmp` as a log namespace.

---

## Closing observation

The codebase's best habit — pure policies with reasoning in comments, ADRs that record *why* (including the one that documents its own predecessor being wrong), tests with negative controls — is exactly what makes this rewrite tractable. The hard-won knowledge is mostly already extracted into portable form. The rewrite's job is to stop paying rent on the two platform fights — view-owned PTYs and a forked text editor — that generated most of everything else.
