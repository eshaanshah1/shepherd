---
name: shepherd-ui
description: Use when writing or reviewing any Shepherd v2 renderer UI — packages/ui primitives, packages/design-tokens, the app shell (titlebar, rail, tab strip, panes), the composer, the command palette, or any contributed view that draws rows in the rail. The normative design language: tokens, state marks, primitive rules, shell structure, and what the language refuses. Supersedes Flock.
---

# Shepherd UI — the design language

> Read this before touching any renderer file. It is short on purpose: every rule
> here exists because breaking it produced something we threw away. The visual
> half lives in `references/primitives.dc.html`; the assembled screens live in
> `references/redesign.dc.html`. When this file and a screen disagree, the screen
> is wrong.

Supersedes **Flock** (`docs/superpowers/specs/2026-08-06-ade-design-language.md`).
What Flock got right and this keeps: tokens are the API, themes are a
contribution, hairlines carry hierarchy, no elevation theater, one fixed row
height. What it got wrong and this drops: warm ink, mono-everywhere, inverse
video, uppercase micro-labels with tracking, five saturated accents with five
jobs, and a status word beside every status dot.

## References

| file | what it is | when to open it |
|---|---|---|
| `references/handoff-spec.md` | per-screen specs with exact values — titlebar, rail, sky strip, task cards, tab strip, pane heads, composer, palette, empty state | before recreating any screen |
| `references/primitives.dc.html` | every control at real size in every state, each specimen captioned with its spec | **source of truth for any value the spec does not state** |
| `references/redesign.dc.html` | the assembled screens: main window, ⌘T composer mid-mention, ⌘K palette, empty state, state legend, light-theme sketch | to see how the pieces sit together |
| `references/today-before.dc.html` | the pre-redesign UI, recreated from source | before/after comparison only |
| `references/implementation-order.md` | the staged rollout: tokens → marks → primitives → shell → composer → sky strip | when planning the work |

The `.dc.html` files are **design references, not code to copy**. They are
single-file HTML with inline styles because that is what the design tool
produces. Recreate them in v2's environment: React 19 in
`packages/app/src/renderer`, primitives in `packages/ui` (one `.tsx` + one `.css`
per component, `cn()` for class composition), tokens generated from
`packages/design-tokens`. No Tailwind, no component library, no second styling
mechanism.

Two things are deliberately **not** final and need a design pass before shipping:
the **light theme** (a derived sketch exists at the foot of `redesign.dc.html`)
and the **settings surface**. Do not invent them — say when you reach a point
where one is needed.

---

## 1. The premise

**A glance must be enough.** The app hosts other people's programs; its own
chrome should recede and let you read the one thing that changed. So state is
carried by a *mark* — a shape, in a fixed slot — and never by a word sitting
next to that mark. The word exists, as the mark's tooltip and its accessible
name, and that is where it stays.

**Colour is a decision, not a finish.** Most of the screen is one neutral ramp on
true black. A hue appears only where it settles something: what is live, what
passed, what a diff did, what failed, and which tree a pane is in. Nothing is
coloured to look nice. When you are tempted to add a hue, you are usually
missing a luminance step.

**Nothing repeats itself down the hierarchy.** A task is named once, in the rail.
A tab is named by what you opened it for. A pane is named by the tree it is in.
The titlebar says the app's name and nothing else.

---

## 2. Tokens

Tier 1 is the ramp and the hues. Tier 2 is the roles, and **roles are the public
vocabulary** — a component asks for `surface`, never for `#121212`. Emit both;
migrate call sites one at a time. An extension that uses roles is themed for
free, and a hardcoded hex is a review flag.

### Neutrals — true neutral, no cast

| role | dark | job |
|---|---|---|
| `sunken` | `#070708` | behind everything; a field's well |
| `canvas` | `#0A0A0A` | the window, the rail, the stage |
| `pane` | `#0D0D0D` | the grid's own ground |
| `surface` | `#0F0F0F` | a resting card |
| `well` | `#121212` | the composer, a modal |
| `raised` | `#161616` | a selected card, a menu |
| `fill` | `#1B1B1B` | an active row, a hover fill |
| `line` | `#1C1C1C` | every seam |
| `lineStrong` | `#272727` | a well's edge, a bordered control |

### Ink

| role | dark | job | not for |
|---|---|---|---|
| `text` | `#EDEDED` | a title, a live value | a border |
| `textDim` | `#A8A8A8` | a control at rest | a disabled control |
| `textFaint` | `#8C8C8C` | a section label, a secondary row | anything you must read to act |
| `textMute` | `#5A5A5A` | a path, a timestamp | prose |
| `textGhost` | `#3A3A3A` | a separator glyph | text |

