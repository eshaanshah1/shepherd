# 0033. (v2) Extension UI is in-proc React, and what crosses the port is a name

Status: Accepted
Date: 2026-08-08
Scope: `v2/` only.

## Context
[ADR 0031](0031-v2-a-contributed-view-declares-itself-and-a-row-click-is-the-extensions.md)
left the ⌘T composer unbuilt and said why: a form needs a contribution kind that
does not exist, and building it in the core renderer would put the words
"title", "brief" and "repo" into the shell — sketch §2b's special case, which is
the thing the whole view model is tested against.

It named two candidates: **panel views** (`WebContentsView`, per-extension
session partitions — §7's "panel isolation: yes") or the **in-proc React seam**
(§7b). They read as alternatives. They are not.

## Decision
**§7b is a taxonomy, and the composer falls on the in-proc side.** Its words:
"granted extensions render real views; webviews remain available for *app-like
panels*." A dock form is chrome, not an app: a `WebContentsView` for it buys
per-extension isolation that a built-in does not need, and pays for it in a
second web contents, its own focus and z-order against the host page, and a
second styling world for a form 40 lines long. Panel views stay the answer for
the app-like case — the workbench, which brings its own editor — and stay
refused until that milestone.

**What crosses the port is a NAME.** A React component is functions, exactly
like `TreeDataProvider`, so it cannot cross any more than a provider could. An
extension declares `{ kind: 'component', component: 'tasks.composer' }` from its
service half; the renderer resolves that string against a **static table**
(`renderer/extension-ui.ts`) and mounts what it finds. Three consequences, each
deliberate:

- An extension can **ask for** a module and cannot **supply** one, so nothing
  reaches the page that the build did not see. A name outside the table draws a
  visible "this build has no UI for that", not an empty box that reads as loaded.
- A **built-in's** UI is code the build can see; a third party's needs a runtime
  loader, which is real work and is not implied by this. §7's graduation rule
  wants built-ins as the proving ground, and this is what that looks like.
- The two halves of an extension are two **directories** — `src/` (the service,
  in a utility process with no DOM) and `ui/` (the page) — with a lint boundary
  between them, because the split is a process boundary. The service half never
  imports its own UI, which is what keeps react out of the extension host.

**A component's `invoke` is attributed exactly like a row click** (0031's D14).
The component names a command; main derives the caller from the view type's
owner. The only difference from `views.activate` is that this one keeps the
answer — a form has to show what happened — and it is the *same method*
underneath, because a second way to run a command is where `{kind:'user'}` would
quietly come back.

## Consequences
`tasks` contributes the composer as a consumer and the core learned nothing:
`ViewDock` gained a branch on `kind`, not a branch on tasks. The mechanism was
built against a **trivial consumer** first — `diagnostics` contributes a card
carrying the three axes a static one would not exercise: local state the host
must not clobber, an `invoke` whose answer is drawn, and an `invoke` that fails
(a denial, arriving as a value). It is **registered, not merely unit-tested**:
the first look at the running app found the card absent from the dock, which
would have left "a second extension can do this too" resting on a test written
by the same hand as the mechanism.

`smoke:m3` now drives the real form in the real DOM — typing through the native
setter plus an `input` event, because a plain `.value =` is a write React never
hears about — clicks a suggestion that came from the `tasks.repoSuggestions`
point, and then asserts the worktree and the synthesized task root on disk. Its
first live run failed on a hardcoded repo name: the CLI *supplies* a repo's name
and the picker *derives* it, so the composed task's worktree is at its path's
basename. That is the fifth time in this milestone that running the thing found
what reading it did not — and **looking** at it found three more: the card that
was never registered, an "add repo" button wrapped onto two lines by a
`width: 100%` field, and a suggestion chip advertising a name the composer would
not use. A provider's `name` is therefore dropped and `repoName(path)` is the
one derivation, because the built-in provider answers with the names of earlier
tasks and honouring them would let one task's naming choice follow a repo
forever.

The renderer may import `@shepherd/ext-*/ui` and nothing else of an extension.
Enforcing that took two lint entries and a measurement: a single
`['@shepherd/ext-*', '!@shepherd/ext-*/ui']` denies the `/ui` import too, because
these are gitignore-style patterns and gitignore cannot re-include a path under
an excluded directory — the same measurement that already put `denyExact` in
that file for `@shepherd/core`. Matching one segment down makes the negation
work; the package roots are named exactly, one line per extension.

## Not decided here
**⌘T.** The composer is a view in the dock, which is where M3b's dock model puts
a view. Giving it a keystroke means either a placement vocabulary (`REGIONS`,
which 0031 names as the scope-creep door) or a menu that consumes
`contributes.commands[].key` — nothing reads that field today. Both are their
own piece of work, and the milestone's bar is "a task can be created from inside
the app", which is met.

**Third-party in-proc UI.** The table is static, so a community extension has no
way in yet. That is §7's graduation order, not an oversight — and when it lands,
the loader is the interesting part, not this seam.
