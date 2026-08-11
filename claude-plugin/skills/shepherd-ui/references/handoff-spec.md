# Handoff: Shepherd UI overhaul

## Overview

A complete redesign of the Shepherd v2 shell — titlebar, task rail, tab strip,
pane chrome, the ⌘T composer, the ⌘K palette, the empty state and the primitive
set they are built from. The goal was stated by the product owner as: *"super
intuitive, does not need to scream things out by text — just a glance is enough
for the user to understand things"*, and *"easily extensible"* for surfaces that
do not exist yet (GitHub sync was named).

The redesign replaces the previous **Flock** language (warm ink, monospace
everywhere, inverse-video selection, uppercase tracked micro-labels, five
saturated accents, a status word beside every status dot) with a near-monotone
true-neutral language on true black, in which:

- state is carried by a **mark** in a fixed slot, never by a word beside it;
- **colour is reserved** — five hues, each with one job, plus a repo-identity set;
- the hierarchy is **task → tabs → panes**, and no name repeats down it;
- the one element allowed to change size is a task that is **waiting on you**,
  which opens into a card with its question and both answers inline.

## About the design files

The files in this bundle are **design references created in HTML** — prototypes
showing intended look and behaviour. They are **not production code to copy**.

The task is to **recreate these designs inside `shepherd/v2`'s existing
environment**: React 19 in `packages/app/src/renderer`, primitives in
`packages/ui` (plain CSS files per component, `cn()` for class composition,
Radix/Base-UI-style wrappers), tokens generated from `packages/design-tokens`.
Use those established patterns. Do not introduce Tailwind, a component library,
or a second styling mechanism.

The prototypes are authored as single-file HTML with inline styles because that
is what the design tool produces. Every value in them is intentional and is
documented in `shepherd-ui-skill.md`, which is the normative document — read it
first.

## Fidelity

**High fidelity.** Colours, type sizes, weights, letter-spacing, heights, insets,
radii and motion are final and are listed exactly in `shepherd-ui-skill.md` §2
and drawn at real size in `Shepherd Primitives.dc.html`. Recreate the UI to those
values. Where a value is not in the skill doc, read it off the prototype's inline
style rather than inventing one.

Two things are deliberately *not* final and need a design pass before shipping:
- the **light theme** (a derived sketch exists at the foot of `Shepherd Redesign.dc.html`);
- the **settings surface**, which does not exist in the product yet.

## Files in this bundle

| file | what it is |
|---|---|
| `shepherd-ui-skill.md` | **the normative design language.** Tokens, primitive rules, shell structure, refusals. Read first. |
| `Shepherd Primitives.dc.html` | every control at real size in every state, each specimen captioned with its exact spec |
| `Shepherd Redesign.dc.html` | the assembled screens: main window, ⌘T composer mid-mention, ⌘K palette, empty state, state legend, light-theme sketch |
| `Shepherd Today.dc.html` | the **pre-redesign** UI, recreated pixel-for-pixel from the current source, for before/after comparison |
| `PROMPT.md` | a ready-to-paste prompt for Claude Code |

Open the `.dc.html` files in a browser directly; they need no build step (they do
load Geist and JetBrains Mono from Google Fonts, so they want a network
connection).

## Screens

### 1. Main window

**Purpose:** run several agents at once and know, at a glance, which one needs you.

**Layout:** a `1400×860` window, `border-radius: 12`, `1px #1C1C1C` border, on
`#0A0A0A`. A column of: titlebar `44`, then a row of rail `332` and stage.

**Titlebar (44px, `#0A0A0A`)**
- Traffic lights at `left: 20`, `gap: 8`, `11px` circles.
- `Shepherd` — Geist 13.5 / 600 / `-0.01em` / `#EDEDED`. Nothing else on the left;
  the breadcrumb it used to carry was a restatement of the rail.
- Right: a search affordance — `h28`, `r7`, `background #111111`, `#5A5A5A`,
  12.5px, magnifier at 13px/1.7 stroke, `⌘K` in mono 11 `#3A3A3A`. Then a settings
  `IconButton` (28 square, `r7`, glyph 15).
- `-webkit-app-region: drag`; every control inside it needs `no-drag`.

**Rail (332px, `#0A0A0A`, `border-right: 1px #161616`)**

*Sky strip — `height: 124`, `overflow: hidden`.* The one decorative surface in the
app.
- `linear-gradient(180deg, #101C29 0%, #0D141C 46%, #0A0A0A 100%)`
- over it, `radial-gradient(120% 90% at 74% 92%, rgb(127 182 232 / 13%), transparent 62%)`
- 8 stars: 1–2px squares, `#EDEDED` at 22–55% alpha, scattered in the top 55px
- three hills, `border-radius: 100% 100% 0 0 / Npx Npx`:
  `left:-40 w:280 h:66 r:62 #111E18` · `right:-60 w:300 h:62 r:56 #0F1A14` ·
  `left:-10 w:400 h:44 r:34 #121D16`
