# Prompt for Claude Code

Paste this into Claude Code from the root of the `shepherd` repo, with this
handoff folder available (drop it anywhere in the repo, or reference it by path).

---

We are replacing the v2 renderer's design language. The new one is called
**Shepherd UI** and it supersedes Flock
(`docs/superpowers/specs/2026-08-06-ade-design-language.md`).

Everything you need is in `design_handoff_ui_overhaul/`:

- `shepherd-ui-skill.md` — the normative document. Read it fully before writing
  any code. Tokens, primitive rules, shell structure, and an explicit list of
  what the language refuses.
- `README.md` — per-screen specs with exact values.
- `Shepherd Redesign.dc.html` — the assembled screens, dark (canonical). Open it
  in a browser.
- `Shepherd Redesign Light.dc.html` — the same screens in light. Light is
  *derived*: same structure, same marks, same geometry. Build the dark theme
  first and generate light from the ramp table in the README.
- `Shepherd Primitives.dc.html` — every control at real size in every state,
  each specimen captioned with its spec. This is the source of truth for any
  value the README does not state.
- `Shepherd Today.dc.html` — the current UI, recreated from source, for
  before/after comparison.

The HTML files are **design references**, not code to copy. Recreate them in
`v2`'s existing environment: React 19 in `packages/app/src/renderer`, primitives
in `packages/ui` (one `.tsx` + one `.css` per component, `cn()` for class
composition), tokens generated from `packages/design-tokens`. Do not add
Tailwind, a component library, or a second styling mechanism.

## Do it in this order, and stop after each step

**1. Tokens.** Add the Shepherd UI palette and roles to
`packages/design-tokens` as a *new* theme alongside Flock rather than editing
Flock's values, so both can be rendered and compared. Add the new metrics
(`row 34`, `paneHead 38`, `tabStrip 40`, `tab 28`, radius `5 6 8 10 12 14 16`).
Keep the existing rule that this package is the only place a hex literal lives,
and keep the `roleValue` `color-mix` mechanism so a scoped re-declaration of
`--sh-text` still carries hover and selection fills. Swap the chrome face from
DM Sans to Geist; leave JetBrains Mono alone. Update the existing token tests.

**2. `StateMark` + `SuiteMeter`.** These are new and everything else depends on
them. Read §3 of the skill. A fixed 12×12 slot, five marks, `steps(1, end)`
animation on one bar, a tooltip and an accessible name per state, and a
reduced-motion variant that is complete rather than frozen. Replace every use of
`StatusDot`.

**3. The primitives.** Update `Button`, `IconButton`, `Field`, `Row`,
`SectionLabel`, `Pill`, `Menu`, `Modal`, `Tooltip`, `KeyCap`, `Composer`,
`CommandPalette`, `Empty` to the new specs, and add `SendButton`, `Chip`,
`Select`, `Tab`, `TaskCard`. Keep the existing discipline in `packages/ui`,
including the named test that forbids a second rule declaring a row height. Add
the equivalent test for `TaskCard`: nothing but the waiting-on-you variant may
change its height.

**4. The shell.** Rework `app.tsx`, `view-dock.tsx`, `terminal-pane.tsx` and
`styles.css` to the structure in §5: titlebar 44 with the wordmark only, rail
332 with the sky strip and the four ordered sections, a tab strip 40 in the
stage, pane heads that name the repo and not the task. Delete the breadcrumb.
Do not dim unfocused panes by opacity — use the border step.

**5. The composer.** Rebuild `extensions/tasks/ui/composer.tsx` as the well
described in §5 and README §2: controls inside the well, ghost selects divided
by rules, the send circle, the picker fused into the well, the scope rail
detached below. Keep the existing caret/mention machinery exactly as it is — it
is correct and it is subtle; only the presentation changes.

**6. The sky strip.** Markup-only, 3px pixel sheep, no image asset. Keep it to
the strip: an earlier version spread the scene behind the whole window and was
rejected as distracting.

## Constraints

- Read the real source before recreating any screen. Do not work from memory of
  what the product looks like.
- Every colour and length must come from a token. A hex literal outside
  `packages/design-tokens` is a defect.
- Respect the import boundaries in `tooling/eslint/boundaries.js`; they are the
  architecture.
- `pnpm -r test`, `pnpm -r typecheck`, `pnpm lint` and `pnpm smoke:terminal` must
  pass at every stop. Run `SHEPHERD_CAPTURE=/tmp/shot.png pnpm dev` and look at
  the screenshot before telling me a step is done.
- The **settings surface** is explicitly not designed yet. Do not invent it; tell
  me when you reach a point where it is needed. Both themes *are* designed — see
  `Shepherd Redesign Light.dc.html` and the ramp table in the README.
- If you find a value that is in neither the README nor the primitives sheet,
  read it off the prototype's inline style. If it is in neither, ask.

Start with step 1 and stop when its tests pass.
