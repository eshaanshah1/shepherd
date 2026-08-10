# The inline `#repo` mention picker

**Status:** designed, approved 2026-08-10. Supersedes the composer's `+ repo` field.
**Source:** a high-fidelity design handoff (`design_handoff_repo_picker/`) — an HTML
prototype plus a spec of layout, tokens, caret anchoring, keyboard model and state.

## What changes

Typing `#` anywhere in the task brief opens a repo picker anchored at the caret.
Typing filters it. Enter inserts an atomic `#reponame` pill **into the brief
itself**, and the task's scope is derived from the pills present in the text.

What it replaces: a separate repo `Field` above the brief, its ghost-text
completion layer, and a right-floating chip row. That field was the second
correction to this control — it had been a borderless `+ repo path` sharing the
action row ("too hidden to be found"), then a labelled bordered input over a
listbox ("read louder than the brief"). The finding behind this third pass is
that the control was in the wrong *place* both times: scoping a task is part of
writing the sentence, not a field beside it.

## Why the mention primitive already exists

`PromptField` is a deliberately uncontrolled `contenteditable` whose documented
purpose is "a prompt field that can hold things that are not text", and it already
ships both rules a mention pill needs:

- **atomic pills** — `contentEditable="false"`, so one Backspace takes the whole
  pill rather than eating its label a letter at a time;
- **`data-token` serialisation** — `readValue()` returns a pill's token instead of
  its label, which is already how a pasted image rides into `tasks.create` as
  `[Image #1]`.

So a repo pill is the same node type an image pill already is. **No Lexical,
ProseMirror or Slate**: the handoff's "prefer the codebase's existing
rich-text/mention primitive" resolves to one we own and have tested.

## The port needs no change

`tasks.suggestRepos` already answers both kinds of query, and this is the finding
that made the "two modes" question disappear:

- a **bare word** (`shep`) — `completionTarget` returns `null` for it by design
  ("no separator at all is a bare word, which names no directory to look in"), so
  the answer is frecency-ranked history matched on repo **name**;
- anything containing `/` or `~` (`~/Home/dev/she`) — one `readdir`, fuzzy-matched
  against the last segment.

The picker therefore passes the raw `#`-query straight through. Path completion —
the only way to scope a repo you have never used — survives inside the one
trigger, with no mode switch to implement and no second code path.

## Components

| Handoff element | Built from |
|---|---|
| Task editor | `PromptField` (already the brief) |
| Repo pill | `Pill` — its CSS is already "a token inside prose" |
| Picker rows | `Row` + `rowClasses`, `aria-activedescendant` (the `CommandPalette` pattern) |
| Card | `Composer`, unchanged |
| `create task` | `Button variant="primary"`, unchanged |
| Ranking | the port's, carried across as pre-cut `segments` — the view never re-runs the matcher |
| Popover | a hand-positioned `div`, **portalled to `document.body`**; no Radix Popover, which is not a dependency and which caret-anchoring would fight anyway |

**`StatusDot` is deliberately NOT the leading mark.** Its five roles are the agent
lifecycle and it always renders a status word as its accessible name, so a repo
row would announce "Idle". The slot holds a dedicated mark instead: filled for a
real repo, a hollow ring for a plain directory, with `repo` / `not a repo` as
`sr-only` text. That mark replaces the `not a repo` text label the current field
spends a whole run of uppercase micro-type on.

## Where the code goes

The split is about who is allowed to know what.

- **`packages/ui/src/prompt-field.tsx`** gains three generic methods and no
  knowledge of `#` or of repos:
  - `caretContext()` → `{ text, offset, rectOf(index) }` — a **read** of the
    caret's text node and where one character of it sits. `rectOf` answers `null`
    in a host with no layout rather than throwing, the rule `CommandPalette`
    records about `scrollIntoView`.
  - `insert(node, { replaceBack, trailing })` — delete N characters before the
    caret, insert, and land the caret inside the trailing text. Two measured
    details live here: the caret is read **before** `focus()`, because focusing an
    unfocused contenteditable collapses the selection to its start (so reading
    after it put every insertion at the top of the field having replaced nothing),
    and the range is **cloned**, because a live range from `getRangeAt` belongs to
    the selection that `removeAllRanges` then detaches.
  - `appendText(text)` — focus, caret to the end, type, and fire `onChange`, so the
    `#repo` button performs exactly what a keystroke would. One code path.

  Range and caret work is this primitive's documented job, and its restraint rule
  ("touch the DOM on paste and on mount, and at no other time") is about not
  rewriting under the caret while you type, which none of these does. A
  slash-command picker would be the second consumer.
- **`extensions/tasks/ui/mention.ts`** — pure, unit-tested:
  - `findTrigger(text, offset)` — the `#` rule.
  - `splitSegments(segments, at)` — cuts the port's pre-computed match runs at the
    last `/`, so the name and its parent path highlight separately.
- **`extensions/tasks/ui/repo-picker.tsx`** — the popover: header (`#query` left,
  `↑↓ ↵ esc` right), the `Row` list, the empty state.
