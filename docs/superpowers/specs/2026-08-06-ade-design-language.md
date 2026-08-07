# Flock — the Shepherd v2 design language

Status: draft v3, 2026-08-06. Companion to
[`2026-08-06-ade-v2-core-design.md`](2026-08-06-ade-v2-core-design.md).
(Renamed from "Phosphor" when the glow was cut; *flock* = many colors moving
together under one discipline, which is also the extension-theming story.)

References calibrating the taste: **Teenage Engineering** (playful character
inside strict industrial design), **sacred.computer / srcl** (terminal
brutalism: the cell grid, inverse-video, box-drawing), **Flexoki** (warm ink
neutrals), **iA** (mono + serif). The premise: an ADE's design language comes
from the terminal and the instrument panel, not the web.

## The rules

1. **The character cell is the grid.** All chrome spacing, row heights, and
   rhythm derive from the terminal font's cell (`ch`, line-height multiples).
   Web-default 4px scales are not used; chrome and grid read as one surface.
2. **Warm ink, never dead gray — and never purple.** Dark surfaces are warm
   charcoal with an umber cast; light mode is warm paper. Hierarchy from
   luminance steps + 1px hairlines: no shadows, no blur, no elevation
   theater, no glow.
3. **Polychrome, functional.** There is **no house color**. Instead a small
   fixed set of saturated accents, TE-style, each *assigned a job*:
   `cobalt` (working / links / primary action), `hay` (blocked, attention),
   `pasture` (done, success), `ember` (error, urgent, the dev build),
   `signal` (orange — prompts, live cursor affordances). Excitement comes
   from confident *flat* use of several colors — solid chips, filled blocks,
   colored dots — never from gradients, glow, or decoration. If it's
   saturated, it means something; most pixels stay ink and wool.
4. **Inverse video is the emphasis.** Selection, the focused row, the active
   scope: a solid filled block with ink-colored text (sacred.computer's
   move), not a tinted wash. One glance separates "selected" from "hovered"
   forever.
5. **Industrial labeling.** TE's instrument voice: uppercase micro-labels
   with tracking (`WORKING · 3`), boxed keycaps (`[⌘T]`), spec-plate details
   in corners (version, branch, counts), box-drawing dividers where they
   earn their place. Controls are flat, bordered, honest — a button looks
   like a key, not a pill.
6. **Mono is the voice, serif is the prose.** A characterful mono (Berkeley
   Mono class, licensed and bundled) for everything structural; a warm serif
   only where the app speaks in sentences — onboarding, markdown, empty
   states. Sans appears nowhere.
7. **Motion is textual.** ScrambleText, typewriter reveals, braille-spinner
   working indicators (`⠋⠙⠹…`), block-cursor blink, inverse-flash on
   completion. No spinners-as-rings, no spring/bounce, no shimmer, no
   breathing/pulse. 120–180ms, near-linear. Respects
   `prefers-reduced-motion`.
8. **The flock is the status system.** Each task's state indicator is a
   minimal **sheep** (the mascot is a sheep — a shepherd herds sheep; v1's
   goat retires): **standing** = idle, **walking** = working, **grazing** =
   done / waiting for you, **butting the fence** = blocked, **tipped on its
   back** = error. Drawn as a smooth minimal silhouette/line mark — **not
   pixel art** (the mock's 8-bit sprites are placeholders) — animated
   fluidly but calmly (SVG shape/limb interpolation, not frame-flips), in
   the state's accent color so the color-meaning system survives at a
   squint. Plain dots remain the micro fallback (status bar, collapsed
   pips). Static under `prefers-reduced-motion`.
9. **Personality lives in moments; working surfaces stay calm.** Beyond the
   flock: empty states, errors, onboarding beats, the task-complete moment —
   dry serif microcopy ("Nothing grazing here yet."), never mascot-spam.
   Fixed-height rows; attention changes a sheep's activity, never a row's
   size. Density is respect.
10. **Tokens are the API — and theming is first-class for extensions, both
   directions.** `packages/design-tokens` is the single source (named
   palette, neutrals, type scale, cell spacing, motion durations), generated
   into: chrome CSS variables, the xterm.js theme object, and the variables
   injected into every extension view/webview — an extension that uses
   tokens is themed for free, and hard-coded colors are a marketplace-review
   flag. In the other direction, **a theme is itself an extension
   contribution** (`contributes.themes`: a token-override set, live-swappable
   — ⌘⇧R's contract survives), restyling chrome, terminal, and every
   well-behaved extension at once. Dark is canonical; light/warm are derived
   overrides shipped in-box the same way.

## Anti-tells (banned)

Gradient fills/text; glow and shadow elevation; glassmorphism/backdrop blur;
rounded-2xl card stacks; any single dominant brand hue (incl. the
purple-to-blue family); emoji as iconography (Tabler line icons, one stroke
weight); skeleton shimmer; badge pills on every count; marketing spacing
inside the app; default-Inter-everywhere; saturated color without a job.

## Token values (approved via the 2026-08-06 mock — the normative set)

Live reference: [`2026-08-06-flock-mock.html`](2026-08-06-flock-mock.html)
(sheep sprites in it are placeholders, per rule 8; the colors are approved).

| token | dark (canonical) | light (derived) | job |
|---|---|---|---|
| `ink-deep` | `#14120E` | `#E6DFD0` | window backdrop |
| `ink` | `#1B1915` | `#F3EEE1` | surfaces |
| `ink-raised` | `#24211B` | `#FAF6EA` | hover / raised |
| `ink-line` | `#343027` | `#D3CAB6` | hairlines |
| `ink-term` | `#161410` | `#FAF6EA` | terminal background |
| `wool` | `#E9E2D2` | `#2B2620` | primary text; inverse-video fill |
| `wool-dim` | `#A49B89` | `#6E6759` | secondary text |
| `wool-faint` | `#6E6759` | `#A49B89` | tertiary / idle |
| `cobalt` | `#62A3FF` | `#1F62D0` | working / links / primary action |
| `hay` | `#E0A33E` | `#96690E` | blocked / attention |
| `pasture` | `#85BB64` | `#47772C` | done / success |
| `ember` | `#E85D43` | `#C23A22` | error / urgent / dev build |
| `signal` | `#F2762E` | `#C85312` | prompts / live affordances |

Cell metrics (mock-approved): mono 13px / line-height 20px; row height 28px
(2 cells); micro-labels 10px with `.1em`–`.16em` tracking. Motion: sheep
cycle ~500ms; cursor blink 1.1s steps; scramble tick 70ms.

Font: **JetBrains Mono is the bundled placeholder** (already in v1's
resources) with a recorded TODO to license Berkeley Mono (or equivalent
characterful mono) before 1.0. Serif: system stack (Iowan Old Style /
Palatino / Georgia) until a bundled face is chosen.

## Carried v1 assets

The sheep (v2 rebrand: v1's goat hands over; indigo daily / rouge dev identity
discipline carries); the state meanings behind the accent jobs; T3-Code row discipline; Tabler
icons; the `⌘/` two-column HUD form; dimmed-inactive panes (opacity, never
border rings); ScrambleText.
