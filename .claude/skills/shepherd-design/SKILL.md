---
name: shepherd-design
description: Use this skill to build UI in Shepherd — new surfaces, screens, panels, overlays, extension views — or to generate mocks and prototypes that look like Shepherd. Contains the codebase map, per-surface recipes, the component decision table, and the rules a Shepherd UI has to satisfy before it ships.
user-invocable: true
---

# Building UI in Shepherd

Shepherd is an agent-native terminal: each pane can be a tracked agent, and the
rail is how you know which one needs you. That single job decides most UI
questions — **the chrome recedes so the user can read the one thing that
changed.**

Read `references/handoff-spec.md` for the foundations (colour, type, motion,
iconography, content). This file is how you *build* with them.

The rest of `references/` is visual, and two of the four are traps:

| file | what it is |
|---|---|
| `references/primitives.dc.html` | the primitive set, drawn. Open it before composing. |
| `references/redesign.dc.html` | the assembled screens, dark. **Canonical.** |
| `references/redesign-light.dc.html` | the same screens in light. |
| `references/today-before.dc.html` | the **superseded** Flock language. Reference for what was replaced — never copy from it. |
| `references/implementation-order.md` | a one-time migration prompt, kept for history. Its paths no longer exist; do not follow them. |

If you are prototyping rather than shipping, everything below still applies —
build the mock from these components and tokens so it looks like the product,
not like a sketch of it.

---

## 1. The codebase

| you are changing | it lives in |
|---|---|
| a colour, a size, a height | `packages/design-tokens/src/` — the only place a hex literal is legal |
| a primitive (Button, Row, Menu…) | `packages/ui/src/` — one `.tsx` + one `.css` per component |
| the shell (titlebar, rail, stage, panes) | `packages/app/src/renderer/` |
| a contributed surface (tasks, GitHub, diagnostics) | `extensions/<name>/` — `src/` for logic, `ui/` for views |

Read the real source before recreating anything. Never work from memory of what
the product roughly looks like.

**Import boundaries** (`tooling/eslint/boundaries.js`) are the architecture, not
a lint preference: `design-tokens` imports nothing, `ui` imports `design-tokens`,
`app` imports both, extensions import `sdk` and `ui`. If your change needs a new
edge in that graph, the change is wrong.

---

## 2. Before you write anything

Ask these in order. Most new UI never gets past question 3.

1. **Does this state already have a mark?** working / waiting on you / resting /
   failed / shipped covers nearly everything. Use `StateMark`. Do not invent a
   sixth state because your feature feels different.
2. **Can this go in an existing surface?** A rail section and a stage tab cost
   the user nothing to learn. A new panel costs them a new place to look.
3. **Does it need a new primitive?** Almost certainly not. Read
   `packages/ui/src/` for the current set — one more is a conversation, not a
   commit. Compose first.
4. **What does it look like empty, loading, failed, and with one item?** If you
   cannot answer all four, you are not ready to build it.

---

## 3. The five places new UI can go

### A rail section

The default home for anything list-shaped: pull requests, diagnostics, review
queue, notifications.

```jsx
<SectionHeader count={items.length}>Pull requests</SectionHeader>
{items.map((item) => (
  <Row
    key={item.id}
    mark={<StateMark state={item.state} />}
    meta={item.age}
    actions={<IconButton label="Open on GitHub" icon={<External />} />}
    onClick={() => open(item)}
  >
    {item.title}
  </Row>
))}
```

Rules: one row height, whatever the row says. Metadata and hover actions share
one grid cell (`Row` does this for you) so revealing actions never reflows.
Sections are ordered by **what the user must do**, never alphabetically and never
by recency. A section that needs the user takes `urgent`, and only one section
may have it at a time.

### A stage tab

For anything pane-shaped that belongs to a task: a diff view, a log, a preview.

```jsx
<Tab active={id === current} mark={<SuiteMeter total={4} passed={3} />}>tests</Tab>
```

A tab is named for **what you opened it for** — `agent`, `tests`, `scratch` —
never for its task. The rail already carries the task's name; repeating it down
the hierarchy is the single most common mistake in this codebase's history.

### An overlay

For a transient, focused act: compose, command, confirm.

```jsx
<Modal>
  <Well footer={<>…controls…<SendButton /></>} attachment={<Picker />}>
    {brief}
  </Well>
</Modal>
```

Pinned near the top, never vertically centred — a centred dialog crawls up the
window as its content grows. A `Modal` containing a `Well` drops its own card:
one surface, not two. Escape closes the **topmost layer only**; with a picker
open inside the composer, Escape closes the picker.

Register the shortcut on `window` in the capture phase, not as a menu
accelerator — xterm holds focus, and a menu key equivalent cannot be closed by
the bar that opened it.

### A pane

Only for something that is genuinely a running process or a live document.

```jsx
<PaneHead repo="relay" tone="sky" branch="retry-loop"
  mark={<StateMark state="working" />}
  diff={<DiffStat added={142} removed={38} files={6} />} />
```

A pane head names the **tree**, not the task. Focused is one border step
(`--sh-line-focus-pane`); unfocused panes are **never dimmed by opacity** — a
dimmed pane is one whose live output you can no longer read while it is still
running.

### A settings page

**Read [ADR 0040](../../adr/0040-v2-settings-are-declared-in-a-manifest-and-held-by-the-kernel.md)
before building one** — it is the normative account and this is only the shape.

⌘, takes over the window. The frame is the shell's; the pages are contributed,
declared as `contributes.settings` in a manifest and held by the kernel, so the
screen lists every extension's settings with zero extensions activated. Keys sit
in the declaring extension's own namespace, derived by the host from the manifest
id — a key outside it is refused and the refusal fails the whole activation.
Only values that differ from a declared default are stored.

