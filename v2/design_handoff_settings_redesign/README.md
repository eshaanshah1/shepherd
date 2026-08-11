# Handoff: Settings screen redesign (Shepherd v2 / ADE)

## Overview

The settings takeover (`⌘,`) reads as three unrelated columns: rows span the whole
window so a label and its control are 1500px apart, the nav lists two package
names and one section title, groups/headings/rows all carry the same weight, and
the worktree-hook page is a stack of unlabelled boxes. This handoff redesigns all
three pages plus the shell (bar, nav, search) without changing what settings
exist or how they are read and written.

Nothing in the data path changes. `SettingsRegistry`, `SettingsApi`, the change
push, `choicesFrom`, `isDefault`/reset, and the component-page escape hatch
(ADR 0033) all stay exactly as they are. This is a presentation change in four
files.

## About the design files

`Settings.dc.html` in this bundle is a **design reference written as HTML** — a
prototype of the intended look, not production code to copy. It hard-codes the
palette's dark-mode hex values inline because it has no access to the token
layer; **the implementation must not**. In this repo every colour comes from a
tier-2 role (`var(--sh-surface-raised)`) and every length from the derived scale
(`var(--sh-space-md)`), and `packages/ui/src/tokens.css` states that a hex typed
into a component stylesheet is structurally forbidden. Read the mock for
composition and hierarchy; take the values from the token names in the table
below.

Open the file in a browser. It shows two options side by side:

- **1a — today, recreated** from the current source, for comparison.
- **1b — the redesign.** This is what to build.

## Fidelity

**High-fidelity.** Layout, type steps, spacing, colours and states are all final
and expressed in the repo's own scale. Recreate 1b faithfully using the existing
primitives from `@shepherd/ui`. Where the mock and this README disagree, this
README wins.

## Files to change

| File | What changes |
| --- | --- |
| `packages/app/src/renderer/settings.css` | Most of the work: the bar, the nav, the measure, the group card, the row grid. |
| `packages/app/src/renderer/settings-screen.tsx` | Nav grouped into App / Extensions; page header gains a one-sentence description; group header markup. |
| `packages/app/src/renderer/settings-rows.tsx` | Row becomes a 2-column grid; changed-marker; the degraded-choices state. |
| `extensions/worktree-hook/ui/editor.tsx` | Three scope cards replacing the single `Composer`. |

New settings keys are NOT part of this work. (The mock's General page shows a
second row labelled "Density" purely to show a two-row group — `metrics.ts`
already derives from a density factor but no setting exposes it. **Omit that row**
unless you are also landing the setting.)

## Screens

### 1. The shell (bar, nav, search)

**Bar** — `.sh-settings__bar`, unchanged in structure: back `IconButton size="sm"`,
title, spacer, search `Field`.

- Padding goes from `sm md` to `md lg` (8px / 12px), so the bar is 44px and
  matches the plate above it rather than reading as a thinner strip.
- Title moves from `--sh-font-size-medium` (12px) to `--sh-font-size-body` (13px),
  weight 500, `--sh-text`.
- Search `Field variant="bordered"` fixed at `calc(var(--sh-control-lg) * 7.6)`
  ≈ 260px, height `--sh-control-md`. Add a leading `⌕` in `--sh-text-faint` and a
  trailing `KeyCap` reading `⌘F` (`--sh-font-size-nano`, `--sh-text-faint`) —
  `KeyCap` exists in `@shepherd/ui` and is display-only.

**Nav** — `.sh-settings__nav`, column width goes from `calc(var(--sh-control-lg) * 4)`
(136px) to `calc(var(--sh-control-lg) * 6)` (204px). 136px is what forced the
ellipsis that the nav-row comment in `settings-screen.tsx` blames for the
`General / agents-core / worktree-hook` reading.

Rows are grouped under two `SectionLabel`s:

```
APP ─────────────────
  General                 ← Row, selected: inverse video (unchanged)
EXTENSIONS ──────────
  Models
  Worktree hooks
```

- Group a page under **App** when `page.owner === 'shepherd'`, else **Extensions**.
  That is the same predicate `ownerLabel()` already uses; export it or reuse it.
- Order inside each group stays registry order (`page.order`).
- `.sh-settings__nav .sh-ui-row__label { font-family: var(--sh-font-sans) }` stays
  — every nav row is sans now, selected or not. In the current build the
  unselected rows render mono, which is what makes them read as package names.
- Still no `Row.meta` and no owner in the nav. The owner moves to the page header
  (below), exactly as the existing comment prescribes.
- `--sh-space-md` (8px) between the two groups; `2px` between rows.

### 2. The page frame (applies to every page)

