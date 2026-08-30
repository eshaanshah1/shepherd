# The takeover — what landed, and what is left (2026-08-29)

The window stops being rail + stage and becomes an **attention router**. The
normative design is the single-file prototype `shepherd-takeover.html`; this
records what has been ported, the decisions taken on the way, and the two pieces
that need a design decision before they can land.

Six commits on `fawn-colbred`, each green on typecheck, lint and the full
suite:

| | |
|---|---|
| `8ad41a7` | a skin is a value — the quiet-craft ramp, faces and role re-pointing |
| `222f46d` | Home: the triage screen |
| `70f4207` | the router: `esc` stack, ⌘K switcher, the task band |
| `5af9333` | the push half: the toast |
| `c15caa3` | `surface: 'face'` — the four faces of a task (ADR 0051) |
| `df78177` | snooze: the reason, the three shapes of later, and the way back |

**Everything in the original brief is now built.** What is left is written
under "What is left" below and is smaller than what it replaced.

---

## The shape, as built — READ THIS FIRST

**The takeover's chrome is in the app's column, not on top of it.** `Takeover`
is a HOOK (`useTakeover`) returning the window's parts; `app.tsx` composes them:

```
.sh-app  (flex column)
  band ?? .sh-plate      flex: none   the takeover's chrome, or the plate — never both
  .sh-body               flex: 1      display:none while a face has the room
  face                   flex: 1      a contributed document, edge to edge
  home                   layer        z-index 4, the one honest overlay
  overlays               fixed        toast, switcher, Later menu
```

It was a `position: fixed` layer at z-index 4, and each of the three symptoms —
composer behind the band, terminal's first line clipped, `Ship` off the right
edge — had been patched separately (hide the rail, pad the stage, make the plate
opaque). All three were one fault: a fixed layer is not part of the layout it
sits in. Nothing compensates for anything now, and `smoke:takeover` measures it.

**There is no rail and no sky strip.** Deleted, not hidden: `display: none` still
mounts, still subscribes to every tree and still re-sorts on every nudge. The
tab strip draws only for a group with a SECOND tab.

## The shape, as built

`packages/app/src/renderer/takeover.tsx` is the layer. It paints **over**
`.sh-body` at `z-index: 4` and never unmounts the stage — above the rail and the
tab strip, below `.sh-screen` (5) so the composer opens over Home, below
`SettingsScreen` (20). Every root stays mounted with its ptys attached, which is
`_ConditionalContent`'s lesson and `SettingsScreen`'s precedent.

It carries its own traffic-light clearance (`.sh-take__plate`), because
`.sh-plate` is underneath it now.

**Home reads the view mechanism, not `tasks`.** Every `kind: 'tree'`
contribution's rows land on one screen (`takeover/entries.ts`). That is why
`Shells` is a region rather than a second hardcoded list — `shell.tree`
contributes it and the takeover has heard of neither extension. It works against
the REAL data today: `cardFor` in `extensions/tasks/src/index.ts` already
publishes `mark`, `elapsed`, `diff`, `repos`, `question` and `facts`, which is
exactly what `takeover/row-facts.ts` reads.

## Files

```
packages/design-tokens/src/themes.ts          the skin: two token tables + faces, under a name
packages/design-tokens/src/themes.test.ts
packages/app/src/renderer/fonts/InstrumentSans.ttf, FragmentMono-Regular.ttf
packages/app/src/shared/home-root.ts          HOME_ROOT_ID, shared with main
packages/app/src/renderer/takeover.tsx        the layer: nav, keys, toast queue
packages/app/src/renderer/takeover.css        the whole skin of the surface
packages/app/src/renderer/takeover.test.tsx   25 render/keyboard cases
packages/app/src/renderer/takeover/
  triage.ts  triage.test.ts    the grouping — pure
  nav.ts     nav.test.ts       the stack — pure
  raise.ts   raise.test.ts     the interrupt decision — pure
  places.ts  places.test.ts    ⌘K's list — pure
  row-facts.ts                 a defensive reader for a row's optional facts
  entries.ts                   contributed trees → triage entries
  faces.ts   faces.test.ts     which faces a task has — pure
  home.tsx  task.tsx  switcher.tsx  toast.tsx  later.tsx  face-body.tsx
```

The face contribution point (ADR 0051), across the five layers it had to touch:

