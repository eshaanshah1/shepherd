# UI reference notes — Superset, Synara, Orca

Date: 2026-08-08. Research only; **we learn from these, we copy none of them.**

Three shipped Electron agent-development apps, read from source on disk. All
three are React 19 + Tailwind v4 + a shadcn-descended primitive set, so the
interesting differences are not "which framework" but **how each one gets
separation without shadows, how dense its rows are, what it derives vs.
hardcodes, and where each one put its writing surface.**

Line references are to the clone as read on 2026-08-08. Paths are relative to
each repo root.

---

## 1. Superset (`superset-sh/superset`, `apps/desktop` v1.19.0)

### Stack

- **Electron 41 + electron-vite 4**, React 19.2, TanStack Router (file routes,
  `tsr generate`), Zustand 5 + TanStack DB/Query, tRPC over `trpc-electron`.
- **Terminal:** `@xterm/xterm` 6.1 beta + webgl/ligatures/search/image/progress
  addons. **Editor:** CodeMirror 6. **Rich text:** TipTap 3 (the chat composer).
- **Styling:** Tailwind v4 via `@tailwindcss/vite`, `tw-animate-css`, shadcn
  primitives vendored into `packages/ui/src/components/ui`, `clsx` +
  `tailwind-merge`, CVA. Icons: **`react-icons`** (Heroicons `Hi*` in the
  sidebar) *and* `lucide-react` — two icon libraries, see anti-patterns.
- **Motion:** `framer-motion` 12 plus a lot of hand-written CSS keyframes.
- Formatting is Biome with **tabs**; monorepo is Bun + Turbo.

### Tokens and theme

`apps/desktop/src/renderer/globals.css:17-61` is the dark fallback, in **plain
hex, not oklch** — the fallback set is deliberately literal so the app looks
right before the JS theme store hydrates (comment at `:9-16`).

| token | dark value | job |
|---|---|---|
| `--background` | `#151110` | window canvas (warm, red-cast black) |
| `--tertiary` | `#1a1716` | panel backgrounds |
| `--tertiary-active` | `#252220` | panel active |
| `--sidebar` | `#1a1716` | sidebar surface |
| `--card` / `--popover` | `#201E1C` | lifted panels, floating menus |
| `--secondary` / `--muted` / `--accent` / `--border` / `--input` | `#2a2827` | **all the same value** |
| `--ring` | `#3a3837` | focus |
| `--foreground` | `#eae8e6` | text |
| `--muted-foreground` | `#a8a5a3` | secondary text |
| `--highlight` / `--sidebar-primary` | `#e07850` | brand accent (ember orange) |
| `--destructive` | `#cc4444` on `#ffcccc` | |

**Five surface levels** (`#151110` → `#1a1716` → `#201E1C` → `#252220` →
`#2a2827`), each roughly 4–6 luminance points apart, with `--border` sitting at
the *top* of that ramp. Separation is **luminance-step first, hairline second**;
there is no shadow anywhere in the token set except the shadcn `Dialog`.

The genuinely reusable idea is at `globals.css:58-60`:

```css
--fill-hover:    color-mix(in oklab, var(--foreground)  7%, transparent);
--fill-selected: color-mix(in oklab, var(--foreground) 10%, transparent);
```

Row hover/selection are **low-opacity foreground washes, not palette colors**,
so they track any theme for free. Light mode drops them to 4% / 6%
(`globals.css:103-104`) because a light surface needs less. Note *why* this
exists: `--accent` and `--border` are the same hex, so a row filled with
`bg-accent` would erase its own edge.

- **Radius:** `--radius: 0.625rem` (10px); `sm = r-4px`, `md = r-2px`,
  `lg = r`, `xl = r+4px` (`globals.css:134-137`). Sidebar rows use `rounded-md`
  (8px); dialogs `rounded-lg` (10px); the chat input overrides to a literal
  **13px** (below).
- **Type:** no custom scale. Tailwind defaults plus literal bracket sizes:
  `text-[13px]` for sidebar rows and section headers, `text-[11px]` for status
  text, `text-[10px]` `font-mono tabular-nums` for keyboard-shortcut hints.
- **Fonts:** terminal font comes from `--superset-terminal-font-family`
  (`globals.css:200`); the chrome uses the Tailwind default sans (no bundled
  face).

### The theme object is one object for chrome + terminal + editor

`apps/desktop/src/shared/themes/built-in/ember.ts:7-111` defines a single
`Theme` with three sub-objects: `ui` (the 30-odd CSS variables above),
`terminal` (xterm's 16 ANSI colors + background/foreground/cursor/
cursorAccent/selectionBackground), and `editor.syntax`. Built-ins are
`ember.ts` / `light.ts` / `monokai.ts`, and `themes/import.ts` exists so users
can bring their own. `themes/utils.ts:1-57` is a thin culori wrapper —
`toHex`/`toHex8`/`toHexAuto`/`withAlpha`/`stripHash` — because xterm wants
`#RRGGBBAA` strings while CSS wants anything.

The ember terminal palette is *tuned to the chrome*: `black: #151110` is the
window background, `cursor: #e07850` is the brand accent,
`selectionBackground: rgba(224,120,80,0.25)`.

### Layout shell and sidebar

- Sidebar section header
  (`.../DashboardSidebar/components/DashboardSidebarSection/components/DashboardSidebarSectionHeader/DashboardSidebarSectionHeader.tsx:59-63`):
  `mx-2 min-h-7 rounded-md pl-2 pr-2 py-1 text-[13px] font-medium
  text-muted-foreground hover:bg-fill-hover`. **28px, sentence case, not
  uppercase**, with a 12px chevron that rotates 90° on expand
  (`transition-transform duration-150`).
- Workspace row
  (`.../DashboardSidebarWorkspaceItem/components/DashboardSidebarExpandedWorkspaceRow/DashboardSidebarExpandedWorkspaceRow.tsx:134-143`):
  outer `mx-2 rounded-md text-left text-sm transition-colors`, selection and
  active both `bg-fill-selected`, hover `bg-fill-hover`. Inner
  (`:164-168`) `flex w-full items-center py-1.5 pr-2` with `pl-8` when nested
  in a section, `pl-3` when top-level — **8px of indent per nesting level,
  expressed as padding on one row, not a nested container.**
- Label (`:289-292`): `truncate text-[13px] leading-tight`, and the resting
  color is **`text-foreground/80`**, going to full `text-foreground` only when
  active/selected. Two-step text emphasis instead of a second fill.
- **The trailing slot is a 1-cell CSS grid** (`:300`):
  `grid h-5 shrink-0 items-center justify-items-end [&>*]:col-start-1
  [&>*]:row-start-1`. Diff stats, creation status, and the hover action cluster
  all stack in the same cell, so revealing hover actions **cannot** reflow the
  row. Hover actions themselves are `hidden … group-hover:flex
  group-focus-within:flex`, and the shortcut hint inside is
  `font-mono text-[10px] tabular-nums text-muted-foreground`.
- Icon slots are a fixed `size-5` box (`:190`) whatever they contain (PR icon,
  check mark, spinner).

### Composer and dialogs