- **`extensions/tasks/ui/composer.tsx`** — wiring, and the deletions.
- **`packages/app/src/renderer/styles.css`** — the picker's rules; the old repo
  field and chip rules deleted.

## Behaviour

**Trigger.** On input, read the caret's text node up to the caret offset, find the
last `#`, and open if the text after it contains no whitespace. One tightening
over the prototype: the `#` must sit at a **word boundary** (start of the node, or
preceded by whitespace), so `C#` and `foo#bar` do not open a picker. `#42` still
opens and shows the empty state; a space dismisses it.

**Anchoring.** A Range over the `#` character itself, in **viewport**
coordinates, with `placePicker` (pure) owning every rule: `top = hashBottom + 8`,
`left = hashLeft` clamped to the CARD so a 360px panel never overflows the
composer, and a flip to above the caret when the room below cannot show a useful
amount of list. Clamping vertically instead would slide the panel away from the
caret it is anchored to. See defect 3 below for why the coordinates are the
viewport's and the panel is portalled.

**Keyboard.** While open: ArrowDown/ArrowUp move the active row (clamped, no
wrap), Enter and Tab select, Escape closes and leaves the typed `#query` as text.
All `preventDefault`ed. Closed, every key passes through to normal editing.
Enter-while-open must beat the existing Enter-submits binding, and Escape needs
the `window`-capture listener the current repo field already documents — Radix's
dismissable layer listens on the document in the capture phase, so a React
handler cannot stop the overlay closing on the first press.

**Mouse.** Hover makes a row active; `mousedown` selects (not `click`, so the
editor never loses its selection before the insertion); mousedown outside closes.

**Selection.** Delete from the `#` through the caret, insert the pill, then a
non-breaking space, and put the caret after it.

**Scope is derived, never stored.** After every input and every insertion, read
the pills out of the DOM in document order. The text is the source of truth, so
there is no selection array that can disagree with what is on screen — the defect
class ADR 0035 is about, one layer along. A repo already scoped is filtered out of
the rows, which is how the handoff's "the same repo twice should be prevented"
gets implemented without a second guard.

**Submit.** `readValue()` serialises each pill as its `data-token`, so the brief
submits as `fix the retry loop in shepherd` with the ordered `repos` array
alongside it. The title (`titleOf`) therefore reads naturally rather than losing
the repo, which the previous shape did.

The token is the repo's **name**, and the `#` the label draws is not in it. The
`#` is this card's gesture — it opens a popover — and the agent reading the brief
never saw the popover, so a hash in its prompt is a control character from a UI it
has no idea exists. The name stays because the sentence was written around it.

## Tokens: where the handoff and our system disagree

Our tokens are three tiers (palette → roles → component) with a hard rule that no
component stylesheet may hold a hex literal. Every spec value resolves to a role
or it is a recorded deviation. Of the four conflicts, **three resolved to our
rules and the fourth reversed once it was on screen** — the shadow, below:

| Spec | Ours | Why ours |
|---|---|---|
| row active `#2e2c29` | inverse video — a solid `--sh-text` block | `Row` rule 3 and the `fillSelected` role: a wash next to a solid block is one glance apart, two washes one step apart are not. `CommandPalette` marks its keyboard-active row the same way, so this is the in-repo precedent. **Known cost: louder than the prototype.** One-line swap to `fillHover` if it reads heavy. |
| six per-repo dot hues | a repo/not-a-repo mark | Rule 3 bans a saturated colour with no job, and cobalt/hay/pasture/ember already mean working/blocked/done/error — a repo tinted pasture would read as a passing state. |
| `0 24px 60px rgba(0,0,0,.55)` | **the spec's, softened for light** — see below | Reversed after seeing it render. Rule 2's premise does not hold here. |
| hairline `rgba(255,255,255,.07–.11)` | `--sh-line` (`#343027`, opaque warm) | A white alpha over a warm ground goes cool. |

### The shadow: rule 2 reversed, and why

This design first dropped the shadow on rule 2's grounds — "the luminance step from
`surface` to `surfaceRaised` IS the elevation, and there is no second one". Built,
it was wrong, and the argument is what made it wrong: **there is no step above a
raised card.** The role ladder is `canvas → surface → surfaceRaised` and stops, the
composer card is already `surfaceRaised`, and a popover painted `surfaceRaised`
over it is painted the colour of the thing it floats above. Rule 2 is an argument
about a card lifting off a panel, where it is right; a popover over an
already-raised card has no step left to spend.

So the panel gets three things, and the first two are in-system while the third is
a deliberate, reasoned departure:

- a **hairline**, via the `--sh-line` escape hatch (see the defect below);
- a **wash lift** — `color-mix(in oklab, var(--sh-text) 7%, var(--sh-surface-raised))`
  — the step the ladder does not have, moving with a theme the way a fourth
  hardcoded ink would not. **FINDING: the roles need a `surfaceOverlay`.**
- the **shadow**, `0 24px 60px rgb(0 0 0 / 55%)`, softened to
  `0 16px 40px rgb(0 0 0 / 16%)` under `:root[data-theme='light']` because 55%
  black over a pale surface reads as soot. Black at an alpha rather than a palette
  colour: a shadow is the absence of light, and `--sh-canvas` would invert to a
  pale glow in the light theme.