### The five that mean something

| role | dark | means | not for |
|---|---|---|---|
| `sky` | `#7FB6E8` | live · focus · send | a status that is not "right now" |
| `grass` | `#86C06A` | passed · done · git added | a confirm button |
| `wool` | `#EDEDED` | waiting on you · the one action | decoration; it is also `text` |
| `clay` | `#C4796B` | git removed | failure |
| `red` | `#E05C4F` | a run that failed | a back-out path |

Repo identity is a sixth axis with its own fixed marks — `#7FB6E8` sky,
`#8C9AA8` stone, `#CFCBBE` wool, `#6E7B8C` slate. **Grass is not in that set**;
a repo tinted green would read as something that passed.

### Type

Two faces, split by job. `Geist` for what the app says; `JetBrains Mono` for what
the machine produced — a path, an id, a command, a number, the grid. Anything
measurable is `tabular-nums`.

| size | weight | job |
|---|---|---|
| 19 | 600, `-0.022em` | a panel's name, once per panel |
| 16 | 400, `-0.005em` | the brief |
| 14 | 600, `-0.01em` | a card title |
| 13 | 400 | a row, a menu item |
| 12.5 | 500 | a control's label |
| 11.5 | 600 | a section label — **sentence case, no tracking** |
| mono 11 | 400 | a measurement, tabular |
| mono 10.5 | 400 | a path, an id |

### Geometry

Radius `5` chip · `6` control · `8` row · `10` card · `12` window · `14`/`16`
well · `50%` the send button, which is the only round thing in the app.

Space `2 4 6 7 9 10 12 14 16 20`. Heights: row `34` · control `24`/`28`/`34` ·
tab `28` · pane head `38` · tab strip `40` · titlebar `44` · rail `332` · sky
strip `124`.

A chrome band draws its seam as `box-shadow: inset` rather than `border-bottom`,
because with `border-box` a 1px border eats a pixel of the content box and
everything flex-centred in the band lands half a pixel off the traffic lights.
A **box** — a card, a chip, a field — uses a real border; it has four edges and
nothing to line up with.

### Motion

140ms linear, on colour only. Nothing translates, scales, springs or bounces: a
control that moves under the cursor is a control whose target moved mid-click.
The working meter is `steps(1, end)` at 1.1s, so it repaints twice a second
rather than every frame — continuously repainting indicators peg the GPU when
twelve panes are open. Everything is gated on `prefers-reduced-motion`, and a
reduced-motion meter is *complete and static*, not frozen mid-cycle.

---

## 3. The state mark

One component. A fixed 12×12 slot; the mark inside never resizes the slot.

| state | mark | spec |
|---|---|---|
| working | three bars | 2×8, gap 1.5, `sky`; third bar `steps(1,end)` 1.1s |
| waiting on you | solid square | 8×8, `wool` — **and the row opens** (§5) |
| resting | hollow ring | 7×7, 1px `#4A4A4A` |
| failed | solid square | 8×8, `red` |
| shipped | check | 12px, `textMute` — and it leaves the list |
| suites | n cells | 4×8, gap 1.5, `grass` when green, `#2A2A2A` pending |

A **square** always means *your move*. A **ring** means nothing is happening. A
**meter** means something is. Every mark carries its word as a tooltip and as its
accessible name — two states will eventually share a hue, and a fact encoded only
in colour cannot be read out, searched or asserted on.

---

## 4. Primitives

Fifteen, and a sixteenth is a conversation. Each is drawn in every state in
`references/primitives.dc.html`; that file is the spec, this is the index.

`Button` (primary / secondary / ghost / danger × sm 24 / md 28 / lg 34) ·
`IconButton` · `SendButton` · `Field` · `Well` · `Pill` · `Chip` · `Select` ·
`StateMark` · `SuiteMeter` · `Row` · `SectionHeader` · `TaskCard` · `Tab` ·
`PaneHead` · `Menu` · `Tooltip` · `Modal` · `Palette` · `Empty` · `KeyHint`.

Rules that hold across all of them:

- **One primary per surface**, and it is `wool` — a white fill on black. A hue is
  never a button. If two controls are loud, neither is.
- **Back-out paths carry nothing.** Cancel, Dismiss, Close and Discard are ghost:
  no colour, no border, no key hint. They are not destructive.
