# Contextual nudges

Shepherd has a workbench that resolves merge conflicts, finishes a stopped rebase,
reviews a diff and opens a PR. None of it announces itself. A user who does not
already know `⌘G` exists never finds any of it, and a half-applied rebase in a
background pane is invisible until they happen to press it.

This adds a small system that surfaces a feature **at the moment its condition is
true**, and removes it when the condition stops being true.

## What this adds

- `RepoSignals` — cheap git facts per pane, kept live by a watch on `.git`.
- `NudgeRegistry` — pure; the single place that decides which nudges a pane has.
- Two render surfaces: a glyph + count in the sidebar row, and a one-line bar
  above the terminal.
- Four nudges: `resolveConflicts`, `continueSequence`, `reviewChanges`, `createPR`.

## The decision that shapes everything

**A nudge is chrome, not a message.** It is not a popup, a toast, a modal, or
anything that steals focus. It renders in a fixed place while a condition holds and
disappears when it stops holding. There is no queue, no timing, no animation in.

Two consequences follow, and most of this design is downstream of them.

**It never writes to `AgentState`.** "3 conflicts" is not an agent state, and the
hook lifecycle map (ADR 0015, ADR 0020) is the sole author of `Pane.state`. Nudge
urgency is a **second channel** combined at the rollups. Writing `.blocked` onto a
pane because git is mid-merge would corrupt a state machine whose ordering guard
already depends on nothing else touching it.

**It is derived, never stored.** Every nudge is a function of facts re-read from
git, `gh`, and the store. Nothing is cached that could disagree with disk, for the
same reason `WorkbenchSession.conflictContext` is computed rather than held.

### Not a git hook

The obvious detector is wrong and cannot be built. There is **no git hook for a
merge, rebase or cherry-pick that stopped on conflicts**: `post-merge` fires only on
a *successful* merge, `post-rewrite` only after a *successful* rebase, and
cherry-pick fires nothing at all. Conflicts are precisely the path with no hook.

Installing into `.git/hooks` would also fight the user's own hooks, not survive a
clone, and break Shepherd's standing rule that correlation happens through injected
env and never by modifying the user's repo.

The state we want is **files on disk**. `MERGE_HEAD`, `CHERRY_PICK_HEAD`,
`rebase-merge/` and `sequencer/` appear the instant git stops, so a watch on the git
dir reacts immediately, needs nothing installed, and catches conflicts created
outside Shepherd entirely.

## 1. `RepoSignals` — pure

```swift
enum SequenceOp { case merge, rebase, cherryPick, revert }

struct RepoSignals {
    var operation: SequenceOp?     // a sequence dir / *_HEAD is present
    var conflicts: Int             // git ls-files -u, unique paths
    var dirty: Int                 // git status --porcelain, non-empty lines
    var ahead: Int                 // commits not on the upstream
    var behind: Int
    var branch: String?
    var hasUpstream: Bool
}
```

All of it is cheap, all of it is read off-main:

```
exists   MERGE_HEAD | CHERRY_PICK_HEAD | REVERT_HEAD
         rebase-merge/ | rebase-apply/ | sequencer/
count    git ls-files -u
count    git status --porcelain
count    git rev-list --count @{upstream}..HEAD  /  HEAD..@{upstream}
```

Parsing is pure (`RepoSignals.parse(...)`), the `Process` calls are a thin shell,
mirroring `WorktreeService` / `SleepPolicy` / `StopPolicy`.

`conflicts > 0` with **no** sequence dir is the `.loose` case `SequencePolicy`
already names — a conflicted `git stash apply`, `checkout -m`, or `apply -3`. It is
a real state that produced a shipped defect, and it must surface here too.

## 2. `RepoWatcher` — the shell

One `DispatchSource` vnode watch per **resolved git dir**, refcounted across panes,
because several panes usually share one repo. Debounced ~200ms; a merge touches the
dir many times.

Re-read is also triggered by `StateTransition.turnFinished` and by `focusPane`, so a
missed vnode event self-heals at the next thing the user does.

**The worktree case is the trap.** In a linked worktree `.git` is a *file* pointing
at `<common>/.git/worktrees/<name>`, and that directory — not the file, not the
common dir — is where `MERGE_HEAD` and the sequence dirs live. The watch must follow
the pointer.

Results publish into `AgentStore.repoSignals[paneID]`.

## 3. `NudgeRegistry` — pure, and the only place that decides

```swift
struct PaneFacts {
    var agentState: AgentState
    var repo: RepoSignals?
    var pr: PR?
    var unresolvedThreads: Int
    var workbenchOpen: Bool
    var isRemote: Bool
    var provisioning: Bool
    var ghInstalled: Bool
}

enum NudgeID      { case resolveConflicts, continueSequence, reviewChanges, createPR }
/// Whether this nudge is eligible for the pane bar, and how often.
enum NudgeBarPolicy { case always, firstFire, never }
/// Whether this nudge joins the attention rollups (§5).
enum NudgeUrgency   { case attention, informational }

struct Nudge {
    var id: NudgeID
    var glyph: TablerIcon.Name
    var text: String              // "merge stopped · 3 conflicts"
    var count: Int?               // the sidebar chip
    var bar: NudgeBarPolicy
    var urgency: NudgeUrgency
    var action: NudgeAction
}

NudgeRegistry.nudges(for: PaneFacts) -> [Nudge]   // precedence-ordered
```

