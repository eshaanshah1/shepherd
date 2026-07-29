# Onboarding flow — design

**Date:** 2026-07-29
**Status:** implemented on `onboarding-flow`; not yet runtime-verified
**Branch:** `onboarding-flow`

---

## 1. The problem

Shepherd now ships as a DMG off a GitHub release, so the first thing a stranger
sees is an empty sidebar and a shell prompt. Nothing on screen says the app is
anything other than another terminal, and the one piece of setup that makes it
*not* a terminal — the Claude Code plugin, without which there are **no agent
states at all** — is buried in Settings → General.

Three separate gaps:

1. **Setup.** The plugin is opt-in and undiscoverable. Notification permission is
   requested at launch with no explanation of why. Theme is a config file.
2. **Discovery.** Panes-as-agents, workspaces, the workbench, worktree
   archive/restore, `⌘⇧A`, the state model itself — none of it is reachable by
   poking around, and `⌘/` only helps someone who already knows `⌘/` exists.
3. **Proof.** The pitch is "you never babysit an agent again." That is a claim
   about something that happens *over time*, which a static screen cannot show.

## 2. What we're building

A first-run flow in three parts:

- a short **interactive welcome card** that installs the plugin, reports
  notification permission, and sets a theme;
- a **real scratch git sandbox** the tour operates in — locally generated, offline,
  identical for everyone, deleted afterward;
- a **linear coach-mark tour** whose cards point arrows at real UI elements and
  which *performs* each thing it describes: it really splits the pane, really
  starts `claude`, really opens the workbench, really adds a worktree.

Auto-starts once per install. Re-runnable from Help → *Shepherd Tour*.

### Non-goals

- No PR-status demo. `gh pr view` needs a real GitHub remote and the sandbox's
  origin is a local bare repo. The feature is described, never faked.
- No remote/phone-pairing demo. Mentioned in the final card only.
- No Back button (§7.1).
- No fabricated agent state anywhere. Every dot the tour shows is a real hook.

## 3. Architecture

Seven new files; five are pure and unit-tested.

| File | Role |
|---|---|
| `Sources/OnboardingPolicy.swift` | **pure** — `OnboardingStep`, `OnboardingAnchor`, `OnboardingAction`, `OnboardingRequirement`, `Preflight`; `OnboardingPolicy.steps(for:)` filters the script by what's available |
| `Sources/OnboardingPlacement.swift` | **pure** — `place(anchor:cardSize:container:)` → card origin + the edge the arrow leaves from; guarantees the card stays inside the container |
| `Sources/OnboardingDemoRepo.swift` | **pure** file/commit manifest + a Foundation `Process` git shell; `build()` / `teardown()` |
| `Sources/OnboardingController.swift` | `@MainActor` state machine over `OnboardingPhase`; owns the preflight, the demo ids, action execution, and teardown. Shaped like `UpdateController` |
| `Sources/OnboardingOverlayView.swift` | dimmed backdrop + spotlight cutout + card + drawn arrow + Skip/Next |
| `Sources/OnboardingWelcomeView.swift` | the welcome card — plugin via `ClaudePluginInstaller`, notification status, theme via `ShepherdConfigWriter` |
| `Sources/OnboardingAnchorKey.swift` | a `PreferenceKey` collecting `[OnboardingAnchor: Anchor<CGRect>]` + the `.onboardingAnchor(_:)` modifier |

The pure/shell split mirrors `SleepPolicy`/`SleepGuard` and
`StopPolicy`/`AgentStore.apply`: the step script is data, and only
`OnboardingController` touches AppKit or the store. The step script is the part
most likely to be edited later, so it is the part pinned by tests.

### 3.1 Types