- **Disabled is 36% opacity on the live colour**, never a dimmer colour — a
  dimmer colour makes a disabled primary and a resting secondary the same shade.
- **Focus is a 2px `sky` outline at 2px offset**, on `:focus-visible` only, drawn
  as `outline` so a focused control is the same size as an unfocused one.
- **A control matches the row height around it.**
- **A field is invalid with a red edge *and* a sentence.** Never colour alone.
- **A coarse pointer gets a 44px hit target** from an invisible `::after`, not
  from a second component and not by growing the drawn control.
- Feedback is matched to duration: under 100ms nothing, to 1s disabled only, to
  3s disabled + spinner, beyond that a stage label. Bind `disabled` immediately
  and defer the *visible* loading state ~200ms, so a local action shows nothing
  and a slow one still answers.

---

## 5. The shell

```
window
├─ titlebar 44          lights · "Shepherd" · search ⌘K · settings
├─ rail 332
│  ├─ sky strip 124     the meadow, the flock, and the panel's name
│  └─ sections          Waiting on you · In flight · Resting · Shipped (count)
└─ stage
   ├─ tab strip 40      the selected TASK's tabs · + · split controls
   └─ pane group        one tab's panes, 12px gutters
```

**A task holds tabs; a tab holds panes.** That is the hierarchy, and it is why
nothing repeats a name: the rail names the task, a tab is named for what you
opened it for, a pane head says which tree it is in.

**Attention routing is the rail's shape, not a colour.** Sections are ordered by
what you must do, and a task waiting on you is the only element allowed to change
size: it opens into a card carrying the question and its two answers inline, so
answering costs no navigation. Everything else is a fixed-height row or a
fixed-shape card. Finished work leaves the list and becomes a count at the foot.

**The sky strip is the one decorative surface in the app** — a dim gradient, a few
1px stars, two hills, and a 3px-pixel sheep grazing at its right-hand end, with
the panel's name overlaid at its foot. It is a window, not a wallpaper: an earlier
version spread the scene behind the whole app and it was distracting. Keep it to
the strip. The sheep is the mascot the state marks abstract, and it is the only
illustration in the product.

**The composer is a well, not a form.** One tall writing surface with room to
write; the controls live *inside* it along the bottom as ghost text divided by
1px×16 rules; the repo picker fuses into the well rather than floating over it;
one weighted affordance — a `sky` send circle. Below it, detached by 7px, a rail
saying where the task will land. No inner hairlines above the controls: inside a
well, space is the structure.

**Extensibility is the row grammar.** A contributed surface (GitHub pull requests,
diagnostics) gets a `SectionHeader` and `Row`s in the rail, or a tab in the
stage. It supplies data and a *token name* — never a colour, never a height. It
cannot make its row taller, louder, or a hue the palette does not have. A
contributed view that hardcodes a colour is a visible bug once a user swaps
themes, which is a better enforcement mechanism than a lint rule.

---

## 6. What this language refuses

- A status word beside a status mark.
- Inverse video for selection. A fill plus a 2px edge; the label stays legible.
- Uppercase micro-labels with tracking.
- Repeating a name down the hierarchy.
- A sixth hue, or a fifth used for decoration.
- Shadows for elevation. The luminance step *is* the elevation. One exception —
  a menu floating over an already-raised surface — and it is written down.
- Continuous animation, and any motion that moves a control.
- A row that grows to reveal hover actions. They share one grid cell with the
  metadata, so the track is already as wide as the wider of them.
- Two primary buttons on one surface.
- Dimming an unfocused pane by opacity. Focus is one border step; a dimmed pane
  is one whose live output you can no longer read.
- Gradient fills, glass, backdrop blur, skeleton shimmer, emoji as iconography,
  a badge pill on every count, marketing spacing inside the app.

---

## 7. Working on this

Icons are Tabler, one stroke weight (1.7–1.8), sized 11–17. Take a component,
never an icon *name*: a name means bundling 5,700 glyphs. A contributed view
picks from a small allow-list that grows one line at a time.

Every colour and length comes from a token. **A hex literal outside
`packages/design-tokens` is a defect.** Respect the import boundaries in
`tooling/eslint/boundaries.js`; they are the architecture.

If a value is in neither this file nor `references/handoff-spec.md`, read it off
the prototype's inline style in `references/primitives.dc.html`. If it is in
neither, ask rather than inventing one.

Before opening a PR, check the reverse states — if you added a way in, add the
way out and the way to see it. And check the four you always forget: empty,
loading, failed, and one item.