- one sheep at `right: 96, bottom: 48`, a 27×21 box of 3px pixels: three fluff
  squares along the top at x 6/12/18, a 21×9 body at (3,3), a 6×6 head at (0,6)
  in `#A8A499`, a 3×3 eye at (0,9) in `#0A0A0A`, two 3×6 legs at x 9 and 18,
  y 12, in `#8A8679`. Body and fluff are `#D8D4C8`.
- the panel header sits absolutely at the strip's foot, `padding: 0 14px 12px`:
  `Work` (19/600/`-0.022em`/`#EDEDED`), a mono-11 count `#5A5A5A`, spacer, and a
  primary `New` button (`h28`, `r7`, `#EDEDED` on `#0A0A0A` ink, 12.5/600, plus
  icon 13 at 2.2 stroke).

*Sections* — `padding: 0 12px 12px`, `gap: 7`. Each header: label 11.5/600, a
`1px #1C1C1C` rule filling the remaining width, a mono-10.5 tabular count.
Order is fixed: **Waiting on you** (label `#EDEDED`) → **In flight** (`#8C8C8C`)
→ **Resting** (`#8C8C8C`) → a **Shipped this week** footer row pinned to the
bottom with `margin-top: auto`.

*Task cards* — `r10`, `padding: 12px 13px`, `gap: 9`:
- resting: `#0F0F0F` / `1px #1C1C1C`, title 14/500 `#C4C4C4`
- selected + in flight: `#161616` / `1px #333333`, title 14/600 `#EDEDED`
- waiting on you: `#121313` / `1px #414243`, a `wool` 8×8 square mark, the
  question at 13/`#A8A8A8` with the identifier in mono 12 `#DCDCDC`, then
  `Allow` (primary, `h27`, `r7`, key hint `Y` at 50% opacity) and `Deny`
  (secondary, `1px #303030`)
- failed: the resting surface, a `red` square mark, the exit code in mono
  `#C4796B`, `Retry` (secondary) and `Open log` (ghost)

Card content lines, in order: mark + title + elapsed (mono 10.5 tabular) → one
sentence of what is happening → the diff line → repo chips. The **diff line is
numbers, not a bar**: `+142` in `grass`, `−38` in `clay`, a `#3A3A3A` middot, a
file count in `textMute`, then the suite meter pushed right.

*Resting rows* — `h34`, `gap: 11`, `padding: 0 9px`, `r8`. Mark slot 12 fixed,
label 13, trailing metadata mono 10.5. Hover fill `#141414`; the hover actions
share **one grid cell** with the metadata (`grid-template-areas: 'stack'`), hidden
by `visibility`, revealed on `:hover` and `:focus-within`.

**Stage**

*Tab strip — `h40`, `padding: 0 10px`, `border-bottom: 1px #141414`.* These are the
selected **task's** tabs. Each tab `h28`, `r7`, `gap: 9`, 12.5px: active
`#1A1A1A`/`#EDEDED`/500 with a close glyph (12px, 2 stroke, `#5A5A5A`); hover
`#141414`; rest transparent `#8C8C8C`. Each carries a state mark — a sky meter for
a tab with a live agent, a suite meter for a test tab, a ring for an idle one.
Then a `+` IconButton, a spacer, and split-right / split-down IconButtons.

*Pane group — `padding: 12px`, `gap: 12`.* Panes are `r10`, `#0D0D0D`. The focused
pane has `1px #2A2A2A`; the others `1px #1A1A1A`. **Unfocused panes are not
dimmed** — focus is one border step, because a dimmed pane is one whose live
output you can no longer read.

*Pane head — `h38`, `padding: 0 14px`, `gap: 10`, `border-bottom: 1px #1C1C1C`.*
State mark, then the pane's **repo** (13/600, with a 7×7 `r2` identity square),
then the worktree/branch in mono 10.5 `#5A5A5A`, spacer, the diff numbers, and a
`⋯` IconButton. It never carries the task's name.

*Terminal body — `padding: 13px 16px`*, JetBrains Mono 12.5 / 21. Grid colours:
text `#C4C4C4`, dim `#5A5A5A`, added `#86C06A`, removed `#C4796B`, a tool marker
`▌` in `#EDEDED`, block cursor `#EDEDED` on the pane ground.

### 2. ⌘T composer

Scrim `rgb(6 6 6 / 76%)`. The card is `620` wide, pinned `44px` from the top —
**near the top, never vertically centred**, so it grows downward as the brief
grows.

- Well: `#121212`, `1px #272727`, `r16`.
- Brief: `padding: 20px 20px 0`, `min-height: 96`, 16/26, `-0.005em`. Placeholder
  `what needs doing?` in `#5A5A5A`. A repo mention becomes an inline `Pill`
  (`h25`, `r7`, `#1E1E1E`, label 15/500, folder glyph 13 in `sky`); the live
  mention text is `sky` with a 1.5px caret.
- Control row inside the well: `padding: 14px 14px 14px 16px`. Ghost `Select`s —
  model, then worktree — at `h28`, `r7`, 12.5px `#A8A8A8`, chevron 11 at 2.2
  stroke `#5A5A5A`, separated by a `1px × 16` `#282828` rule. **No bordered
  chips**; inside a well a bordered box is the loudest thing on it.