```swift
enum OnboardingPhase: Equatable { case dormant, welcome, tour(Int), finished }

enum OnboardingRequirement { case always, liveAgent }   // liveAgent = claude + plugin

enum OnboardingAnchor: Hashable {
    case centered            // no arrow; card sits mid-container
    case terminalArea
    case folderHeader        // the demo workspace's folder header
    case tabRow(Int)         // index within the demo workspace
    case stateDot(Int)       // pane index within the demo tab
    case sidebarFooter       // where the update pill lives
    case workbenchRail
}

enum OnboardingAction {
    case none
    case buildSandbox
    case createDemoWorkspace
    case splitDemoTab
    case startClaude
    case promptWatched
    case promptUnwatched     // select sibling → prompt → ⌘⇧A
    case openWorkbench
    case addWorktreeTab
    case teardown
}

struct Preflight {
    var claudePath: String?      // resolved, not assumed on PATH (§7.4)
    var pluginInstalled: Bool
    var gitAvailable: Bool
    var sandboxBuilt: Bool
    var liveAgentPossible: Bool { claudePath != nil && pluginInstalled }
}

struct OnboardingStep: Identifiable {
    let id: String
    let title: String
    let body: String
    let anchor: OnboardingAnchor
    let action: OnboardingAction
    let requires: OnboardingRequirement
}
```

### 3.2 Anchoring

Real views publish their geometry with one modifier line:

```swift
StateDotView(...).onboardingAnchor(.stateDot(paneIndex))
```

which is `.anchorPreference(key: OnboardingAnchorKey.self, value: .bounds) { … }`.
`ContentView` reads the collected dictionary in an `.overlayPreferenceValue` and
resolves each anchor to a rect in its own coordinate space. This is the same
mechanism `SidebarView` already uses for `FolderCentersKey` / `FolderRegionsKey`,
so no view needs restructuring — anchoring is additive, and a view that forgets
the modifier degrades to a `.centered` card rather than a crash (§6).

### 3.3 Trigger

Auto-start when **both** hold:

- `shepherd.onboarding.completedVersion` (String) is absent from `UserDefaults`;
- there are no persisted workspaces (`shepherd.workspaces.v1` absent), so we are
  not about to bulldoze someone's restored session.

Plus a permanent Help → *Shepherd Tour* menu item, which starts it regardless.
No keyboard shortcut, so it does not enter `ShortcutCatalog`.

**Dev builds never auto-start.** `AppMode.isDev` seeds its workspaces from the
daily app's state, so the "fresh install" premise is false there. The menu item
still works, and its sandbox lives under the dev support subtree.

## 4. The sandbox

Generated locally with `git`, never cloned from the network, so it is offline and
byte-identical for every user.

```
~/.shepherd/demo/            (dev: ~/.shepherd/dev/demo/)
  origin.git/                bare — the "remote"
  tour-repo/                 the clone; the workspace's defaultPath
```

**Why a bare origin.** `WorktreeService` runs `git fetch origin` and **aborts the
whole worktree creation if it fails** (`WorktreeService.swift:114`), then reads
the default branch off the `refs/remotes/origin/HEAD` symref. A plain `git init`
repo has no origin, so step 8 would abort. A local bare repo makes `fetch origin`
succeed offline and `origin/HEAD` resolve, exercising the real code path with no
special-casing for the tour.

### 4.1 Build sequence

Every `git` invocation passes its identity and settings **per-command** —
`-c user.name=… -c user.email=… -c commit.gpgsign=false -c init.defaultBranch=main`
— so the sandbox does not depend on (or inherit surprises from) the user's global
git config. Someone with no `user.name` set, or with GPG signing configured,
would otherwise get a build that fails or blocks on a passphrase prompt.

1. `git init tour-repo`
2. three commits on `main`: `README.md`; then `greeter.py`; then `notes.md` plus a
   tweak to `greeter.py`
3. `git checkout -b feature/greeting`, two commits on it — so the **Commits scope
   (`⌃4`)**, which lists `<base>..HEAD`, has something to show
4. `git init --bare origin.git`; `git remote add origin ../origin.git`;
   `git push origin main feature/greeting`; `git remote set-head origin main`
5. dirty the tree, still on `feature/greeting`:
   - `greeter.py` — modified **and staged**, with two separated hunks and a
     removed line, so the workbench shows a deletion band and word-diff
   - `notes.md` — modified, **unstaged**
   - `scratch.md` — **untracked**