`bar` and `urgency` are **orthogonal**: the first decides whether the pane bar draws,
the second whether the dock badge counts it. A nudge can be loud in one and silent in
the other, and conflating them is how a badge ends up disagreeing with the chrome.

Callers take `.first` for the sidebar glyph and `.first(where: barShows)` for the
bar. Adding the deferred nudges later is a row plus a test case — the shape
`ShortcutCatalog` and `StopPolicy` already have, and the reason they cost nearly
nothing.

### The four nudges

| id | condition | sidebar | bar | urgency | action |
|---|---|---|---|---|---|
| `resolveConflicts` | `conflicts > 0` | conflict glyph + count | always | attention | workbench, `.files` |
| `continueSequence` | `operation != nil && conflicts == 0` | sequence glyph | always | attention | workbench, `.files` |
| `reviewChanges` | `dirty > 0 && agentState ∈ {idle, needsCheck} && !workbenchOpen` | chip | first fire | informational | workbench, `.workingTree` |
| `createPR` | `ahead > 0 && pr == nil && ghInstalled` | `↑n` chip | first fire | informational | the PR prompt (§7) |

**Every condition is a predicate over present facts, never an event.** An earlier
draft gated `reviewChanges` on `turnFinished`, which contradicts §"derived, never
stored" — a derived nudge cannot read an event that has already passed. A finished
turn is observable as `agentState ∈ {idle, needsCheck}`, which is the same
information without the stored flag. `turnFinished` stays what §2 says it is: a
trigger to *re-read* `RepoSignals`, not an input to the registry.

`resolveConflicts` and `continueSequence` are separate ids on purpose: the verb
differs (*Resolve* vs *Continue*), and the second is the state that costs people an
afternoon today — one `--continue` from done, with nothing in Shepherd saying so.
They read one condition source, so they cannot both fire.

### Precedence

```
blocked  >  error  >  conflicts / stopped sequence  >  needsCheck  >  working  >  idle
```

A waiting agent outranks a conflict. A conflict outranks a finished turn.

### The bar policy

`.always` draws the bar whenever the condition holds. `.firstFire` draws it the
**first time that nudge's condition ever occurs on this install**, then never again —
a `Set<String>` of nudge ids under `shepherd.nudge.seen`. You learn `⌘G` once and are
not nagged after; the sidebar chip keeps reporting the state forever.

### Suppressed entirely

- **The onboarding tour is running.** Its sandbox stages a real merge conflict on
  purpose; the tour must not nudge about its own demo.
- **Remote / mirror workspaces.** The host owns the repo and runs git. Same v1
  boundary the worktree features already draw.
- **Provisioning panes.** The directory does not exist yet.

## 4. Rendering

### Sidebar

A third case in the glyph slot that `LeadingIcon` and `PRStatusIcon` already share
(`SidebarView.swift:477`), plus a count chip in the empty trailing space after the
row's `Spacer`.

**Row height does not change and no subtitle appears.** An earlier sidebar grew
alerted rows into a taller two-line card and it was reverted for visual noise, with
a standing rule against keying any size or layout change off attention state. A
nudge fits the slots that exist or it does not render.

### Pane bar

`NudgeBarView` — one line, ~26pt: glyph, text, one button, a `×`. Rendered per-pane
in the `SplitContainer` leaf, so a split showing two different repos tells the truth
about both. Starved (zoomed-away) panes are 0×0 and draw nothing anyway.

**The bar must never remount the surface.** It appears and disappears directly above
a live libghostty surface, and a conditional that *wraps* a surface tears it down:
new `ghostty_surface_t`, new PTY, and the old shell — with its `claude` — hangs up.
That bug shipped once via `.onboardingAnchor(…, if:)` and was invisible, because a
remounted plain shell is indistinguishable from the original. So:

- the bar is a **sibling** in the leaf's stack, never a wrapper;
- a test hosts the leaf, toggles the nudge, and asserts `makeNSView` ran once —
  the same way `OnboardingAnchorTests` pins the original.

### Dismissal

`×` hides the **bar** for that pane and nudge until the condition goes false and
true again. The sidebar glyph does not dismiss: it is a state, not a message, and a
conflict you dismissed is still a conflict.

## 5. Attention, without touching the state machine

`attention` nudges join the rollups — `Workspace.aggregateState`, the dock badge,
and `⌘⇧A` — combined with `Tab.attentionState()` at the point of aggregation. So a
conflict in a collapsed folder of a hidden workspace is still visible and still
reachable by `⌘⇧A`.

**No notification, no chime, no FCM push.** A conflict is a *condition*, not an
event, and it is always downstream of an action that already alerted you. Per
ADR 0020 viewing is one predicate; nothing here adds a second visibility check.