### Three defects this found after the design was written

Recorded because each one was invisible to the whole test suite and visible
instantly on screen — the argument for the smoke gate, made again.

1. **The panel had no border.** `composer.css` re-declares `--sh-line: transparent`
   for the entire `.sh-ui-composer` subtree; the popover is a descendant, so its
   border and its header rule both resolved to transparent. The escape hatch was
   applied to the footer row and forgotten on the panel. Now locked by
   `composer-picker.css.test.ts`, which needed `css: true` on the app's vitest
   config and asserts the stylesheet loaded before asserting anything about it.
2. **The panel had no fill contrast** — the `surfaceRaised`-on-`surfaceRaised`
   problem above. Its invisible corner painting over the `create task` button read
   as a bite taken out of the button.
3. **The panel would have been CLIPPED.** `.sh-ui-modal` carries `overflow: auto`
   *and* `transform: translateX(-50%)`. The transform makes it the containing block
   for even a `position: fixed` descendant and the overflow then clips it, so an
   in-tree panel is cut off as soon as the list is taller than the card — which
   with four rows it always is. It also meant `left`/`top` were measured against
   the card while resolving against the modal. **The panel therefore portals to
   `document.body`** with viewport coordinates, and `placePicker` is a pure
   function owning the whole placement rule: clamped to the card horizontally
   (a popover that wanders off the composer stops reading as part of it), flipped
   above the caret when there is no useful room below.

Near-identical, so the role is taken silently: text `#e9e6e0` → `--sh-text`
(`#E9E2D2`), meta `#6d6860` → `--sh-text-faint` (`#6E6759`), placeholder
`#6f6b63` → `--sh-text-faint`, JetBrains Mono → `--sh-font-mono` (exact), meta and
hint 11–12px → `small`/`medium` (exact).

Systematically warmer, which is our palette's identity: the spec's neutral greys
(`#0c0c0a`, `#1a1917`, `#201f1d`) against our warm ink ladder (`#14120E`,
`#1B1915`, `#24211B`) — same luminance steps, different temperature. `secondary
#8a867e` → `--sh-text-dim` (`#A49B89`, lighter), and the spec's fourth step
`faint #5d5952` has no equivalent, so the scope line and the row meta collapse
onto one token.

Geometry, where the scale has no step: radii pill 7→**6** (`md`), row and button
9→**6** (`md`), popover 14 and card 18→**16** (`soft`, the only writing-surface
radius); the footer chip's capsule 20 has no token and `pill.css` argues against
capsules by name. Spacing: the spec uses 6·10·12·14·16·18·24·26 and our scale is
4·6·8·12·14 — **10, 16 and 18 do not exist** (`composer.css` already carries the
finding that there is no step above 14px; the 26px card inset is already composed
as `xl + lg`). Type: editor 19→**15** (`large`, already `.sh-composer-brief`), rows
15→**13** (`body`, in a fixed 28px row against the spec's ~36), chip 13→**12**
(`medium`). Font: Outfit → **DM Sans**.

## The row's meta slot

The handoff draws `main · 2h ago`. The port carries no branch and no timestamp,
and adding them would mean shelling out to git per candidate on every keystroke
for up to ten rows — against a handler that is currently pure plus one `readdir`
measured at ~10ms. So the meta slot carries the **home-collapsed parent path**,
which is also the fact that actually disambiguates here: two `api` repos in
different trees is the case a name-only picker has to survive, and a branch name
would not tell them apart.

## Testing

- `mention.test.ts` — the trigger's boundaries (`C#`, `foo#bar`, `#` after a
  space, whitespace closing it) and the segment split.
- `prompt-field.test.tsx` — `replaceBack` deletes exactly N and leaves the caret
  after the inserted node; `caretContext` reports the caret's own text node.
- `composer.test.tsx` — type `#she`, assert the rows, arrow, Enter, assert the
  pill, and assert `tasks.create` receives the right `brief` and ordered `repos`.
  Its `type()` helper places a real **caret**, because the trigger reads the
  caret's own text node — a write that set `textContent` and fired `input` without
  a selection would assert against a picker that can never open.
- `composer-picker.css.test.ts` — the panel's boundary, asserted against the CSS
  RULES (jsdom lays nothing out, so a test may assert what a rule says and never
  what it renders). Guards against the vacuous pass: with `css: false` every
  `rulesMentioning` returns `[]` and every assertion on it holds.
- `pnpm typecheck && pnpm lint && pnpm test`, then **`pnpm smoke:m3`**: this is
  composer work, and a green unit suite is not a working app in this repo.

Two things the smoke itself needed, both recorded rather than quietly patched:

- its composer step now types a `#` mention and places a caret, and reads the
  scope from `[data-repo-path]` — the same DOM the component derives from, so a
  pill that renders without a path fails;
- its provisioning gate waited on the worktree's `.git` and then asserted
  `CLAUDE.md`, which lands a beat later. That is precisely the race step 2 of the
  same file already records ("waiting on the first and asserting the second is a
  race that passes on the timing of the day"), and it duly failed once the
  composer got faster. Both are now in the one `until`.