- Chat input
  (`components/Chat/ChatInterface/components/ChatInputFooter/ChatInputFooter.tsx:188`):
  `rounded-[13px]`, **`border-[0.5px]`**, `shadow-none`, `bg-foreground/[0.02]`.
  A hairline thinner than 1px, a bespoke radius, no shadow, and a 2% foreground
  wash for the well.
- The composer container (`:160`) paints a **gradient dissolve above itself**:
  `before:absolute before:left-0 before:right-3 before:-top-8 before:h-8
  before:bg-gradient-to-t before:from-background before:to-transparent` — the
  transcript fades out into the composer over 32px instead of hitting a divider.
- Error banner inside the composer (`:166`): `rounded-md border
  border-destructive/20 bg-destructive/10 px-4 py-2 text-sm text-destructive` —
  **tint + tinted border, colored text, no fill.**
- Dialog (`packages/ui/src/components/ui/dialog.tsx:41-43, 63-65`): overlay is
  flat `bg-black/50` with fade only; content is `rounded-lg border p-6 gap-4
  shadow-lg`, `sm:max-w-lg`, entering with `zoom-in-95 + fade-in` over 200ms.
  Footer is `flex-col-reverse … sm:flex-row sm:justify-end` (mobile stacks with
  the primary on top).

### Distinctive touches

- **`chat-history-rail.css` (`packages/ui/src/components/ChatHistorySidebar/`)
  — the best single artifact in the three repos.** A collapsed history list
  rendered as 26×2px tick marks (`:39-46`) that grow toward the hovered one in
  a macOS-Dock falloff, implemented entirely with sibling selectors
  (`:has(+ .row:hover)` at 0.7, one further out 0.4, one further 0.2 —
  `:81-115`), on a custom `linear(…)` overshoot easing over 160ms. Plus a
  **scroll-driven mask** (`:13-37`): registered `@property` lengths animated by
  `animation-timeline: scroll(self y)` so the list's top/bottom fade tracks
  scroll position with zero JS.
- Retro `pill-pixel-out` keyframe (`globals.css:322-347`): the update pill
  dissolves via a `repeating-conic-gradient` mask that coarsens in discrete
  steps 3px → 5px → 8px → 12px. Character in a moment, not on a working
  surface.
- Update pill also draws its countdown as `stroke-dashoffset` tracing its own
  border (`globals.css:309-316`).
- `KeypadLoader.css` — the workspace-initializing state is a 3D isometric
  keypad whose keys depress in sequence, masked from PNGs, bobbing on a 2.2s
  loop, with the purple source art hue-rotated 118° into brand orange
  (`:89-92`). Fully `prefers-reduced-motion`-gated (`:141-147`).
- `::highlight()` (CSS Custom Highlight API) for search matches in chat and
  markdown (`globals.css:280-296`) rather than DOM `<mark>` injection.
- Scrollbars are themed globally at 12px with a 3px transparent border and
  `background-clip: padding-box` to fake an inset gutter
  (`globals.css:232-258`), with a `.scrollbar-thin` 8px variant.

### Anti-patterns

- **Two live copies of the whole workspace UI.**
  `screens/main/components/WorkspaceView/…/CommentPane/comment-pane.css` and
  `routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/CommentPane/comment-pane.css`
  are byte-identical (md5 `34affe79…`), as are ChatInputFooter and friends. 908
  `.tsx` files in the renderer, a meaningful fraction of them duplicated across
  a v1/v2 route migration that never finished.
- Two icon libraries (`react-icons` + `lucide-react`) and two chat packages
  (`@superset/chat`, `@superset/chat-legacy`).
- `--border`, `--input`, `--muted`, `--secondary` and `--accent` are all
  `#2a2827`: the token names promise five roles and deliver one, which is
  exactly why `--fill-hover` had to be invented later.
- `html, body { user-select: none }` globally (`globals.css:174`) — every text
  selection then has to be re-enabled per component (`select-text` appears on
  the error banner at `:166`).

---

## 2. Synara (`apps/web` 0.7.0 renderer, `apps/desktop` Electron shell)

### Stack

- **Electron 40**, but the shell is a ~30-line package: all UI lives in
  `apps/web` and is loaded by the desktop main process. Runtime is distinguished
  in CSS by `:root[data-runtime="electron"]`.
- React 19 + **React Compiler** (`babel-plugin-react-compiler`), TanStack
  Router/Query, Zustand, **Effect** for the service layer.
- **Base UI (`@base-ui/react`), not Radix** — plus `shadcn` CLI-generated
  wrappers, CVA, `tailwind-merge`.
- Editor: **Lexical**. Terminal: `@xterm/xterm` 6 + webgl. Virtualization:
  `@legendapp/list` + `@tanstack/react-virtual`. Icons: **`@tabler/icons-react`**
  (same family Shepherd v1 uses) + `react-icons`.
- Fonts bundled: `@fontsource-variable/jetbrains-mono` (**the same face Flock
  picked**), plus "Cal Sans" as a display/wordmark face.
- Tests run in a real browser (`vitest-browser-react` + Playwright) — there are
  `*.browser.tsx` test files asserting on computed styles.

### Tokens: a theme is four numbers, everything else is derived

This is the most sophisticated theming system of the three. `index.css:396-544`
holds the *fallback* tokens, but the live values are computed in
`src/theme/theme.logic.ts` (1402 lines) from four inputs — **surface, ink,
accent, contrast** — and written to `:root` as `--color-*` variables
(`theme.logic.ts:860-935`).

The derivation is literally alpha arithmetic on `ink`, with a user-facing
**contrast slider** folded into every border
(`theme.logic.ts:1088-1091` light, `:1134-1137` dark):

```ts
// light                                   // dark
border:      rgba(ink, 0.09 + c * 0.04)    rgba(ink, 0.10 + c * 0.04)
borderHeavy: rgba(ink, 0.09 + c * 0.06)    rgba(ink, 0.16 + c * 0.06)
borderLight: rgba(ink, 0.07 + c * 0.02)    rgba(ink, 0.06 + c * 0.02)
elevatedSecondary: rgba(ink, 0.04)         rgba(ink, 0.02 + c * 0.02)
```

Three border weights (`light` / default / `heavy`), and the app is explicit
about which goes where. Static fallbacks: `--background: #fcfcfc` light,
`#0e0e0e` dark; `--border: black/5%` light, `white/4%` dark; `--card` in dark is
`color-mix(in srgb, var(--background) 99%, white)` — a **1% lift**, i.e. the
card is not a different surface, it is the same surface plus a hairline.

Status colors are a separate axis (`index.css:462-472`, dark at `:518-526`):
`--status-success` (emerald-500), `--status-failure` (red-500),
`--status-open`, `--status-merged` (indigo-500), `--status-neutral`
(zinc-500) — and in dark **every one is mixed 72% toward white**, with the
comment explaining why: the plain role color reads as "a heavy block" against a
near-black surface. `--claude: #d97757` is its own token.

The comment at `index.css:442-447` is worth stealing verbatim as a rule:
`--destructive-foreground` etc. are **on-fill contrast ink**, only ever legal on
top of a solid `bg-destructive`; for text on a tint you use the role token and
let the tint carry the signal.

### Density and type are user-scalable, from one place