`Field`s cover a row. Anything a row cannot express is a **component page**,
which is what proves the escape hatch is a mechanism rather than a paragraph
(`worktree-hook` is the worked example).

---

## 4. Which component

| you need to show | use | not |
|---|---|---|
| what an agent/task/pane is doing | `StateMark` | a coloured dot with a word beside it |
| a small integer result (suites, checks) | `SuiteMeter` | "3 of 4 passed" as text |
| lines added/removed | `DiffStat` | a stacked ratio bar |
| a repo, branch or worktree name | `Chip` | a `Pill`, a badge, a coloured tag |
| a repo mentioned **inside a sentence** | `Pill` | a `Chip` parked in the text |
| one item in a scannable list | `Row` | a card |
| a task carrying its own work | `TaskCard` | a `Row` with extra lines |
| a choice inside a well | `Select` + `SelectRule` | a bordered dropdown |
| a settings input | `Field` | a `Well` |
| a writing surface | `Well` | a `Field` with a big height |
| the one action on a surface | `Button variant="primary"` | a hue-coloured button |
| cancel / dismiss / close | `Button variant="ghost"` | a secondary with a key hint |
| a glyph-only action | `IconButton` (label required) | a bare `<svg onClick>` |
| the word a mark stands for | `Tooltip` | a label in the row |

**One primary per surface, and it is wool** — near-white on black, ink on paper.
A hue is never a button; hues are spoken for by state. If two controls are loud,
neither is.

---

## 5. State, and how it is drawn

Five marks, one fixed 12px slot, and the slot never resizes — so a label never
shifts because a state changed.

| state | mark | and the surface does |
|---|---|---|
| working | three sky bars, one cycling | nothing |
| waiting on you | solid wool square | **opens** into a card with the question and both answers inline |
| resting | hollow ring | nothing |
| failed | solid red square | keeps the resting surface; red lives in the mark and the exit code |
| shipped | a check | **leaves the list** and becomes a count at the foot |

A **square** always means *your move*. A **ring** means nothing is happening. A
**meter** means something is.

The state word travels as `title` and `aria-label` and is never drawn beside the
mark — two states will eventually share a hue, and a fact encoded only in colour
cannot be read out, searched, or asserted on in a test.

**A task waiting on you is the only element in the product allowed to change
size**, and only to put its answer where the question is. Everything else is a
fixed height or a fixed shape.

---

## 6. Writing the copy

Plain, finished sentences; lower-stakes than the moment feels. No "I", rarely
"you" — and only where the user must act.

- Sentence case everywhere. `Waiting on you`, not `WAITING ON YOU`.
- A label is 1–3 words. A card line is one clause. An empty state is one sentence
  plus one hint.
- Neutral verbs while in flight (`Running`, `Reading`), result verbs only for
  results (`Shipped`, `passed`, `failed`).
- If it can be counted, print it — tabular, in mono. `+142 −38 · 6 files`, not
  "a few files changed".
- No emoji, anywhere, ever.
- Invalid state is a red edge **and** a sentence. Never colour alone.

---

## 7. Tokens, themes and extensions

Every colour and length comes from a token. A hex literal outside
`packages/design-tokens` is a defect, and it is a *visible* one the moment a user
switches theme — which is better enforcement than any lint rule.

A contributed surface supplies data and a **token name**. It cannot set a colour,
cannot set a height, cannot make its row taller or louder, and cannot introduce a
hue the palette does not have. That constraint is what makes GitHub sync, or
anything you add next year, look like it was always there.

Theme switching is `data-theme="light"` on the root and nothing else. If your
component needs code to change theme, it is reading a value it should have
inherited.

---

## 8. Motion

140ms linear, on colour only. Nothing translates, scales, springs or bounces — a
control that moves under the cursor is a control whose target moved mid-click.

The working meter is `steps(1, end)` at 1.1s, so it repaints twice a second
rather than every frame; twelve panes of continuously-animating indicators peg
the GPU. Under `prefers-reduced-motion` a meter renders **complete and static** —
a frozen partial one reads as broken.

Match feedback to duration: under 100ms show nothing, to 1s disable only, to 3s
disable plus spinner, beyond that a stage label. Bind `disabled` immediately and
defer the *visible* loading state ~200ms, so a local action flashes nothing and a
slow one still answers.

---

## 9. Before you open the PR

Some of this is machine-checked and the rest is yours to check by eye. Know which:
`packages/ui/src/refusals.css.test.ts` asserts §10's stylesheet-level refusals over
the whole primitive sheet, and the per-component tests assert each one's own rules
through `@shepherd/ui/css-rules`. **A claim you cannot assert is a claim to verify
manually, not one to skip** — the composer shipped three defects that 2,000 green
tests could not see, all three properties of the CSS rather than of the markup.

- Every colour and length is a token.
- Every mark has a tooltip and an accessible name.
- Focus is visible on every interactive element, `:focus-visible` only, and
  focused controls are the same size as unfocused ones.
- Coarse pointers get a 44px hit target from an invisible `::after` — not from a
  second component and not by growing the drawn control.
- You added the way out for every way in, and the way to see it.
- Empty, loading, failed, and one-item all render.
- Nothing repeats a name down the hierarchy.
- No row anywhere declares a second height.

---

## 10. The refusals

Most mistakes are on this list.

A status word beside a status mark · inverse video for selection · uppercase
micro-labels with tracking · repeating a name down the hierarchy · a sixth hue,
or a fifth used for decoration · shadows for elevation (one exception, written
down: a menu over an already-raised surface) · continuous animation · motion that
moves a control · a row that grows to reveal hover actions · two primary buttons
on one surface · dimming an unfocused pane by opacity · gradient fills, glass,
backdrop blur, skeleton shimmer, emoji as iconography, marketing spacing inside
the app.