- Send: a `34` circle, `#7FB6E8`, arrow 17 at 2.4 stroke in `#08131C`. The only
  round element in the product and the only weighted control on the card.
- Repo picker: fused into the well under a `1px #1F1F1F` top border, `#0F0F0F`,
  `padding: 6`. Rows `h34`, `r8`, `gap: 11`; active `#1B1B1B`; folder glyph 14
  (`sky` on the active row, `#4A4A4A` otherwise, outline-only for a non-repo);
  name 13.5 with the matched run in `sky`; path right-aligned mono 10.5.
- Scope rail: **detached**, `margin-top: 7`, full width, `h34`, `r10`, `#0D0D0D`,
  `1px #1F1F1F` — repo identity squares + names on the left, and where the
  worktrees will be cut on the right in mono 10.5.

### 3. ⌘K palette

Same scrim and the same `620`/`r14` card at `#141414` / `1px #2A2A2A`, with a
`0 30px 70px rgb(0 0 0 / 70%)` shadow. A `h50` query row (magnifier 15, 16px
text, sky caret) over a `1px #1F1F1F`, then `padding: 7` of grouped rows: an
uppercase-free group label at 10.5/600 `#4A4A4A` (`letter-spacing: 0.05em`,
`text-transform: uppercase` is the one place uppercase survives, on a 10.5px
group label inside an overlay), rows `h36`/`r8`/`gap: 12`, active `#1C1C1C`, icon
14, label 13.5, shortcut mono 11 right. Groups: **Layout**, then **Jump to**,
whose rows carry state marks rather than icons.

### 4. Empty state

Centred: a 180×56 meadow (one hill at `#121D16`, one sheep in `#3A3A38` /
`#2E2E2C` / `#262625`), `The flock is quiet.` at 17/500 `#8C8C8C`, a 13.5px
`#4A4A4A` sub-line, and a primary `New task` button with a `⌘T` hint. The sheep
is the only illustration in the app.

## Interactions & behaviour

- **Clicking a task row/card** switches the stage to that task's tabs and panes.
  Selection is *derived from* which root the window is showing — do not keep a
  second copy of "what is selected" in the rail.
- **Waiting on you**: `Allow` / `Deny` answer the agent's prompt in place; `Y` and
  `N` are bound while that card is the top of the rail. Answering collapses the
  card back to a row.
- **Tabs**: click to switch, `+` creates one in the current task, close glyph on
  the active tab only, split buttons act on the focused pane. A tab's mark
  reflects the state of whatever is running inside it.
- **⌘K** opens the palette (capture phase on `window`, not a menu accelerator —
  xterm has focus and a menu key equivalent could not be closed by the bar it
  opened). **⌘T** opens the composer. **Esc** closes the topmost layer only; with
  the repo picker open, Esc closes the picker and not the composer.
- **Composer**: `⏎` starts, `⇧⏎` newlines, `#` opens the repo picker at the caret,
  `↑↓` move the active row, `⏎`/`⇥` insert the pill, backspacing over a pill
  removes that repo from scope (scope is *derived from the text*, never a second
  array).
- **Transitions**: 140ms linear on `color`, `background`, `border-color` only —
  never `all`. No transforms.
- **The working meter** is `steps(1, end)` at 1.1s on `opacity` (1 → 0.18 → 1) on
  the third bar only.
- **Reduced motion**: the meter renders complete and static; a frozen partial ring
  reads as broken, a complete one reads as an intentional marker.

## State needed

Nothing new beyond what v2 already models. The design reads:
`LayoutSnapshots` (roots, focused pane, sessions), the agent indicator per
session, and the contributed `TreeItem`s. Two additions the design assumes and
the current model does not carry:

1. **A tab level** between root and pane group, with a user-settable name. The
   product owner confirmed this already exists in his latest build; match its
   naming.
2. **Per-task diff stats** (`+added`, `−removed`, `files`) and **suite results**
   (n total, n passed) surfaced on the task record, so a card can draw them
   without asking git on every render.

Everything else — elapsed time, repo list, lifecycle, the blocking question — is
already on `TaskRecord` or derivable from the agent state.

## Design tokens

All of them, with their jobs and their "not for", are in `shepherd-ui-skill.md`
§2. Add them to `packages/design-tokens/src/palette.ts` and `roles.ts` as a new
theme rather than editing Flock's values in place, so the two can be compared in
the running app. `metrics.ts` needs new integers for `row 34`, `paneHead 38`,
`tabStrip 40`, `tab 28`, and the radius set `5 6 8 10 12 14 16`.

## Assets

- **Fonts:** Geist (chrome) and JetBrains Mono (machine output) — both OFL, both
  bundleable. JetBrains Mono is already vendored in v2; Geist replaces DM Sans.
- **Icons:** Tabler, one stroke weight (1.7–1.8), sized 11–17. Already a
  dependency. Take a component, never an icon name.
- **The sheep:** drawn in the markup as 3px `<span>` pixels, no image file. If it
  ships as an asset instead, keep it pixel-exact at 1× and integer-scaled above.
- No other imagery. There are no photographs, gradients-as-decoration or
  illustrations anywhere in this design.