Steps 3 and 5 together are what make the workbench step real: `⌃1` has a
STAGED/UNSTAGED/COMMITTED split with actual content, `⌃2` diffs against `main`,
and `⌃4` lists the branch's own commits.

The build runs off-main while the user reads the welcome card. If it fails
(`gitAvailable == false`, or any command errors), `Preflight.sandboxBuilt` is
false and the tour degrades per §6.

## 5. The step script

Actions call the same store methods `ShortcutActions.run` calls. **No synthetic
key events** are posted anywhere.

| # | Card | Action | Anchor | Requires |
|---|---|---|---|---|
| 0 | **Welcome** — plugin / notifications / theme | `buildSandbox` (background) | centered | always |
| 1 | *It's a terminal first.* Real shell, real libghostty grid; mouse, scroll and copy/paste all work | `createDemoWorkspace` | terminalArea | always |
| 2 | *The sidebar is your agent list.* Tabs named from cwd, grouped into workspace folders; `⌃⇥` cycles | `none` | folderHeader | always |
| 3 | *⌘D splits a tab. Each pane is its own agent.* `⌘⇧D` stacks, `⌘⇧↩` zooms, `⌘⌥`-arrows move focus | `splitDemoTab` | stateDot(1) | always |
| 4 | *Start an agent.* The dot appeared because a **hook** fired — correlation is an injected env var, not PID guessing | `startClaude` | stateDot(0) | liveAgent |
| 5 | *Watch a turn.* Dot goes **working**; on finish the card swaps its own copy: it landed **idle**, not *done*, **because you were looking at it** | `promptWatched` | stateDot(0) | liveAgent |
| 6 | *And when you're not.* Dock badge, notification, `⌘⇧A` to jump to whoever needs you | `promptUnwatched` | stateDot(0) | liveAgent |
| 7 | *⌘G — the workbench.* `⌃1`–`⌃4` scopes, `⌘⏎` stages the selection, the buffer is editable, `⌘S` writes | `openWorkbench` | workbenchRail | always |
| 8 | *One branch, one directory, one agent.* Closing offers Archive / Discard; archives expire at 90 days | `addWorktreeTab` | tabRow(1) | always |
| 9 | *The rest.* `⌘,` for Settings, the update pill lives in this footer, `gh` gives idle agents a PR icon, `⌘/` lists every key | `none` | sidebarFooter | always |
| 10 | **Done** — the sandbox is being removed | `teardown` | centered | always |

### 5.1 Steps 5 and 6 are the point

Step 5 submits a real one-line prompt and waits for the turn to end **under the
user's eyes**, so it lands `idle`. Step 6 selects the sibling pane first, prompts
again, and the identical finish lands `needsCheck` — a real badge, a real
notification, and `⌘⇧A` really jumping focus back.

That contrast is the product thesis, demonstrated rather than asserted, and it
only works because the overlay is honest about visibility (§7.2).

Two constraints on the implementation:

- **Detect turn-completion off `StateTransition.turnFinished`, never
  `state == .needsCheck`.** Step 5's whole point is the viewing landing, where
  `needsCheck` never occurs — polling for it would hang forever.
- **Both prompts are single-line, deliberately.** A typed newline is an Enter
  press, so `injectText` is only safe for one line; anything longer would have to
  go through `pasteText` and its clipboard-callback borrow. The copy is written to
  the constraint rather than getting lucky.

## 6. Degrading

| Missing | Behavior |
|---|---|
| `claude` and/or the plugin | Steps 4–6 are filtered out and replaced by **one** substitute card: what is missing, how to get it, and a **static state-dot legend**. Anchored at `folderHeader`. No fake dots, no fake transitions. |
| `git`, or the sandbox build failed | Steps 1, 3, 7, 8 (everything needing a repo) are filtered out. What remains is a cards-only tour of the real, empty UI, plus a card saying the sandbox could not be created. |
| An anchor's view never published geometry | That step's card renders `.centered` with no arrow. A missing modifier is a cosmetic regression, never a crash. |