```
packages/sdk/src/api-layout.ts                surface: 'face', face: {slot,subject}, ExtensionFaceProps
packages/app/src/ext-host/api.ts              the serializer sends `face`
packages/app/src/shared/ext-protocol.ts       the wire schema NAMES it (strict s.object)
packages/app/src/main/ext-host.ts             the handler passes it through
packages/app/src/main/view-registry.ts        ViewSurface, FaceSlot, the registry spread
packages/app/src/shared/bridge.ts             the DTO the renderer reads
packages/app/src/renderer/extension-ui.ts     EXTENSION_FACE_UI — the fourth table
packages/app/src/ext-host/runtime.test.ts     both halves pinned, mutation-checked
extensions/github/ui/task-diff.tsx            claims `diff`
extensions/editor/ui/task-files.tsx           claims `files`
extensions/tasks/ui/intent.tsx                claims `intent`
```

Snooze, which is task state and therefore `tasks`' (ADR 0032):

```
extensions/tasks/src/model/snooze.ts          the decision — pure, 11 cases
extensions/tasks/src/store.ts                 `snooze` on the record + its s.stored schema
extensions/tasks/src/index.ts                 tasks.snooze / tasks.wake, the wake sweep, `later` on the card
packages/app/src/renderer/takeover/later.tsx  the menu the shell draws from published verbs
```

---

## One surface per idea, inside a task

`Changes` (the `diff` slot) is the WHOLE review surface — the working changes
*and* the pull request carrying them, its checks and its threads. It renders
`ReviewPane`, which already drew the working changes on its home page, so the
richer surface was always the superset.

**Neither `editor.workspace` nor `github.review` opens as a tab inside a task.**
`github.review` keeps `sync.watch` (the faster poll for a task somebody is about
to read) and answers where the surface is; `editor.open` refuses only the
NO-PATH case.

The non-task cases, deliberately preserved:

- **A path is a subject of its own.** A scratchpad, the `Notes` root (ADR 0049),
  a directory belonging to no task — all arrive as `editor.open { path }` and
  still open a pane. The guard is written against the ARGUMENT, not the resolved
  directory: the same directory asked for and defaulted to are different
  requests.
- **Both PANES stay registered.** A layout persisted before this still holds
  those leaves, and a view type that stopped resolving draws an empty rectangle;
  a review of a pull request that is not the task you are in has no face to be.

## What the rail took with it

- **The dock's per-tree SEARCH.** It filtered one extension's rows and was
  answered by that extension, so it could reach past `SHIPPED_CAP`. ⌘K ranks
  PLACES and cannot. Nothing replaces it.
- **The sky strip** — the app's one illustration — had the rail as its only
  home. `PixelSheep` survives in Home's empty state; the strip does not.
- **ADR 0035's highlight**, as a testable claim: the rail's row lit while you
  were on its root. The takeover shows one place at a time, so the row and the
  screen are the same thing. The band naming the task you entered is the same
  invariant in the new shape, measured by `smoke:takeover`.
- **`surface: 'dock'` components** nearly went too — they now draw at the foot
  of Home. One consumer today (`diagnostics.card`, dev-only).

## Seams audited, and what the audit changed

`pnpm smoke:takeover` drives the real app and reads real geometry
(`getBoundingClientRect`, `elementFromPoint`). It covers Home, Shells, a task
created over the control socket, each of its four faces, the composer, the
switcher and the Later menu — asserting that the band's bottom edge IS the
body's top edge, that nothing extends past the window, and that the top-most
thing at a control's centre is that control.

It also asserts that a task's strip carries no `editor` and no `review` tab —
after RUNNING both verbs, and against the layout as well as the DOM, because an
empty strip is also what a group of one draws. Mutation-checked: with the
editor's guard removed the strip comes back `["Audit","editor"]`.

It found one defect the eye would have taken a while to: **the face keys and
`Later` needed a modifier.** On the `Agents` face an xterm has the keyboard
almost always and the takeover hands every bare key to the focused field, so a
tab printing `1` advertised a key that did nothing on the face you are usually
looking at. They are `⌘1`–`⌘4` and `⌘L` now, and the band prints what it binds.
A test pins the negative — a bare digit must not switch face.

## What is LEFT

### 1. Two `smoke:m3` checks, and neither is this work

`the repo picker` and `the set hook ran at the task root` fail identically at
`4d5b492` — verified before this branch started and again at every step since.
Everything else in that smoke passes, including all four composer checks and
both contributed-view checks, which are the halves the takeover could have
broken. `smoke:daemon` is fully green.

### 2. `Ready to ship` is still derived rather than read

A resting task with a diff behind it. `tasks`' lifecycle declares `done` and
nothing writes it, so the region is computed from facts that exist (see the
decision below). When something does write `done`, `triageOf` should read it and
the derivation becomes the fallback rather than the rule.

### 3. A second face `subject`