```
.sh-settings__page     padding: calc(var(--sh-space-xl) + var(--sh-space-lg))   /* 26px */
.sh-settings__measure  max-width: calc(var(--sh-control-lg) * 18.8)            /* ~640px */
                       display: flex; flex-direction: column;
                       gap: calc(var(--sh-space-xl) + var(--sh-space-sm))       /* 20px */
```

The 26px inset is the composer's documented composition (`xl + lg`) rather than
`--sh-space-lg`; the measure keeps its existing "cap it, don't stretch it"
rationale, tightened from ~612px to ~640px.

**Page header** (`PageHeading`) becomes three things stacked with `--sh-space-sm`:

1. Title + owner on one baseline: `<SectionLabel>` is replaced by an `h2` at
   `--sh-font-size-title` (17px), weight 500, `--sh-text`. This is the one type
   step in the app and a settings page is the right place for it — a 10px tracked
   micro-label is a *group* voice, and using it for the page title is why heading
   and group currently read the same.
2. Owner beside it: `--sh-font-mono`, `--sh-font-size-small`, `--sh-text-faint`.
   Unchanged rule — nothing for `shepherd`, last dotted segment otherwise.
3. A one-sentence description in `--sh-font-serif` at `--sh-font-size-large`
   (15px), `--sh-text-dim`, `line-height: var(--sh-line-height)`. Rule 6: serif
   only where the app speaks in sentences. Copy per page:
   - General — "How the app looks and behaves, everywhere."
   - Models — "Which agent and model answer the short questions the app asks on your behalf."
   - Worktree hooks — "Scripts that run when a worktree is created. Three scopes, run in the order below."

   Source it from a new optional `SettingsPage.description` on the SDK type so a
   contributed page can supply its own; render nothing when absent.

### 3. The group card and the row

`.sh-settings__group` keeps the card it already has — `--sh-surface-raised`,
`--sh-hairline solid var(--sh-line)`, `--sh-radius-md` — and gains a **header
band** so the card says what it is:

```
.sh-settings__group-head
  height: var(--sh-row-height)            /* 28 */
  padding: 0 var(--sh-space-lg)           /* 12 */
  border-bottom: var(--sh-hairline) solid var(--sh-line)
  font: var(--sh-micro-font-size)/1 sans, letter-spacing var(--sh-micro-tracking-wide)
  text-transform: uppercase; color: var(--sh-text-faint)
```

The band holds `spec.group` on the left and an optional right-hand status
(`display:flex` + a spacer). Group padding changes from `0 var(--sh-space-md)` to
`0` — the rows own their padding now, so the band can be full-bleed to the card's
edges. A page whose specs declare no `group` gets one band labelled from the
page (General → "APPEARANCE", Models → "QUICK TIER").

**The row** (`.sh-setting`) goes from `flex; justify-content: space-between` to a
two-track grid — this is the single most important change:

```
.sh-setting
  display: grid
  grid-template-columns: minmax(0, 1fr) calc(var(--sh-control-lg) * 7)   /* ~238px */
  gap: var(--sh-space-lg)
  align-items: start
  padding: var(--sh-space-lg)
  /* .sh-setting + .sh-setting keeps its border-top hairline */
```

A fixed control track is what makes the pair read as a pair: the control can no
longer travel to the window's right edge, and every control on the page lines up
in one column. `.sh-setting__control` becomes `display:flex; flex-direction:column;
gap: var(--sh-space-sm)` and its `Select`/`Field` fill the track (`width: 100%`;
drop `Select`'s `min-width` inside settings via a scoped rule, don't change the
primitive).

Text column, unchanged values: label `--sh-font-size-body` / `--sh-text`;
description `--sh-font-size-small` / `--sh-text-dim` / `--sh-line-height`,
`margin-top: var(--sh-space-xs)`.

**Changed marker.** Today a modified row is signalled only by the reset button
appearing. Add, on the label line when `isDefault === false`:

- a 4px round dot in `--sh-prompt` (the "here, now" role), then
- `changed` in `--sh-font-mono`, `--sh-font-size-nano`, uppercase,
  `letter-spacing: var(--sh-micro-tracking)`, `--sh-text-faint`.

The reset `IconButton` (`IconRotate`, `size="sm"`) stays in the control column,
still only when `!isDefault`.

### 4. General

One group, band "APPEARANCE", one row: Theme. `Select` with the existing static
choices (System / Dark / Light), label and description verbatim from
`settings-general.ts`. The mock shows it in the changed state (value Light, dot +
`changed` + reset) to document that state — the default state has neither.

### 5. Models — and the degraded state

Two rows in one card, band "QUICK TIER". Labels and descriptions verbatim from
`AGENTS_MODELS_PAGE`.