- `src/lib/appDensity.ts:6-71`: three modes — `compact` 0.85 / `comfortable` 1
  / `spacious` 1.15 — scaling **one** base set into CSS vars. Base row height
  **1.75rem = 28px** (compact 23.8px, spacious 32.2px), row padding-y 0.125rem,
  row gap 0.5rem, chat gutter 0.75rem (1.25rem at `sm:`), composer editor
  padding 0.75/0.5/0.75rem, composer min height `calc(2lh * scale)` — **two
  lines, expressed in `lh`.**
- `src/lib/appTypography.ts:26-43` + `hooks/useAppTypography.ts:23-58`: one
  user font size (default **12px**, clamped 11–18,
  `appSettings.ts:53-55`) fans out into 13 named sizes by ratio:
  `uiLg ×1.08`, `uiSm ×0.92`, `uiXs ×0.84`, `ui2Xs ×0.76`, `uiMeta ×0.84`,
  `uiTimestamp ×0.72`, `chatCode ×0.95`, `chatMeta ×0.72`, `chatTiny ×0.66`,
  each rounded and floored (timestamps never below 8px). Terminal font size is
  a **separate** setting.
- Radius scale is multiplicative off `--radius: 0.625rem` (10px):
  `sm ×0.6`, `md ×0.8`, `lg ×1`, `xl ×1.4`, `2xl ×1.8`, `3xl ×2.2`,
  `4xl ×2.6` (`index.css:54-60`) — so 6 / 8 / 10 / 14 / 18 / 22 / 26px.

### Sidebar

`src/sidebarRowStyles.ts` is a single file of exported class-name constants —
every sidebar row in the app composes from it, so drift is structurally
impossible.

- Height `min-h-[var(--app-density-row-height,1.75rem)]` **and** `h-[…]` —
  fixed, not min (`:7-8`). Radius `rounded-md`. Padding `px-2 py-[…]`.
- Text `text-[length:var(--app-font-size-ui,12px)] font-normal` (`:16`).
- Resting label is `text-foreground/95`, generic idle text `text-foreground/89`
  (`:27,35`) — a 6% difference doing real work.
- **Section labels: `text-muted-foreground/58` at the same 12px, `font-normal`,
  sentence case** (`:38-39`). No uppercase, no tracking, no size drop.
- Hover `bg-[var(--sidebar-accent)]` (= `--secondary` = ink at 4%); active the
  same fill via `--sidebar-accent-active` **plus** a text-color change. Focus is
  `focus-visible:ring-1 ring-inset ring-ring` — **inset**, so it can't overflow
  a 28px row (`:18-25`).
- Nested thread rows: `pl-8 text-[13px]`, list gap `gap-0.5` (2px), offset
  `pt-0.5` (`:53-64`).
- `sidebarHoverRevealHideClassName()` (`:87-98`) is the one rule for
  "hover actions replace the resting glyph": the resting element gets
  `group-hover/<row>:opacity-0` **and** `group-hover/<row>:pointer-events-none`,
  with a documented trap — if the hidden element runs its own opacity animation
  (`animate-pulse`), the animation wins and you must wrap it instead.
- Sidebar width `16rem` = 256px (`components/ui/sidebar.tsx:26`).

### Separation: the "seam" system

`index.css:77-89` and `:125-215` are a small essay on dividers, and the taxonomy
is directly transferable:

- **`--app-surface-divider`** = `color-mix(in srgb, var(--color-border) 60%,
  transparent)` — one token for *every internal* divider: chat/dock/diff header
  hairlines and all right-side pane splits. Deliberately more transparent than
  card/input borders.