`face.subject` is `'task'` and only `'task'`. It is a field rather than an
assumption so a repo or a pull request arrives as a VALUE there. Nothing should
add one until something needs it — that is the bar ADR 0049 set, and ADR 0051
exists because the takeover met it.

### 4. `Ship` / `Discard` are the row's `primaryAction`

The task band draws whatever verb the row publishes, which today is `tasks`'
existing Ship / Restore. If ship and discard should be two buttons rather than
one, that is a second `primaryAction` slot on `TreeItem` — a shell change, but
the shell still would not learn what either verb does.

## Decisions taken, with their reasons

- **A theme is a value, not an edit.** `themes.ts` — the warm ramp is a second
  skin rather than an overwrite of the shipped neutral one, because light is
  DERIVED from dark and mutating the ramp would have silently re-derived light
  mode inside a commit about something else. Every hex is still in
  `design-tokens`; every override states both modes.
- **The accent is `sky`, and no amber anywhere.** A test walks every token in
  every mode for `#E5A63F` — "no amber" is the one instruction here that reading
  a role name cannot check.
- **Hue means off-nominal.** The skin re-points ROLES, not just tokens:
  `markWorking` goes neutral (work in flight is the normal case) and both
  `markWaiting` and `markReady` go to `sky` (your move is one colour; the
  heading above the row says which kind). The built-in skin makes the opposite
  call and the test asserts the disagreement.
- **`Ready to ship` is derived, not read.** `tasks`' lifecycle declares `done`
  and nothing writes it. A resting task WITH a diff is a ship decision; one
  without is asleep. Both facts exist today.
- **`ready` is `Needs you`.** That mark means a turn finished and nobody read
  it — a request. Filing it under finished work puts the one thing that just
  changed into the region you scan last.
- **A shell is decided structurally**, off the layout (a root in the home
  group), never off a flag or the mark: shells arrive tinted when an agent is
  running in one.
- **The bare letters are guarded by the TARGET, not the screen.** A focused
  xterm takes keystrokes through a real `<textarea>`, so the check that keeps
  `h`/`j`/`n`/`0` out of a text field keeps them out of the grid. This is what
  lets `J` work from inside a task, which is its whole value.

## Deviations from the prototype, and why

- **No clock in the header.** The OS says the time 20px above it, and a number
  that changes every minute in the corner of a triage screen is one the eye
  returns to for nothing. The live count stays.
- **The command palette moved from ⌘K to ⌘⇧P**, because the switcher took ⌘K.
  The two answer different questions and the switcher is the one reached twenty
  times a session.
- **`N` while a question is on screen answers it** rather than composing. The
  prototype loses this clash — `N` composes there, so the `N` printed on every
  Deny button never fires. With nothing asking, `N` is New again.
- **The takeover reserves the traffic-light band.** The prototype has no window
  frame; the app does.
- **`honey` and `plum` are untouched** by the skin. They are the `github`
  extension's PR states with their own `notFor` clauses, not the takeover's
  accent, and nothing on this surface draws them.
- **`cardFor` does NOT publish the brief.** The Intent face reads it off the
  record through `tasks.list`, which already answers with `brief`. Putting it on
  the card as well would send a paragraph per row on every read of Home — a copy
  of a fact exactly one surface draws, and a second place for it to go stale.
  The requirement was "so Intent has something to draw", and it does.
- **`Later` on a toast is not a fourth key on the card.** It opens the same menu
  as everywhere else, and while a toast is up `S` belongs to the CARD rather than
  to Home's first question — acting on a row the user is not looking at is the
  one thing an interrupt must not do.

## Traps for whoever picks this up

- `.sh-take` is `z-index: 4` **on purpose**, and it only works because
  `.sh-stage` is `position: relative` with no z-index and therefore opens no
  stacking context. If `.sh-stage` ever gains one, the composer disappears
  behind Home — which looks like a broken button, not a CSS bug.
- The toast effect depends on `entries` **alone**. Adding `nav.at` makes it
  re-run on every navigation with `previous` already advanced, so it can only
  ever fire on stale news.
- `smoke:m3` fails two checks (the repo picker and a task-root hook) identically
  on `origin/master`; they are not from this work. Its four composer checks pass,
  which is the half the takeover could have broken.
- **A face contribution has to be added in FIVE places** (listed under Files) and
  four of them fail silently. The serializer drops a field nobody added; the wire
  schema is a strict `s.object`, so a field sent but not named there costs the
  WHOLE registration and the view simply never appears. `runtime.test.ts` pins
  both halves — add the case before the field.
- **Waking a snooze happens on the tree READ**, not on a timer. If you add a
  timer for it you now have two things deciding when a task comes back, and they
  disagree the first time one is late.