Right now, when `agents.quickModelChoices` fails, both rows fall back to a free-text
`Field` with `invalid` set and the raw error as its message — two ember-outlined
empty boxes and a repeated `"agents.quickModelChoices" failed: invalid-args:
expected object, got undefined` across the page. It is loud and it tells the user
nothing they can act on. Replace with, per row:

- A **disabled `Select`** whose value reads `No choices` (`--sh-text-dim` ink,
  caret in `--sh-line`). The row keeps its shape; it does not become a different
  control.
- One line of plain language in `--sh-font-size-small` / `--sh-text-dim`:
  "`<owner>` couldn't list its choices." — owner from `ownerLabel(page.owner)`.
- A `Button size="sm" variant="default"` reading `retry`, which re-runs the one
  `invoke` for that key. `useDynamicChoices` currently never retries by design;
  the button is the user-driven retry that comment leaves room for, so keep the
  no-automatic-retry rule.
- The raw message, once, in `--sh-font-mono` / `--sh-font-size-nano` /
  `--sh-text-faint`, behind a disclosure that is closed by default. Never delete
  it — it is the only place the invalid-args string is visible.
- Ember appears exactly once on the page: a 4px dot in the card's header band
  beside `choices unavailable`. The row itself carries no red.

Second row when the first is unresolved: value `Default`, and the line
"Waiting on an agent above." in `--sh-text-faint`. No error repeated.

### 6. Worktree hooks (component page)

Stays a component page (`WORKTREE_HOOK_PAGE.component`), stays custom, and the
`Composer` goes. A composer is a writing surface with no inner hairlines — which
is precisely why three sections, three labels and three action rows inside one
disappeared into a single 16px-radius box.

Replace with **three cards** using the same `.sh-settings__group` treatment as a
spec page, so a contributed page and a kernel page read as the same app. Each
card:

```
header band   "1 · EVERY REPO"                     [right] $WORKTREE_DIR
body          purpose sentence (--sh-font-size-body, --sh-text)
              [scope-specific inputs]
              script well
footer        [status]                    [test run]  [save]
```

- Header band: number + scope name, micro/tracked/faint. Right-hand cell is the
  env vars that scope sees, `--sh-font-mono`, `--sh-font-size-nano`,
  `--sh-text-faint` — `$WORKTREE_DIR`, `$WORKTREE_SRC → $WORKTREE_DIR`,
  `$TASK_ROOT`. The numbers state the run order, which is real information the
  current page only implies through stacking order.
- Purpose sentences, verbatim from today's labels: "Runs first, in every
  worktree." / "Runs in that repo's worktree." / "Runs once at the task root,
  when all of them are present." These stop being `<label>`s (they label a
  script, not a field) and become body copy.
- **Script well** — `TextArea` with an explicit `--sh-line` re-declaration back on
  itself so it keeps its edge: `--sh-surface-sunken` background,
  `--sh-hairline solid var(--sh-line)`, `--sh-radius-sm`, `--sh-space-md` padding,
  `--sh-font-mono` at `--sh-font-size-medium` (12px), `--sh-line-height`,
  `minLines` 3 / 4 / 4 as today. A hook is a script: mono, in a well. Today it is
  sans on the card with no edge, which is the "unlabelled boxes" complaint.
- **Card 2's repo field** sits in the same `minmax(0,1fr) / control-lg * 7` grid as
  a settings row, so the path input lines up with the Selects on the other pages.
  Keep the `tasks.suggestRepos` `<datalist>` completion exactly as it is.
- **Card 3's members** are `Pill`s (`@shepherd/ui`) with a `×`, plus a dashed
  `+ repo` affordance. Delete the borrowed `.sh-composer-picked` markup and the
  `editor.tsx` comment that says to — the composer's chip list is a `Pill` now.
- **Footer**: `padding: var(--sh-space-md) var(--sh-space-lg)`, hairline top.
  Left is status (`--sh-font-mono`, nano, uppercase, faint): "saved · 2m ago",
  "2 repos · not saved", or empty. Right is `test run`
  (`Button size="sm" variant="default"`, wired to `WORKTREE_HOOK_COMMANDS.testRun`)
  and `save`. **Exactly one `variant="primary"` on the page** — the card the user
  is editing; the other two are `default`. Three primaries is what rule 3's
  `notFor` bans, and the current page ships three save buttons, two of them blue.
- The `sh-ext-answer` status `<output>` at the bottom of the page goes away: its
  content now lands in the footer of the card that caused it. `.sh-ext-label` has
  no CSS rule anywhere (grep it — nothing matches), which is why those labels
  currently render at inherited body size and outweigh everything around them.