- **`--seam-line`** — the *outer* sidebar↔content edge, deliberately **not**
  unified with the above ("the route's outer edge against the sidebar should
  read as solid"): `black/12%` light, `white/8%` dark.
- The seam is drawn as `box-shadow: inset 0.6px 0 0 var(--seam-line)` on a
  `::before` (`:179-181`) — **an inset stroke, not a border**, so it adds no
  layout width and paints no top/bottom edge.
- Depth is `box-shadow: var(--seam-shadow-x) 0 12px -10px` with
  `--seam-shadow-x: -6.5px` and a **negative spread** so the shadow hugs the
  seam instead of fanning (`:149-163`); `rgba(0,0,0,0.1)` light,
  `rgba(0,0,0,0.36)` dark.
- Horizontal header hairlines are painted as a **1px background gradient**
  (`.chat-surface-divider`, `:203-215`) rather than a border or a positioned
  pseudo-element, with the reason recorded: a border would paint across the
  seam edge, and an absolute element would make the header a containing block
  and break its portals.
- Hovering the resize rail intensifies the seam via
  `:has([data-placement="content-seam"]:hover)` (`:183-185`) — the rail is
  *only* a hit area and never draws its own line.
- Collapse animates the shadow **color to transparent**, never `box-shadow:
  none`, because Chromium snaps to/from `none` (`:190-196`).

### Composer — the one place Synara goes soft

`src/components/chat/composerPickerStyles.ts` + `index.css:2445-2560`:

- **Radius 1.2rem ≈ 19px** (`--composer-radius`, `index.css:2461-2470`), applied
  to the shell, the surface, the stacked rail, and the banner from **one**
  variable so HMR can't leave a stale value.
- **Squircle corners:** `-electron-corner-smoothing: system-ui` under Electron
  (`:2478-2484`), `corner-shape: squircle` in browsers that support it
  (`:2486-2494`).
- Fill: `--composer-surface` = `color-mix(in oklab,
  var(--color-background-control) 90%, transparent)` light + backdrop blur;
  **opaque** in dark (the control fill), because translucency over a dark
  transcript reads as dirt.
- **One real border, not a ring**, and the reason is recorded
  (`composerPickerStyles.ts:140-143`): *"a real border follows squircle/
  corner-shape geometry more evenly than an outer ring (box-shadow)."* Color is
  `color-mix(in srgb, var(--color-border-heavy) 95%, var(--foreground) 5%)` —
  the heaviest border token nudged toward ink.
- Shadow: `0 4px 18px -6px color-mix(in srgb, var(--foreground) 7%, transparent)`
  light, `0 6px 24px -10px rgba(0,0,0,0.30)` dark (`:11-12`) — soft, dispersed,
  large negative spread.
- Column: `max-w-[46rem]` centered (`:66,107`), gutters from the density tokens.
- **The composer is a stack, not a box.** `ChatView.tsx:11104-11200` renders,
  above the input and inside one `ComposerColumnFrame`: a live-changes header
  (files/+/−), an active task-list card, a workflow-run card, a subagent strip,
  and a queued-turns header. Each takes `attachedToPrevious`; when true it drops
  its top radius (`index.css:2544-2547`) and the panel above drops its bottom
  border, so **N panels fuse into one continuous surface with 1px dividers.**
  The stacked rail sits at `w-11/12 mx-auto -mb-px` (`composerPickerStyles.ts:120`)
  — inset, so it reads as a rail behind the full-width input — and is filled at
  50% of the composer surface color (`index.css:2549-2554`).
- Pending approvals and AskUserQuestion prompts are deliberately **detached**
  cards floating above with `pb-2`, *not* fused — a decision recorded inline at
  `ChatView.tsx:11177-11181`.
- Picker menus get their own density tokens per size (`--normal` /
  `--small`, `index.css:2628-2657`): option min-height 1.625rem / 1.5rem, icon
  1.125rem / 0.75rem, fixed widths 13rem / 10rem.
- Floating menus are frosted: `bg-popover/70` + a `before:` pseudo carrying
  `backdrop-blur-2xl backdrop-saturate-150` at `-z-1`
  (`composerPickerStyles.ts:151-155`) — blur on a pseudo-element so it can't
  create a containing block for the content. **Except** the slash-command menu
  and the Environment panel, which are `bg-popover` opaque because they overlay
  the transcript (`:194-201`).

### Distinctive touches

- **CSS-only running indicator** (`index.css:225-245`): the terminal
  running dot pulses opacity 0.24→0.92 and scale 0.7→1 over 640ms, with the
  reason stated — *"so many open terminals don't schedule JS timers."*
- **A fixed-size status slot.** `SidebarStatusTrailingGlyph.tsx:19-36` returns
  either a 7px accent dot (unread completion), a `size-3` spinner (pulse
  states), or a `size-1.5` colored dot — always in the same trailing slot. The
  state→color map (`Sidebar.logic.ts:613-690`) is: Pending Approval amber,
  Awaiting Input indigo, Working sky (pulse), Connecting sky (pulse), Plan Ready
  violet, Completed emerald — **and dark mode uses the 300-weight at 80–90%
  opacity**, never the same 500.
- **macOS segmented control, hand-built** (`index.css:2562-2614`): recessed
  track = hairline border + `inset 0 1px 2px rgba(0,0,0,0.06)`; raised thumb =
  three stacked background layers so a translucent fill renders opaque, plus
  `inset 0 0 0 0.5px rgba(255,255,255,0.35)` and `inset 0 1px 0
  rgba(255,255,255,0.5)` for the rim highlight.
- Motion is uniformly short and opacity-first: `chat-pane-enter` 140ms opacity
  only ("avoid vertical motion because the empty landing can re-render in
  place", `:247-262`), `sidebar-surface-enter` 160ms with 4px rise,
  `chat-message-send-enter` 180ms with 3px rise + `scale(0.992)`. Every one has
  a `prefers-reduced-motion` companion. Sidebar/panel slides use
  `cubic-bezier(0.32, 0.72, 0, 1)` at 300ms.
- `body { letter-spacing: normal }` with the reason recorded (`:546-555`): let
  SF Pro use its own optical metrics rather than a "squeezed web-style negative
  tracking, so text reads native rather than designed."
- Theme switching sets `.no-transitions` on the root to zero every duration
  during the swap (`:322-329`).

### Anti-patterns

- `index.css` is **2872 lines** and `ChatView.tsx` is **>11,600 lines**. The
  token discipline is excellent; the file discipline is not.
- Deep token indirection: `--sidebar-accent` → `--secondary` →
  `--alpha(var(--color-black) / 4%)`, and separately a runtime
  `--color-background-button-secondary-hover`. Reading a computed color means
  three hops and knowing which system won.
- The seam machinery depends on `:has()` across `[data-slot="sidebar-wrapper"]`
  subtrees (`:183-201`) — correct, but it is layout-coupled CSS that will break
  silently if the wrapper markup moves.

---

## 3. Orca (`stablyai/orca` v1.4.177) — "next-gen IDE for parallel agentic development"

Closest in shape to Shepherd v2: Electron, xterm panes in tab groups, a
worktree sidebar, agent status per pane, a status bar.

### Stack

- **Electron 43 + electron-vite 5**, React 19, Zustand, i18next (fully
  localized, with catalog-coverage CI gates).
- Terminal `@xterm/xterm` 6.1 beta (+ headless & serialize in main), editor
  **Monaco**, rich text TipTap 3, `cmdk` command palette, `sonner` toasts,
  `radix-ui` primitives under a shadcn wrapper layer.
- Tailwind v4, `tw-animate-css`, CVA, `clsx` + `tailwind-merge`, **`lucide-react`
  only** (enforced by the styleguide).
- Bundled font: **Geist Variable** (one woff2, weights 100–900) + a Nerd Font
  symbols subset scoped to `unicode-range: U+E000-F8FF, …` so powerline glyphs
  resolve without shipping a full patched face (`main.css:10-25`).
- Tooling is `oxlint`/`oxfmt` with custom code-quality plugins, a
  **max-lines ratchet**, and `react-doctor`.

### `docs/STYLEGUIDE.md` — read this one

Orca is the only one of the three with a written UI doc, and it is genuinely
good. Highlights worth copying as *practice*, not as values:

- A **role table** with a "Don't use it for" column per token
  (`STYLEGUIDE.md:30-44`) — e.g. `accent` is "hover/active backgrounds for ghost
  buttons and list rows" and explicitly *not* for solid filled buttons.
- **Exactly three elevation levels** (`:99-107`): inset hairline (the default,
  "almost everything"), subtle lift (`shadow-xs` + border), floating
  (`0 10px 24px rgba(0,0,0,0.18)`, reserved for popovers escaping the editor).
  *"Don't add a fourth level. If something needs more emphasis than floating,
  you're probably reaching for the focus ring instead."*
- A **primitive-selection fork table** (`:140-155`): Tooltip vs HoverCard,
  DropdownMenu vs Popover, Popover vs Dialog, Select vs Command-in-Popover,
  toast vs inline Badge — with the failure mode named ("if you find yourself
  styling a Popover to act like a Dialog, stop").
- **Feedback matched to duration** (`:270-284`): 0–100ms none, 100ms–1s
  disabled only, 1–3s disabled + spinner, 3s+ stage labels. Two corollaries:
  pre-reserve the space a control will occupy (use `width`, not `min-width`),
  and bind `disabled` immediately but **defer the visible loading state ~200ms**
  so local users see nothing and SSH users still get feedback.
- **"Don't overload the back-out path"** (`:294-296`): Cancel/Dismiss/Close/
  Discard are *not* destructive — ghost, no color, no shortcut chip.
- **"UI copy must not overclaim"** (`:236`): reserve result verbs
  ("skipped", "verified", "deleted") for actual results; use neutral process
  language while pending.
- Shortcut chips go through one `<ShortcutKeyCombo />` primitive; the caller
  picks platform labels and *"mismatched chips are worse than no chip"*
  (`:194-211`).

### Tokens

`main.css:126-231` (light) / `:235-336` (dark), plain hex, near-neutral
(`STYLEGUIDE.md:7`: *"monochrome and quiet … the product spends most of its time
hosting other people's tools, so Orca's own UI should recede and frame"*).

| token | light | dark |
|---|---|---|
| `--background` | `#fff` | `#0a0a0a` |
| `--card` / `--popover` | `#fff` | `#171717` |
| `--sidebar` | `#fafafa` | `#171717` |
| `--worktree-sidebar` | `#f5f5f5` | `#2a2a2a` |
| `--worktree-sidebar-accent` | `#eaeaea` | `#353535` |
| `--editor-surface` | `#ffffff` | `#1e1e1e` |
| `--secondary`/`--muted` | `#f5f5f5` | `#262626` |
| `--accent` | `#f5f5f5` | `#404040` |
| `--border` / `--sidebar-border` | `#e5e5e5` | `rgb(255 255 255 / 0.07)` |
| `--input` | `#e5e5e5` | `rgb(255 255 255 / 0.15)` |
| `--muted-foreground` | `#737373` | `#a1a1a1` |
| `--destructive` | `#e40014` | `#ff6568` |

Three things here are structural, not cosmetic:

1. **`--editor-surface` is its own token**, deliberately darker than
   `--background` in dark mode to match VS Code convention
   (`STYLEGUIDE.md:46`). A hosted editor is not app chrome.
2. **The worktree sidebar has a whole parallel token family**
   (`--worktree-sidebar-*`, `main.css:180-185 / 285-292`) because it is a
   different panel with a different fill, and its rows must not inherit the
   generic sidebar's hover math.
3. **`.plugin-security-chrome` (`main.css:338-358`) re-pins every core token to
   a frozen `--orca-security-*` set.** Comment: *"plugin themes may style the
   app, but provenance and consent must retain host-owned contrast so a pack
   cannot disguise a trust decision."* An extension can theme everything except
   the surface on which you approve it.

Also: **git decoration colors mirror VS Code's palette exactly**
(`--git-decoration-added: #587c0c` light / `#81b88b` dark, etc.,
`main.css:208-214 / 315-321`) so users transferring from VS Code aren't
surprised — and the styleguide forbids reusing them for non-git state.
`--tab-group-split-divider: #868690` light / `#71717a` dark carries a stated
contrast requirement: **≥3:1 against `--card`, in the default state, not just on
hover** (`main.css:226-230`).

Radius `--radius: 0.625rem` with the same multiplicative scale as Synara.
Body: Geist, `letter-spacing: 0.01em` set globally and *"don't override per
component"* (`main.css:463`, `STYLEGUIDE.md:88`).
Type sizes (`STYLEGUIDE.md:89-93`): **11px** uppercase meta/sidebar headers
(paired with `font-weight: 600` + `letter-spacing: 0.05em`), **12px** paths and
secondary, **13px** sidebar items and dense rows, **14px** body.

### Layout shell — exact geometry

- `.app-layout` is a column flex at `100dvh` (`main.css:685-691`), with an
  `html.native-shell` override to `height: 100%` because *"native windows have a
  stable content box and need no wake-time viewport reflow."*
- **Titlebar 36px**, `background: var(--bg-titlebar, var(--card))`,
  `border-bottom: 1px solid var(--border)`, `-webkit-app-region: drag`
  (`:763-773`).
- **`.titlebar-left` is 36px but draws its divider as `box-shadow: inset 0 -1px
  0 var(--border)` instead of `border-bottom`** (`:780-802`), and the comment
  says exactly why: with border-box, a 1px border shrinks the content box to
  35px and flex-centres controls at y=17.5, half a pixel off the native traffic
  lights at y=18. **This is the single most transferable detail in the repo for
  a hairline-only design language.**
- Traffic-light gutter is `calc(80px / var(--ui-zoom-factor, 1))` (`:810-813`) —
  inverse-scaled so it stays physically correct under zoom.
- Windows/Linux custom window controls: `position: fixed` top-right, three
  46×36px buttons, `close:hover` = `#c42b1c` (`:835-869`), with a flex spacer
  of `var(--window-controls-width)` reserving their footprint in the titlebar —
  plus three separate inset rules (`:903-927`) for panels that reach the right
  edge, including `max(0px, calc(var(--window-controls-width,0px) - 40px))` for
  the case where a 40px icon strip already covers part of the overlay.
- **Status bar 24px**: `flex items-center h-6 min-h-[24px] px-3 gap-4 border-t
  border-border bg-[var(--bg-titlebar,var(--card))] text-xs select-none
  shrink-0` (`StatusBar.tsx:2202`).
- Split resize handle: **6px hit area with a 3px visible center line** drawn on
  `::after`, brightening to `--tab-group-split-divider-strong` on hover/drag,
  `transition: background 100ms` (`main.css:701-745`).
- Sidebar 240px, `transition: width 200ms ease` (`main.css:1151-1159`).
- Every Radix portal is force-`no-drag` (`main.css:755-761`) because Electron's
  OS-level drag hit-test **ignores z-index**, so a dropdown over a drag region
  is unclickable. Related: while xterm owns focus, the top chrome flips to
  `no-drag` via `:root[data-regular-terminal-input-focused]` (`:888-897`) so the
  next chrome click is observable.

### Sidebar rows and cards

Orca uses `color-mix` everywhere rather than a `--fill-hover` token, with a
comment per case explaining the ratio:

- File-explorer selected row (`main.css:1131-1149`): light =
  `color-mix(in srgb, var(--foreground) 8%, var(--accent))` **plus `box-shadow:
  inset 0 0 0 1px var(--border)`** — because flat `bg-accent` ≈ the panel
  background in light mode; dark = `color-mix(… var(--accent) 70%, transparent)`
  with no ring.
- Worktree card hover: `foreground 4%` light, `sidebar-accent 40%` dark
  (`:1164-1170`).
- **Agent row hover is `sidebar-foreground 1.25%`** (`:1202-1204`) — nested rows
  are deliberately quieter than the card they sit in, so the two hover levels
  don't compete.
- Focused agent pane: `color-mix(in srgb, var(--sidebar-foreground) 12%,
  var(--sidebar-accent))` — *"a borderless fill … without going so dark that
  muted text (timestamp) drops out"* (`:1206-1211`).
- Active worktree card: **border carries the state, background stays a wash**
  (`:1172-1200`) — `border-color: worktree-sidebar-border 40%` +
  `background: worktree-sidebar-foreground 8%` + `box-shadow: 0 1px 2px
  worktree-sidebar-foreground 4%`. There are two active levels, `primary` and
  `secondary`, distinguished by which of border / fill / ring is loudest.
- Education/notice cards (`:1223-1274`) are the one place Orca goes heavier:
  `border 24%` + `background 9%` + a double box-shadow, plus a
  45°-rotated 10px square `::before` caret aligned to `left: 1.75rem` so it
  points at the section title it explains. The status-bar version (`:1279-1298`)
  is `bg-popover` **opaque, explicitly not glass**, so terminal chrome can't
  bleed through, with the 12px caret pointing down at the meters.

### Status indicator

`components/sidebar/StatusIndicator.tsx:31-72`: **one fixed `h-3 w-3` slot**
containing either an `AgentWorkingSpinner` (`size-2`), a `MessageCircleQuestion`
amber icon for `permission`, or a `size-2` dot — emerald for `done`/`active`,
`neutral-500/40` for inactive. The slot never changes size. The status label is
also set as a native `title` (`:23-29`) *because 'active' and 'done' share the
same emerald dot*, with an `sr-only` label alongside for AT.

`AgentWorkingSpinner.tsx` carries a reduced-motion insight worth keeping:
under `motion-reduce` it **fills the transparent top border** — *"a frozen
transparent-top ring reads as a broken spinner; a complete ring reads as an
intentional static marker."* It also anchors `animation.startTime = 0` via the
Web Animations API so late-mounting spinners are phase-synced with existing
ones.

### Pane chrome (`assets/terminal.css:239-420`) — the most relevant section

Orca's terminal pane title bar solves exactly Shepherd's problem: **chrome
drawn on top of a surface whose color the user controls.**

- **24px** (`--orca-pane-title-height`), `font-family: var(--font-mono)`,
  **13px**, `padding: 0 8px`, background `var(--orca-pane-title-bg, #000)` — the
  pane's *own terminal background* — and `border-bottom: 1px solid
  var(--orca-pane-title-separator)`.
- The whole foreground set flips on a **`[data-pane-title-surface='light']`
  attribute** (`:241-260`), not on app theme:
  `on-dark` = fg `rgb(255 255 255 / .52)`, input fg `.7`, placeholder `.38`,
  input bg `.04`, separator `.06`;
  `on-light` = fg `rgb(24 24 27 / .64)`, input fg `.82`, placeholder `.48`,
  input bg `.05`, separator `.1`. Note the light-surface values are *higher*
  alphas — dark ink on light needs more weight than light ink on dark.
- The gate is measured luminance of the composed background, not app mode.
  `lib/terminal-contrast-correction.ts:11-23` applies the same logic to xterm's
  own `minimumContrastRatio`: **4.5 on light backgrounds, 3 on dark**, because
  the 4.5 floor "badly over-brightened vibrant colors" on dark themes.
- The bar is a **floating overlay** (`.pane-title-overlay-layer`, `inset: 0`,
  `z-index: 20`, `pointer-events: none`) with the bar itself re-enabling
  pointer events — and titled panes reserve matching terminal height so row 1
  stays visible.
- **`[data-chromeless]` mode** (`:369-409`): the bar goes transparent, loses its
  border, and only the action buttons remain — each getting a
  `radial-gradient` scrim `::before` (23×23px, opaque at the center, fading to
  transparent at 100%) so an icon sitting over live terminal text is still
  legible without a rectangle. That is a much better answer than a translucent
  plate.
- Drag handle: a 32px centered strip at `opacity: 0` that fades in on hover
  (150ms), filled at `color-mix(… var(--orca-pane-title-fg) 36%, transparent)`
  with a `'...'` `::after`.
- The title is an inline `<input>` styled to `font: inherit; background:
  transparent; border: none` (`:345-362`) — **rename in place, no dialog** —
  with `focus-visible: 1px solid var(--ring); outline-offset: 1px`.

### Dialogs and buttons

- Dialog (`components/ui/dialog.tsx:38,67`): overlay `bg-black/55` **+
  `backdrop-blur-[2px]`**; content `rounded-lg border border-black/14
  bg-background/96 p-6 backdrop-blur-2xl` with
  `shadow-[0_20px_60px_rgba(0,0,0,0.28), inset_0_1px_0_rgba(255,255,255,0.08)]`
  (dark: `0_24px_72px_rgba(0,0,0,0.55)`, border `white/14`, bg
  `rgba(23,23,23,0.96)`). The **inset top highlight** is what makes a
  translucent panel read as a physical sheet rather than a hole.
- Button (`components/ui/button.tsx:8,22-27`): base `rounded-md text-sm
  font-medium`, focus `focus-visible:border-ring focus-visible:ring-[3px]
  ring-ring/50` — **a 3px halo plus a border color change**, not an outline.
  Sizes h-9 / h-8 (`sm`) / h-6 (`xs`, `text-xs`, icons `size-3`) / h-10 (`lg`),
  with a documented rule to match the surrounding row height.

### Distinctive touches

- **View Transitions for the agent kanban**
  (`components/dashboard-popout/agent-board-transitions.css`): each card carries
  a unique `view-transition-name`, so a card changing column *morphs*.
  `::view-transition-group(*)` 260ms `cubic-bezier(0.2,0,0,1)`; the root
  cross-fade is set to **0s** so lane heights don't double-image; and
  enter/exit fade+`scale(0.96)` are applied only via `:only-child`, which is a
  neat trick — a card that *moved* has both an old and a new image and therefore
  isn't `:only-child`, so it morphs instead of fading. Loaded only in the
  pop-out window so the document-global pseudo rules can't leak.
- `@custom-variant can-hover (@media (hover: hover))` (`main.css:33`) so
  hover-reveal controls stay visible on touch instead of being permanently
  invisible.
- `.theme-transition-disabled *` kills transitions during a theme swap but
  **leaves animations running** so spinners don't freeze (`main.css:35-41`).
- Three named scrollbar classes with stated jobs (`STYLEGUIDE.md:224-230`):
  `.scrollbar-sleek` (default, thin), `.scrollbar-editor` (heavier, Monaco),
  `.worktree-sidebar-scrollbar` (**no reserved gutter**, so a short list stays
  flush with the fixed header). *"Don't write a fourth style."*

### Anti-patterns

- `main.css` is **3586 lines** and `StatusBar.tsx` is **2543 lines** with an
  `/* eslint-disable max-lines */` at the top. The token block is disciplined;
  everything below it is a growing pile of feature-specific classes
  (`.worktree-sidebar-notice-card--to-section-title`,
  `.mobile-emulator-tab-intro-callout--menu`, …) that will never be reused.
- Every state ratio is hand-tuned per surface (1.25% / 4% / 8% / 9% / 10% / 12%
  / 14% / 18% / 24% / 32% …), each with an excellent comment and none derived
  from a scale. The comments are the only thing keeping it coherent.
- `--sidebar-primary: #1447e6` in dark is a saturated blue that appears nowhere
  else in a self-described monochrome palette.

---

## What Shepherd should take

Fifteen concrete patterns. Each names the source and the landing site.

1. **One theme object emits chrome vars, the xterm theme, and editor syntax.**
   *Superset* (`shared/themes/built-in/ember.ts:7-111`, `themes/utils.ts`).
   Shepherd v1 has a recorded gotcha that `Theme.swift` and
   `GhosttyApp.writeBaseTheme()` must be kept in sync by hand; v2's
   `packages/design-tokens` should make that structurally impossible — one
   source, three generated outputs (CSS custom properties, the xterm.js
   `ITheme` object, the extension-injected var set). Rule 10 of Flock already
   says this; Superset shows the shape, including the culori-style
   `toHexAuto`/`withAlpha` helpers xterm needs.
   **Lands:** `packages/design-tokens`.

2. **Row hover and selection are foreground washes, never palette entries.**
   *Superset* `--fill-hover` 7% / `--fill-selected` 10% dark, 4% / 6% light
   (`globals.css:58-60,103-104`). Flock's rule 4 uses inverse video for
   *selection*, which is stronger and should stay — but **hover** still needs an
   answer, and a wash of `wool` at 6–7% over `ink` tracks every theme override
   an extension might ship, where a hardcoded `ink-raised` would not.
   **Lands:** sidebar rows, task-tree rows, command-palette rows.

3. **A fixed-size status slot that never changes size, whatever it contains.**
   *Orca* `StatusIndicator.tsx:31-72` (12×12 box, 8px dot / spinner / icon
   inside) and *Synara* `SidebarStatusTrailingGlyph.tsx:19-36`. This is exactly
   how Flock's animated sheep must be mounted: the sheep changes *activity*,
   the slot's box never changes. Also take Orca's native-`title`-plus-`sr-only`
   pairing, since two Shepherd states will inevitably share a color.
   **Lands:** sidebar rows, statusbar, collapsed pane pips.

4. **A trailing slot that is a 1-cell CSS grid, so hover actions replace
   resting metadata instead of reflowing the row.** *Superset*
   (`DashboardSidebarExpandedWorkspaceRow.tsx:300`,
   `[&>*]:col-start-1 [&>*]:row-start-1`) plus *Synara*'s single
   `sidebarHoverRevealHideClassName()` rule (`sidebarRowStyles.ts:87-98`) which
   also drops `pointer-events` on the faded element and documents the
   `animate-pulse` trap. Flock rule 9 says "fixed-height rows; attention never
   changes a row's size" — this is the mechanism.
   **Lands:** sidebar rows, task-tree rows.

5. **Every sidebar row class lives in one exported constants file.** *Synara*
   `src/sidebarRowStyles.ts` (101 lines, ~12 exports, composed by every row in
   the app). Shepherd's sidebar is an extension-contributed view; a shared
   constant module is how a third-party row can look native without copying
   Tailwind strings.
   **Lands:** `packages/ui` row primitives, exported to extensions.

6. **Derive the whole type and density scale from two user settings, and keep
   terminal size separate from chrome size.** *Synara*
   (`lib/appTypography.ts:26-43` — 13 sizes from one base by fixed ratios with
   per-size floors; `lib/appDensity.ts:6-71` — three density modes scaling one
   base set, 28px comfortable). This *is* the rule-1 amendment made operational:
   chrome follows an app scale, the terminal follows its own. Take the `lh`
   trick too — Synara's composer min-height is `calc(2lh * scale)`, i.e. "two
   lines", not a magic px.
   **Lands:** `packages/design-tokens/src/metrics.ts`, settings.

7. **Draw a chrome divider as `box-shadow: inset 0 -1px 0`, not
   `border-bottom`, on any bar whose contents must align with something
   outside it.** *Orca* `main.css:791-799`, with the measured reason: a
   border-box border shrinks a 36px bar's content box to 35px and lands
   flex-centred controls half a pixel off the native traffic lights. Flock has
   no shadows and no elevation, so **hairlines carry the entire hierarchy** —
   this is the one place a `box-shadow` is not elevation theater but the correct
   way to draw a 1px rule.
   **Lands:** titlebar, statusbar, pane header, every chrome bar.

8. **Pane chrome takes its foreground set from the terminal background's
   measured luminance, not from the app theme.** *Orca*
   (`terminal.css:241-260` `[data-pane-title-surface='light']`;
   `lib/terminal-contrast-correction.ts:11-23`, which also drops xterm's
   `minimumContrastRatio` from 4.5 to 3 on dark backgrounds). A Shepherd
   extension can ship a light terminal theme inside a dark app; without this the
   pane header goes invisible. Note the asymmetry: dark-ink-on-light wants
   *higher* alphas (.64/.82/.48) than light-ink-on-dark (.52/.70/.38).
   **Lands:** pane chrome, pane title, split dividers.

9. **A chromeless pane header where each control gets a radial-gradient scrim
   instead of a plate.** *Orca* `terminal.css:369-409` (23px circle, opaque at
   center, transparent at the edge, `border-radius: 9999px`). Shepherd wants
   maximum grid and minimum chrome; this is how you keep a close button legible
   over live scrollback without drawing a box. Pairs with rename-in-place: the
   title is a bare `<input>` with `font: inherit; background: transparent;
   border: none` (`:345-362`).
   **Lands:** pane chrome.

10. **The composer is a fusible stack, not a text box.** *Synara*
    (`ChatView.tsx:11104-11200`; `index.css:2531-2554`;
    `composerPickerStyles.ts:113-120`). Panels above the input — live diff
    stats, the active task list, queued turns, running subagents — each take an
    `attachedToPrevious` flag; when true they drop their top radius and the
    panel above drops its bottom border, so N panels read as **one surface with
    1px dividers**. Approvals and questions stay *detached* with a measured gap,
    because a decision you must make should not look like part of the thing you
    are typing. The stacked rail is inset (`w-11/12 mx-auto -mb-px`) and filled
    at 50% of the composer color.
    **Lands:** composer / new-task surface, and later the command palette.

11. **Give dividers a three-way taxonomy and one token each.** *Synara*
    (`index.css:77-89`, `:125-215`): `--app-surface-divider` (= `--border` at
    60%) for every *internal* hairline; a distinct, stronger `--seam-line` for
    the outer sidebar↔content edge; and horizontal header rules painted as a
    **1px background gradient** rather than a border (so they don't cross the
    seam) or a positioned pseudo-element (which would make the header a
    containing block and break portals). In a language where hairlines carry all
    hierarchy, "which line is this" must be a token, not a judgment call.
    **Lands:** shell layout, sidebar/content seam, pane headers.

12. **Freeze elevation at three levels and write down what each is for.**
    *Orca* `STYLEGUIDE.md:99-107`. Shepherd's version has *two*: inset hairline,
    and — only for the soft writing surfaces — one soft dispersed shadow. Write
    the "don't add a third" sentence into the design language doc now, with the
    escape hatch named (focus ring), because that is the sentence that stopped
    Orca's shadow use from sprawling.
    **Lands:** design-language doc, `packages/ui`.

13. **Extension-supplied themes must not be able to restyle consent chrome.**
    *Orca* `.plugin-security-chrome` (`main.css:338-358`), which re-pins every
    core token to a frozen `--orca-security-*` set: *"a pack cannot disguise a
    trust decision."* Flock rule 10 makes themes a first-class extension
    contribution; that contribution needs exactly this carve-out for permission
    prompts, extension-install dialogs, and anything destructive.
    **Lands:** overlays/modals, the extension contribution schema.

14. **Match in-flight feedback to perceived duration, and defer the visible
    loading state ~200ms.** *Orca* `STYLEGUIDE.md:270-284`: 0–100ms nothing,
    100ms–1s disabled only, 1–3s disabled + label swap, 3s+ named stages. Bind
    `disabled` immediately (double-submit), show the spinner on a timer. Plus:
    pre-reserve the width a control will grow into, using `width` not
    `min-width`. Shepherd's worktree provisioning, archive/restore and remote
    ops are all in the 1–3s+ band and all currently show a spinner immediately.
    Companion: under `prefers-reduced-motion`, a frozen indicator must read as
    *complete*, not broken (Orca's `AgentWorkingSpinner` fills its transparent
    arc) — which for Flock means the sheep freezes **standing**, not mid-stride.
    **Lands:** provisioning states, empty states, statusbar, every git action.

15. **Every CSS decision carries its measurement in a comment, and the
    interesting ones are pinned by a test.** All three do this, Synara and Orca
    exhaustively (`main.css` comments open with `Why:`; Synara records
    "Chromium snaps box-shadow to/from `none`", "a ring's box-shadow doesn't
    follow squircle geometry", "`--accent` ≈ panel background in light mode").
    Synara additionally asserts computed styles in real-browser tests
    (`*.browser.tsx`). This is already Shepherd's house style in Swift; carry it
    into CSS rather than treating stylesheets as exempt.
    **Lands:** everywhere; `packages/ui` tests.

Two smaller ones worth logging but not scheduling: *Superset*'s
scroll-driven mask via `animation-timeline: scroll(self y)` with registered
`@property` lengths (`chat-history-rail.css:1-37`) is the cheapest possible
"list continues above/below" affordance and needs no JS; and *Orca*'s
`view-transition-name`-per-card kanban, where `:only-child` distinguishes a card
that *moved* from one that was *added* (`agent-board-transitions.css`), is the
right mechanism if the task tree ever gets a board view.

---

## Where this conflicts with Flock

The standing rule: **instruments** (sidebar, statusbar, chips, keycaps) keep the
industrial treatment — hairlines, mono, uppercase micro-labels, inverse-video
selection, no shadows. **Writing surfaces** (composer, future command palette)
go soft — one well, no inner borders, space instead of lines, one filled accent,
16px radius. Each conflict below is judged against that split.

**1. Composer radius: 19px (Synara) vs 16px (Flock).**
*Flock wins, unchanged.* Synara's 1.2rem is a taste difference, not a finding.
But take the *mechanism*: one `--composer-radius` variable driving shell,
surface, banner and stacked panels, so the fused-panel math
(`calc(var(--composer-radius) - 1px)` on attached tops) stays correct. Flock's
16px should be a token in `design-tokens`, not a literal in the composer.

**2. Squircle corners on the composer (Synara `-electron-corner-smoothing:
system-ui` / `corner-shape: squircle`).**
*Adopt, for writing surfaces only.* It is not gradient, glow, blur or shadow —
it is corner geometry, and at 16px the difference between a circular and a
continuous corner is visible. It stays off instruments: a keycap or a chip at
`radius-sm` should read as machined, and a squircled 4px corner reads as neither.

**3. A real border on the composer, not a ring.**
*Adopt, with a caveat.* Synara's recorded reason is decisive
(`composerPickerStyles.ts:140-143`): a `box-shadow` ring traces the *border-box*
rectangle and will not follow squircle geometry, so with #2 adopted the border
must be a real `border`. The caveat is Flock's "no inner borders" rule for
writing surfaces — that rule is about *internal* divisions (no line between the
text area and the footer toolbar). The outer edge still needs to exist, because
without it a soft well on a warm-ink surface has no boundary at all.

**4. Soft dispersed shadow under the composer (`0 4px 18px -6px`).**
*Adopt, narrowly — this is the one exception to "no shadows".* Flock rule 2
bans shadow as *elevation theater*, and the anti-tells list bans "glow and
shadow elevation". A composer floating over a scrolling transcript is the one
place where separation genuinely cannot come from a hairline, because the
content behind it is arbitrary. Take Synara's exact form — large negative
spread so it hugs rather than fans, `foreground` at 7% in light and
`rgba(0,0,0,0.30)` in dark. It appears **once**, on the writing surface, and
nowhere else. If it starts appearing on cards, it has failed.

**5. Backdrop blur / frosted glass (Synara's composer and picker menus, Orca's
dialogs at `backdrop-blur-2xl`).**
*Flock wins — reject.* "Glassmorphism/backdrop blur" is an explicit anti-tell,
and blur is the single loudest signal that a Tailwind desktop app was built from
web defaults. Synara's own dark mode already abandons it (dark
`--composer-surface` is opaque), and Synara's slash-command menu and Environment
panel are opaque *because* content bled through. Use opaque `ink-raised` and let
the hairline do the work.

**6. Superset's gradient dissolve above the composer
(`before:bg-gradient-to-t from-background`).**
*Reject as drawn; keep the intent.* "Gradient fills" is an anti-tell, and a
32px vertical fade over a mono terminal-adjacent transcript will alias visibly.
The problem it solves is real — a hard divider between transcript and composer
is ugly. Flock's answer should be a **box-drawing rule or nothing at all**: rule
5 already licenses box-drawing dividers "where they earn their place", and this
is one.

**7. Sidebar section labels: sentence case at row size (Superset `text-[13px]
font-medium`, Synara 12px `font-normal text-muted-foreground/58`) vs Flock's
10px uppercase with `.1em`–`.16em` tracking.**
*Flock wins.* Both references made the same call and both are duller for it —
their section headers are indistinguishable from their rows at a glance. The
uppercase micro-label is instrument voice (rule 5) and the sidebar is an
instrument. Orca's own styleguide agrees against its own code
(`STYLEGUIDE.md:90`: 11px uppercase + weight 600 + `letter-spacing: 0.05em` for
category labels).

**8. Row height: 28px.**
*No conflict — three-way agreement.* Superset `min-h-7` / `py-1.5`, Synara
`1.75rem`, Flock `28px`. The recorded drift note in the design-language doc
(28 is not two 20px cells) is settled by the fact that every mature reference
independently landed on 28. Adopt Synara's density modes on top (0.85 / 1 /
1.15) rather than adding a second row-height token.

**9. Spinners as rings (both Orca and Synara).**
*Flock wins — rule 7 bans them.* But the two engineering findings underneath
transfer intact: phase-sync late-mounting indicators so a list of them doesn't
shimmer out of step (Orca sets `animation.startTime = 0` via the Web Animations
API), and make the reduced-motion frozen state read as *intentional* rather than
*broken*. For Flock that means a braille spinner freezes on a **full** frame
(`⣿`), and the sheep freezes standing.

**10. Pulsing / breathing status dots (Synara's 640ms opacity+scale pulse).**
*Flock wins — "no breathing/pulse" is explicit in rule 7.* The finding worth
taking is the reason Synara does it in CSS: *"so many open terminals don't
schedule JS timers."* Whatever Flock's working indicator is, it must be a CSS
animation or a single shared rAF loop, not a timer per pane. With 20 panes that
is a measurable idle-CPU decision, and Shepherd v1 already has a recorded
one-third-of-a-core-at-idle incident from exactly this class of mistake.

**11. Named color roles vs Flock's job-assigned accents.**
*Both, at different layers.* Orca's role table with a "don't use it for" column
(`STYLEGUIDE.md:30-44`) and Synara's on-fill-ink warning (`index.css:442-447`)
are about *usage discipline*, which Flock currently states as prose. Flock's
`cobalt`/`hay`/`pasture`/`ember`/`signal` already assign jobs; what is missing
is the negative half — write "`hay` is blocked/attention, **not** warning text
on a tint" into the token table. Do **not** adopt Orca's separate git-decoration
family wholesale: Flock has five accents with jobs and adding seven VS Code
greens/browns would break "if it's saturated, it means something."

**12. Orca's parallel `--worktree-sidebar-*` token family.**
*Reject.* It exists because Orca's sidebar sits on a different fill than its
other panels, so the hover math had to fork. Flock has one `ink` ramp and
inverse-video selection; a second family would be four more tokens meaning the
same thing. If a panel needs a different fill, it moves one step on the existing
ramp.

**13. `user-select: none` on `html, body` (Superset).**
*Reject.* Shepherd is a terminal. Selecting text is the product.

**14. Tinted status backgrounds (Orca `--status-success-background` at 10% with
a 25% border; Superset's `bg-destructive/10` error banner).**
*Partially reject.* Flock rule 3 asks for **confident flat use** — solid chips
and filled blocks — not washes. A 10% tint on warm ink reads as a smudge. Use a
solid accent chip with `ink` text (rule 4's inverse video), or accent-colored
text on the plain surface with no fill at all. The one thing to take is Synara's
dark-mode correction: a 500-weight status color on a near-black surface reads as
a heavy block, so dark variants must lighten (`color-mix(… 72%, white)`) rather
than reuse the light value. Flock's accent table already ships separate dark and
light values, which is the same correction made once instead of per-token.