`OnboardingPolicy.steps(for:)` is the single place these decisions live, which is
what makes every combination cheap to test.

## 7. Decisions and hazards

### 7.1 No Back button

Actions are not reversible — you cannot un-split a pane or un-add a worktree, and
a Back that silently re-ran `addWorktreeTab` on the way forward would create a
second one. Rather than carry per-step idempotency guards for a nine-card tour,
the flow is **Next / Skip only**; `←` is unbound. `advance()` is the only
transition.

### 7.2 The overlay is *not* a full-takeover overlay

`isFrontPane` excludes panes covered by a full-takeover overlay (the workbench,
the code surface). The tour's card is a partial overlay over a genuinely visible
terminal, so it **must not** be added to that check. This is load-bearing, not an
oversight: it is exactly what makes step 5's "idle, because you were watching"
true and step 6's contrast real rather than staged. Per ADR 0020, viewing is one
predicate — do not add a second.

### 7.3 Every mutation is scoped to the demo workspace

The controller records the workspace, tab and pane ids it created and only calls
workspace-scoped store ops against them. It never calls an unscoped mutation, so
no path exists by which the tour can touch a user's own workspace. If the user
clicks into their own workspace mid-tour, the next action re-selects the demo
workspace first.

### 7.4 `claude` is resolved, not assumed

A GUI `.app` does not inherit Homebrew's `PATH`, so `which claude` from the app
process finds nothing on a perfectly good machine. Resolve the real path the way
`GH.isInstalled` already does, and store it in `Preflight.claudePath`.

### 7.5 Teardown

Idempotent, and reachable from **five** paths:

1. the Done card,
2. Skip,
3. Esc,
4. `applicationWillTerminate` while a tour is running,
5. a **launch-reconcile** — a demo directory present at launch with no tour
   running is removed (the `SleepGuard` launch-reconcile pattern). This is what
   covers a crash or force-quit mid-tour.

It must do all of:

- close the demo tabs and remove the demo workspace from the store;
- `git worktree remove` step 8's worktree **and delete its branch** — the worktree
  lands under `~/.shepherd/worktrees/tour-repo/<branch>`, *outside* the demo dir,
  so `rm -rf ~/.shepherd/demo` alone leaves a stale registration behind;
- `rm -rf` the demo directory;
- set `shepherd.onboarding.completedVersion`.

**Teardown must complete before `persist()` runs.** Otherwise the demo workspace,
its panes' cwds, and a live Claude `sessionID` land in `shepherd.workspaces.v1`
and get restored — and `--resume`d — on the next launch, which would recreate the
sandbox tabs pointing at a directory that no longer exists.

### 7.6 The backdrop swallows clicks

The spotlight cutout is **visual only**; the dim layer eats every click outside
the card, so the user cannot wander off mid-tour into a state the script does not
expect. The welcome card's controls (Install, theme picker) are real controls
*inside the card*, not click-through to the Settings window behind it.

The overlay takes first responder while up, so `→`/`Return` (Next) and `Esc`
(Skip) cannot reach the PTY. On dismissal it returns focus to the terminal via the
existing `focusTick` mechanism. Note this is a deliberate exception to the
sidebar's `.focusable(false)` rule, which exists to keep keystrokes going to the
terminal — here we want them for the duration.

## 7.7 Deviations from this spec, as built

1. **The tour is 18 steps, not 11.** The original script gave the workbench — the app's
   largest surface — a single card, the same weight as "⌘D splits a tab", and never
   mentioned ephemeral panes, comments, review threads or the merge resolver at all. The
   workbench became five steps (open · stage · edit · comment · commits) and ephemeral
   panes, the conflict resolver and PR status each got their own.
2. **The conflict demo runs in the worktree, not the clone.** The clone's tree is
   deliberately dirty so the workbench rail has staged, unstaged and committed content —
   and `git merge` refuses over a modified index. The worktree created by the previous
   step is clean, which is why `worktree` must precede `conflict`. Both facts are pinned
   by tests. The sandbox gained a `feature/rename` branch to conflict against.
