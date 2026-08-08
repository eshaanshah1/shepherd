# The Shepherd design system — `@shepherd/ui`

Status: **proposed, awaiting approval.** Nothing below is built.
Companions: [Flock, the design language](2026-08-06-ade-design-language.md) ·
[UI reference notes](2026-08-08-ui-reference-notes.md) (Superset / Synara / Orca,
and T3 Code's §4 when it lands).

## Why

Every UI defect this project has shipped has one cause: **there is no vocabulary
to be consistent with.** A button is styled where it is written, a chip is
invented at its call site, `.sh-icon-button` reached the screen with no CSS at
all. Each fix is local, so the next screenshot finds a new inconsistency, and
the review loop is the user pointing at a picture.

The reference study named the same gap from the other side: a role layer above
the tokens is what makes "an extension can theme" mean something other than "an
extension writes our internals". Today an extension styling anything must reach
for `--sh-ink-raised`. That is a private name, and it is already a public API by
accident.

So: a real primitive set, in a package extensions import, over a token layer
whose public half is roles rather than internals.

## The decisions already made

- **shadcn/ui, vendored** — copied into our tree and restyled, not depended on
  (their own model). Radix under the hood, so focus management, dismissal,
  portalling and keyboard semantics are not ours to reinvent; the styling is
  100% ours, from tokens.
- **`packages/ui`, public** — extensions import `@shepherd/ui`. A third party's
  view looks native and re-themes for free, or the substrate claim is marketing.
- **Spec, approve, build** — this document is that gate.

## 1. What shadcn brings, and what we throw away

shadcn is not a dependency; it is a folder of files you own. What we keep is the
**behavior** (Radix primitives) and the **variant plumbing** (`cva` + a `cn`
helper). What we discard on the way in:

| shadcn ships | We do instead | Why |
|---|---|---|
| Tailwind utility strings | Plain CSS with `--sh-*` custom properties | Flock's metrics are frozen integer px; Tailwind's scale is a second, disagreeing one. Extensions would need our Tailwind config to write a matching class. |
| `--radius`-driven rounded-lg everywhere | Two radii (below) | Terminal brutalism; a uniform 8px on chrome is the thing that reads as a web app. |
| shadow/elevation utilities | Hairlines + luminance steps | Flock rule 2 bans elevation theater. The composer's single dispersed shadow is the recorded exception. |
| `dark:` class pairs per component | Tokens that already carry both modes | One source, per Flock rule 10. |
| Their neutral palette | Flock's warm ink | — |

`cva` and `clsx`/`tailwind-merge` are small and honest; we take `cva` + a
3-line `cn` (no tailwind-merge — nothing to merge without Tailwind).

## 2. The token layer, in three tiers

The reference study's item #1, adopted, with our names.

```
tier 1  palette      ink-deep, ink, ink-raised, ink-line, wool, wool-dim,
                     wool-faint, cobalt, hay, pasture, ember, signal
                     — PRIVATE. Nothing outside packages/design-tokens names these.

tier 2  roles        canvas, surface, surfaceSunken, surfaceRaised, terminal,
                     line, text, textDim, textFaint, textSelected, accent,
                     accentText, attention, success, danger, prompt,
                     fillHover, fillSelected, focusRing
                     — PUBLIC. This is what an extension writes: var(--sh-surface).

                     Nineteen, not the fifteen this section first listed. The
                     four additions were found by walking the shipped CSS rather
                     than reasoned: `surfaceSunken` (a recessed field is not the
                     window backdrop, even where they share a value today),
                     `terminal` (the one surface whose colour the app does not
                     own, and the thing `contrast.ts` measures), `prompt`
                     (`signal` was the one palette accent with a declared job and
                     no role, which guarantees a call site stays on tier 1
                     forever), and `textSelected`.

                     A role is one of three KINDS, and this matters more than the
                     list: `token` paints from the palette, `alias` emits
                     `var(--sh-other-role)`, `wash` emits a `color-mix` over
                     another role. Aliases and washes emit REFERENCES rather than
                     resolved values — which is what makes the scoped
                     re-declaration below work at all, since re-declaring
                     `--sh-text` on a subtree then moves the hover fill and the
                     selection ink with it, for free.

                     CORRECTION to this section's first draft: `fillSelected` is
                     NOT a wash. Flock rule 4 is inverse video for selection —
                     a solid block of `text` with `surface`-coloured ink — and
                     making it a 10% wash would put hover and selection one
                     luminance step apart instead of one glance. Hover is the
                     wash; selection is solid. Pinned by a named test.

tier 3  component    --sh-button-bg, --sh-row-height …
                     — PRIVATE to a primitive, declared in its own file.
```

**Scoped re-declaration, never parallel families** (reference item #2, and it
retires a mistake I have already made). A surface that needs a different fill
re-declares the *generic role* on its own subtree:

```css
/* right */                          /* wrong — what pane chrome does today */
[data-surface='terminal'] {          --sh-pane-title-fg-on-dark: …;
  --sh-surface: var(--sh-ink-term);  --sh-pane-title-fg-on-light: …;
  --sh-text: …;
}
```

An unmodified `<Button>` dropped inside then adopts that palette with zero
knowledge of where it is. The existing `--sh-pane-title-*-on-{dark,light}`
family is converted as part of this work.

Light/dark stay adjacent in one block (item #3). A theme swap is custom
properties on the root plus a `.sh-no-transitions` class during the swap, never
a re-render (item #5).

## 3. The primitives

Twelve, chosen by walking every surface the shell and `tasks` currently draw.
Each lists variants × sizes × states; anything not listed is deliberately absent.

### Controls

**`Button`** — the one action element.
- variants: `primary` (filled cobalt — the single loud thing on a surface),
  `default` (bordered, ink-raised fill on hover), `ghost` (no border until
  hover), `danger` (ember border, ember text; filled only on hover).
- sizes: `sm` 22px, `md` 28px, `lg` 34px. Radius 6px (`sm` 4px).
- states: hover, active, `disabled` (40% opacity, no pointer), `busy` (a
  braille spinner replaces the label, width pinned so nothing reflows).
- Every size carries an invisible `::after` growing the hit target to 44px on
  coarse pointers, per T3 Code — one Button, not a touch fork.

**`IconButton`** — square Button, icon only, `aria-label` required (a lint rule
enforces it). Sizes 22/28. This is the `+` in the sidebar header, and it exists
because that control reached the screen unstyled.

**`KeyCap`** — `⌘T`. Display only, never a button: v1's cheatsheet lesson and
the reason the sidebar footer legend was removed.

### Input surfaces

Flock's split, made structural: **instruments get borders, writing surfaces get
space.**

**`Field`** — a single-line input. variants: `bordered` (settings, filters) and
`bare` (inside a `Composer`, no border/background of its own). Sizes sm/md.
Invalid state is an ember border plus a message slot, never a colour alone.

**`TextArea`** — same two variants. `autoGrow` between a min and max in `lh`
units, not px (Synara's trick: "two lines" is a real height, `72px` is a guess
that breaks when the type scale moves).

**`Composer`** — the *container* the writing-surface rules live in: one well,
16px radius, no inner hairlines, generous padding, and it re-declares the roles
so `bare` fields inside it need no props. The task composer becomes an instance;
the future command palette is the second.

### Structure

**`Row`** — the fixed-height list row, and the piece with the most rules
attached (reference items #2, #3, #4):
- 28px, never changes height for any state (Flock rule 9).
- A leading **slot of fixed size** (12×12) — dot, spinner, glyph, eventually the
  sheep. The contents change; the box never does.
- Hover is a wash of `text` at 6%, not a palette entry, so an extension's theme
  override tracks it. Selection stays inverse video (Flock rule 4).
- The trailing area is a **1-cell CSS grid**: hover actions land on top of
  resting metadata instead of reflowing the row.
- Exported as both a component and its class constants, so an extension's own
  markup can look native (Synara's `sidebarRowStyles.ts`, item #5).

**`SectionLabel`** — 10px uppercase micro-label with tracking, optional count
and trailing rule. Flock rule 5 survived the reference comparison: both
references went sentence-case and are duller for it.

**`Card`** — a bordered surface with a header slot. What a docked contributed
view sits in.

**`Modal`** — Radix Dialog: scrim, focus trap, Esc, click-out, portal. Sizes
`md` 460 / `lg` 620. Draws no header of its own (the composer proved a title bar
over a form asking one question is a label for nothing).

**`Tooltip`** — Radix, 400ms open delay, no arrow. Where the status word went.

**`StatusDot`** — the 12×12 slot's default occupant. Takes a *role* (`working`,
`attention`, `success`, `danger`, `idle`), never a colour, and carries a native
`title` plus `sr-only` text because two states will eventually share a hue
(Orca's pairing).

Deliberately **not** in v1 of this package: Select, Menu, Tabs, Toast, Popover,
Table. Each arrives with its first real consumer; a primitive with no caller is
a design nobody has tested.

## 4. The inspector

Reference item #4, and the item I want most, for a reason specific to how this
codebase is built: **I am the one writing UI against a system I cannot see.**
Every wrong colour so far was a guess about which token paints a surface.

A dev-only overlay (⌘⇧I, dev builds): click any element, get the role names
actually painting its background, border and foreground — measured by writing a
probe colour into each candidate custom property and diffing the computed style,
not by reading a map. One file, ~120 lines, no dependency. It is also the
honest answer to "which token do I use here" for any extension author.

## 5. Migration — what changes, and what proves it

Ordered so the app is working after every step.

1. `packages/ui` scaffolded; `cva` + `cn`; boundaries rule permitting
   `@shepherd/ui` from `app/src/renderer/**` and `extensions/*/ui/**` only.
2. Role tier in `design-tokens`, emitted alongside the existing vars. Nothing
   breaks: the palette vars keep working while call sites move.
3. Primitives built with unit tests (variants render, disabled is inert,
   `IconButton` demands a label, `Row` height is invariant across states).
4. **The shell ports onto them**: titlebar, sidebar rows, section labels, the
   `+`, the empty state, the modal, the composer. Every `.sh-*` rule that a
   primitive now owns is deleted — the measure of success is that
   `styles.css` gets *smaller*.
5. `tasks`' composer ports (it already imports the SDK; `@shepherd/ui` joins it).
6. Pane chrome's `-on-dark`/`-on-light` families convert to scoped
   re-declaration.
7. The inspector.
8. `docs` gets a short "writing a view" page pointing at the primitives — the
   Orca-style written guide, which for us beats T3's config-over-prose posture
   *until* there is a primitive set to point at. Then `components.json`-style
   config becomes the spec, and the guide shrinks.

**Gates, per step:** typecheck, lint, every suite, all eight smokes, and a
screenshot of the real app compared against the previous one. The smokes select
on `data-testid`, which no primitive may change.

## 6. What this costs

A day of agent time, roughly, and a real risk worth naming: a primitive set
built ahead of its consumers grows members nobody needs. The mitigation is the
"deliberately not in v1" list above — twelve components, each with at least one
call site on the day it lands, and the rule that a thirteenth arrives with its
consumer rather than before it.

## 7. Answered (2026-08-08)

1. **The scale is derived from day one; no settings UI yet.** `metrics.ts` stops
   being constants and becomes one base size and one density factor with
   everything else a ratio of them, exactly as Synara does it — including the
   `lh` trick, so a composer's minimum height is "two lines" rather than a px
   guess that breaks the moment the base moves. Nothing exposes it to the user
   until there is a settings surface to put it in, but the plumbing costs
   nothing while the primitives are being written and costs a rewrite of every
   one of them afterwards. **The terminal's own size stays separate** — it is
   the user's `~/.config/shepherd` font-size, and chrome that resized because
   somebody likes 16pt code is the rule-1 amendment's whole point.

2. **Separate components, shared roles.** The phone client gets its own
   component set; what crosses is the ROLE vocabulary (`surface`, `text`,
   `accent`, `attention`…) and the meanings behind it. A touch surface has
   different hit targets, different navigation and no hover, so a shared
   component set would be a set of components with a `platform` prop threaded
   through every one — which is the trade T3 Code says cannot be undone cheaply.
   Deciding it now costs nothing: it means `packages/ui` may assume a pointer,
   and the roles live in `design-tokens` where both surfaces can reach them.

3. **Tabler, bundled now.** As an `Icon` primitive over a tree-shaken subset —
   one stroke weight, sized from the type scale, `currentColor` only, never a
   raw `<svg>` at a call site. Flock already named Tabler; the reason to do it
   with the primitives rather than after is that half of them (`IconButton`,
   `Row`'s leading slot, `Field`'s invalid state, `Button`'s busy spinner) have
   an icon-shaped hole in them, and a hole filled later is filled twelve
   different ways.