- **Stored** list at the bottom: one `SectionLabel count={n}` reading "Stored",
  then a `Row` per stored hook — path in `--sh-font-mono`, `meta` giving
  "1 line" / "set", `actions` holding `clear`. Rows keep `Row`'s own height,
  hover wash and inverse-video selection; do not restyle them. Clicking still
  loads the hook into the matching card above (one editor, as today).

## Interactions & behaviour

Unchanged: Esc closes (capture-phase); `onClose` asks main and never assumes;
values re-read on every `onChanged` push; search filters pages via `filterPages`;
selection falls back to the first match when the query no longer contains it;
writes go one per keystroke for text and are skipped for unparseable numbers.

New:
- `retry` on a degraded choices row re-invokes `spec.choicesFrom` for that key
  only. Still no automatic retry loop.
- The raw-error disclosure is local component state, closed on mount.
- Nav group headers are static labels, not collapsible.

Motion: nothing new. Existing `--sh-motion` (140ms, near-linear) on background
and border-color only; no entrance animation on rows in settings.

## State

No new app state. Component-local additions only: `detailsOpen` per degraded row
in `settings-rows.tsx`, and in the hook editor the card that most recently
received input (to decide which save button is `primary`).

## Design tokens

Every value above by name. Hex is the dark-mode resolution, for reading the mock
only — **write the role, not the hex.**

| Role / metric | Dark value | Used for |
| --- | --- | --- |
| `--sh-canvas` / `--sh-surface-sunken` | `#14120E` | script wells, field backgrounds |
| `--sh-surface` | `#1B1915` | the settings layer, the nav |
| `--sh-surface-raised` | `#24211B` | group cards, selected stored row |
| `--sh-line` | `#343027` | every hairline, card borders |
| `--sh-text` | `#E9E2D2` | labels, page title, selected-row fill |
| `--sh-text-dim` | `#A49B89` | descriptions, quiet button ink |
| `--sh-text-faint` | `#6E6759` | micro labels, placeholders, owner |
| `--sh-accent` | `#62A3FF` | the one primary save |
| `--sh-danger` | `#E85D43` | the single "choices unavailable" dot |
| `--sh-prompt` | `#F2762E` | the `changed` dot |
| `--sh-font-size-nano` … `title` | 9 / 10 / 11 / 12 / 13 / 15 / 17 | see `metrics.ts` |
| `--sh-control-sm/md/lg` | 22 / 28 / 34 | buttons, selects, track widths |
| `--sh-space-xs…xl` | 4 / 6 / 8 / 12 / 14 | all padding and gaps |
| `--sh-radius-sm/md` | 4 / 6 | wells and fields / cards and buttons |
| `--sh-row-height` | 28 | nav rows, header bands, stored rows |
| `--sh-line-height` | 20 | all prose |
| `--sh-hairline` | 1 | never scaled |

Fonts: `--sh-font-sans` (DM Sans) for what the app says, `--sh-font-mono`
(JetBrains Mono) for what the machine produced — paths, env vars, scripts, ids,
error strings — `--sh-font-serif` for the one page sentence.

## Assets

None. Icons are `@tabler/icons-react`, already a dependency: `IconArrowLeft`
(bar), `IconRotate` (reset). The mock substitutes `←` and `↺` text glyphs because
it cannot import Tabler; use the real icons at `size="sm"` (12px, one stroke
weight, per `icon.tsx`).

## Invariants you must not break

- No hex literal outside `packages/design-tokens/src/palette.ts` (rule 10).
- No shadows. The luminance step from `surface` to `surfaceRaised` is the
  elevation (rule 2).
- Exactly one rule in `row.css` may declare a height — a named test walks the
  loaded stylesheet and fails on a second one. Do not restyle `Row`'s box from
  `settings.css`; scope any addition to its label/meta.
- `ch` is banned for layout; `px` metrics come from the derived scale only.
- One `variant="primary"` per surface.
- Tier-3 component tokens live beside the component that owns them; a value two
  components share is a role or a metric one tier up.

## Verify

```sh
pnpm -r test        # settings-screen.test.tsx and settings-rows.test.tsx must stay green
pnpm -r typecheck
pnpm lint           # the import boundaries
pnpm dev            # then ⌘, and walk all three pages
```

The existing tests pin the behaviour this redesign keeps: nav item text, owner on
the page not the nav, `settings.set` calls, Esc/back asking main, search
filtering, one `invoke` per `choicesFrom` key with `{ key }` args. If a test needs
changing, that is a signal — the only legitimate edits are to selectors the
redesign renames (`.sh-settings__owner` and friends), never to an assertion about
what happens.

## Files in this bundle

- `Settings.dc.html` — the design reference. 1a is today, 1b is the target.
- `support.js` — runtime for the HTML file; not part of the implementation.