## 6. The action

```swift
enum NudgeAction {
    case openWorkbench(scope: WorkbenchScope)
    case createPR
}
```

`openWorkbench` reuses the path `openPRInWorkbench` (`AgentStore.swift:649`) already
walks: reveal the pane, open the workbench, set the scope. `continueSequence`
additionally scrolls the rail to the Continue control; it does **not** press it —
`--continue` can conflict again, and a one-click sequence advance from a bar the user
just noticed is not a decision they made.

## 7. `createPR`

Condition: `ahead > 0`, no PR, `GH.isInstalled` — the same gate every PR feature
sits behind, since a GUI `.app` misses Homebrew's PATH.

Clicking opens an `NSAlert` with an `NSStackView` accessory: an editable **title**
prefilled from the commits, a **body**, and a **Draft** checkbox. Then
`git push -u` if there is no upstream, `gh pr create --title … --body-file - [--draft]`,
then `refreshPR` + open it in the workbench PR band.

`NSAlert` + `accessoryView` is the established prompt here — worktree branch names,
workspace rename and Set Directory… all use it (`SidebarView.swift:344`, `:360`,
`WorkspaceEmptyView.swift:53`). The one place this prompt is more than those: the
body needs a **scrollable `NSTextView`** (~120pt), because a template is routinely
40+ lines.

### Why Shepherd asks instead of guessing

`gh pr create --fill` derives the title from commit info — with several commits that
falls back to a heuristic off the branch name, so it will happily open a PR titled
`fix-merge-conflict-ux`. Creating a PR is outward-facing and hard to undo. Shepherd
asks, prefills the best guess, and creates only what the user saw.

`gh pr create --editor` is **not** an option: an app-spawned `Process` has no tty,
so it would not fail, it would **hang forever** — the trap `git <verb> --continue`
already taught this codebase (hence `GIT_EDITOR=true`).

`-T/--template` is also not used. It only seeds gh's *interactive* body and is
ignored once `--body` is passed, and the whole point is that the user sees the body
before anything is created. Shepherd reads the template itself.

### `PRTemplate` — pure

```swift
PRTemplate.locate(candidates: [String]) -> String?
```

GitHub's documented locations, first hit wins, filenames matched
case-insensitively:

```
pull_request_template.md            (repo root)
docs/pull_request_template.md
.github/pull_request_template.md
```

Body prefill precedence: **template if one exists, verbatim.** That is the repo's
convention and exactly what a human filling GitHub's form would get. Commit messages
are **not** appended — a checklist template with a commit log stapled underneath is
worse than either alone. No template ⇒ the body starts empty; the title still comes
from the commits.

**A multi-template directory is not guessed.** `.github/PULL_REQUEST_TEMPLATE/`
holding several templates is selectable only through GitHub's `?template=`
parameter; picking one would silently apply the wrong convention. That case prefills
nothing.

The body reaches git on **stdin** via `--body-file -`, not as an argv string — a
template is markdown full of backticks and quotes, and `GitStaging.run(env:)`'s
`Process` shape (which *merges* into the inherited environment, never replaces it,
or git loses `HOME` and its config) already makes stdin the natural path.

## 8. Testing

Pure, in `ShepherdModelTests`:

- `NudgeRegistryTests` — facts → nudges, precedence order, bar policy, the
  first-fire rule, and each suppression. Including that `bar` and `urgency` are read
  independently, since collapsing them is the obvious future regression.
- `RepoSignalsTests` — parsing `ls-files -u` (unique paths, not lines),
  `status --porcelain`, `rev-list --count`.
- `PRTemplateTests` — each of the three locations, precedence between them, case
  variations, the multi-template directory returning nil, no template at all.

Real-git integration, alongside `ConflictIntegrationTests`:

- `RepoSignalsIntegrationTests` — produce a genuine conflict four ways (merge,
  rebase, cherry-pick, `stash apply`) and assert the signals. Those four leave
  *different* state on disk and the stash one leaves no sequence dir at all, which
  is exactly the case that shipped broken before.
- A linked worktree mid-merge, to pin that the watch follows `.git`-as-a-file.

AppKit:

- The surface-remount test from §4.

## 9. What does not change

- `AgentState` and the hook lifecycle map. Untouched.
- Notification, chime and FCM routing. Untouched.
- Row heights, the sidebar's layout, and the rule against `wantsAttention`-keyed
  layout changes.
- The workbench itself. Nudges only route *into* scopes that already exist.

## Deferred

A row each in the registry once the mechanism is live, needing no new machinery:

- `checksFailing` / `unresolvedThreads` — the red PR icon and the unresolved-count
  badge already render; these only give them an action.
- `pushBranch` — has a PR, local commits ahead.
- `sameFileTwoPanes` — two panes' agents editing one file. Genuinely
  Shepherd-shaped, since multi-agent is the thesis, but it needs write-tracking and
  is the easiest one here to make noisy.

Also deferred: rebinding a nudge's action, and any nudge that is not about a single
pane's repo.