3. **`OnboardingRequirement` is an `OptionSet`, not an enum.** §6 needs to filter on two
   independent axes (no repo, no Claude Code); an enum would need a case per combination.
4. **Some steps invite rather than perform.** Typing into the buffer or firing ⌘⇧C *for*
   the user proves nothing about their keyboard, so those two steps describe and ask. The
   action enum carries `.none` for them; no extra machinery.
5. **`.sidebarFooter` resolves only when the update pill is present.** The pill is
   conditional, and adding an always-present strip would change sidebar layout for a
   cosmetic arrow. That step degrades to a centred card, which the overlay already
   handles for any missing anchor.
6. **The git shell is `Git.run`, not `WorktreeService.run`** — `WorktreeService` is the
   filename, not a type. Same for `AgentStore.save()` (not `persist()`) and
   `GhosttyApp.shared.reloadConfig()` (not a store method). `save()` and
   `worktreeBaseDir()` were made internal from private.
7. **The tour became interactive — the user drives, the tour watches.** The approved
   design had each step press its own key. In use that taught nothing and read as the
   tour skipping ahead, so every step that a person can reasonably perform now names the
   keystroke and waits on an observed goal (`OnboardingGoal` + `TourProgress`, pure and
   tested), with `Next` gated and a per-step skip. Only four steps still act for you:
   build the sandbox, create the workspace, start the conflicting merge, tear down.
   Two keybindings had to go with it — Esc closed the tour (it would eat the Esc that
   closes the cheatsheet) and Return triggered Next (it would advance the card the
   instant you typed `claude` and pressed return).
8. **The step count grew to 21** as the workbench got its own sequence and ephemeral
   panes, the merge resolver, PR status and `⌘/` got steps of their own — the original
   11 gave the app's largest surface a single card.
9. **The 5th teardown path needed a guard.** `applicationWillTerminate` calls
   `teardownNow()` unconditionally, which would stamp `completedVersion` for a user who
   never saw the tour. It now early-returns unless a tour actually ran.

## 8. Testing

New file `Tests/OnboardingTests.swift`, in the `ShepherdModelTests` target.

**`OnboardingPolicyTests`**
- step filtering across all four `(liveAgentPossible, sandboxBuilt)` combinations
- the substitute card appears exactly when `liveAgent` steps are filtered
- step ids are unique
- every step's `anchor` is a case the overlay renders
- `advance()` bounds — the last step's advance lands `.finished`, never out of range

**`OnboardingPlacementTests`**
- for anchors at each edge and each corner, the placed card lies entirely inside
  the container
- the arrow leaves from the side facing the anchor

**`OnboardingDemoRepoTests`** — real git, in the style of
`CommitDiffIntegrationTests`: build into a temp dir, then assert
- `origin.git` exists and `refs/remotes/origin/HEAD` resolves to `main`
- `main` has three commits; `feature/greeting` is two ahead
- the working tree has one staged, one unstaged, and one untracked change
- `teardown()` leaves nothing behind

Two build-system notes: pure sources must be added to the `ShepherdModelTests`
target's explicit `sources:` list in `project.yml` (`Tests/` itself is a glob), and
`xcodegen generate` must run before the first test run — `-only-testing:` on a
suite the project does not know about matches nothing and reports
`** TEST SUCCEEDED **`. Treat the run as real only once the test count moves.

## 9. Files touched

**New:** the seven `Sources/Onboarding*.swift` files, `Tests/OnboardingTests.swift`.

**Modified:**
- `ContentView.swift` — the overlay in the existing `.overlay { }` stack, plus the
  `.overlayPreferenceValue` that resolves anchors
- `SidebarView.swift`, `SplitContainer.swift`, `UpdatePillView.swift`,
  `WorkbenchView.swift` — one `.onboardingAnchor(_:)` line each
- `ShepherdApp.swift` — the Help menu item; construct `OnboardingController`
- `AppDelegate.swift` — launch-reconcile and terminate teardown
- `AgentStore.swift` — expose the scoped ops the controller needs; ensure teardown
  precedes persistence
- `project.yml` — new sources on both app targets and the pure ones on the test
  target
