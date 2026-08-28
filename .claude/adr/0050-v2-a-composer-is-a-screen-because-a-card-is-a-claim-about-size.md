# 0050. (v2) A composer is a screen, because a card is a claim about size

Status: Accepted
Date: 2026-08-29
Scope: `v2/` only.
Extends: [0033](0033-v2-extension-ui-is-in-proc-react.md), [0040](0040-v2-settings-are-declared-in-a-manifest-and-held-by-the-kernel.md), [0044](0044-v2-a-pane-may-be-a-contributed-view.md).
Answers a question deferred by: [0049](0049-v2-a-scratchpad-is-a-document-without-a-path.md).

## Context

The ⌘N composer shipped as `surface: 'overlay'` — a 620px `Composer` well inside
a Radix `Dialog`, floating over a dimmed stage, asking one question. That was
right while the brief WAS the question.

It is not one question any more. The composer collects a brief, a repo scope, a
model, a placement, a profile and a machine, and every one of those had to fit a
row inside a card sized for a sentence. The result is visible in the version this
replaces: three ghost `Select`s divided by `1px × 16` rules, a fourth appearing
only when a remote is paired, a send circle pushed right by a spacer, and a
detached scope rail below the card restating what the sentence already said.
Every one of those is a compression artefact. Nothing was designed to be a strip
of chevroned dropdowns under the writing; it is what fits.

**A card is a claim about size.** An overlay says "this is small enough to float
over your work". Once that stops being true, a modal grown to fill the window is
a window with a border drawn round the middle of it — and the border is then
load-bearing for nothing except hiding that the claim expired.

The app already had a surface that takes the window over: Settings (ADR 0040).
It could not be reused, because it is not a contribution — `SettingsScreen` is
mounted by `app.tsx` and reachable only from inside the shell. ADR 0049 deferred
a new contribution point until a **second consumer** bought it. This is that
consumer.

## Decision

**A fourth surface, `screen`: a contributed component that covers the STAGE.**

`surface: 'dock' | 'overlay' | 'pane' | 'screen'`. It is painted over
`.sh-stage`, so it covers the tab strip and every root; it is a singleton, so
raising one closes any other; and it is mounted only while open.

Two tests separate it from the three that existed, and a surface has to fail
both to earn it:

- **It is not a `pane`**, because it is not a place. Nothing about it survives a
  relaunch, you never split it, and there is no subject it is a view OF — which
  is the whole of ADR 0044's bar. `layout.newTab` already accepts a `view`, so a
  composer-as-tab was buildable with no new seam at all; it was rejected because
  a tab is a thing you keep, and there can never be a second "new task" open at
  once. Both halves of that are wrong for a tab and right for a takeover.
- **It is not an `overlay`**, for the reason above.

### The rail is not covered, and Settings covers it

This is the one place `screen` and `SettingsScreen` deliberately disagree.
Settings is a departure from the work, so it takes everything. Composing is the
*start* of the work, and the list of what is already running is the context you
compose against — the flock is how you notice that the task you are about to
write is the one running in tab two. So the layer stops at the rail's rule.

The mechanism is that `.sh-screen` is `position: absolute; inset: 0` against
`.sh-stage`, which required `.sh-stage` to become a containing block. Without
that one line the screen resolves against the viewport and covers the flock,
which is the entire difference between the two surfaces expressed as a
`position: relative`.

### The roots stay mounted

The layer is painted over the stage, never instead of it. A conditional mount
around the roots is v1's `_ConditionalContent` lesson: a torn-down pane is a
released terminal and then, on the way back, a second pty. ADR 0040 records the
same constraint for Settings; it is repeated here because the two layers are
built differently and only one of them is obviously safe by inspection.

## What this cost, and what caught it

**The composer had been getting its caret from Radix and did not know it.**
`Dialog` autofocuses its first focusable on the way in, so the composer mounted
with the caret in the brief without ever asking for one. A `screen` is a plain
element with no focus trap, so the same component opened in the real app with
the caret nowhere — you had to click the sentence before you could write it.

Every unit test covering the composer passed, because each supplies its own
focus. `pnpm smoke:m3` failed on `⌘N lands the caret in the brief: null`, and it
is the only thing that could have. This is the second entry in this repo's
ledger of "a green unit suite is not a working app", and the shape is the same
as ADR 0048's: a test that provides both sides of a correlation cannot discover
that the two sides disagree.

The same applies to what a port silently drops. Esc, the focus trap, `inert` on
the rest of the page and focus restoration were all `Dialog`'s. Esc came back
explicitly and is tested — including the negative, that it is NOT swallowed while
the layer is closed, because a global Escape handler that runs unconditionally is
a key deleted from every pty in the app. The other three did **not** come back
and are named here as known gaps rather than left to be discovered: a screen
covering the stage leaves the rail focusable behind it, which is correct for a
surface that deliberately does not cover the rail and wrong for `aria-modal`,
which this element claims. Reconciling those two is deferred until something
needs a screen that is genuinely modal.

**`surface` is spelled out in four hand-maintained copies** — the SDK union, the
renderer DTO, the ext-protocol enum and `ext-host.ts`'s local type. Adding one
value meant editing all four, and nothing correlates them. That is the same trap
ADR 0048 recorded from the other direction, where a third hand-maintained list
hid a missing module past the very test written for it. The four are noted here
because the next person adding a surface will find them one at a time.

## The row, which is the visible half

`Select` was replaced by a bare `<button>` per knob, and the rules are worth
recording because they are what makes a row of five controls readable:

- **A glyph for which, a word for what.** Four words in a row are four things to
  read; four glyphs are one thing to scan. The word stays because a glyph cannot
  say `Opus 5`.
- **Ink is a decision, ghost is a default.** Two steps of the ramp carry the only
  thing worth carrying. Drawing every slot in ink spends the loudest step on
  facts nobody chose, and the knob you did turn then has nothing to be louder
  than. `defaultModel` is a ref stamped with the agent layer's first answer for
  exactly this: `model` alone cannot tell a value you were handed from one you
  picked.
- **Open is the only fill.** A slot takes an edge for as long as its own menu is
  open, which is the one moment an edge answers a question.
- **The profile has no slot until it is set.** `default` written out is the row
  reporting that nothing happened. Incognito is a mark and no word, in ink rather
  than a hue — red is a run that failed, and a privacy control is not a warning.
- **The repo slot is a mirror, never a store.** It types a `#` (`appendText`,
  which exists for this and says so) and reads the pills back. ADR 0035's rule,
  and here the bug it prevents is visible: backspace over a pill drops the repo
  from the sentence, and a second array would go on scoping the task to it.
- **No send button.** ⏎ sends, and a button duplicating a key that always works
  is chrome every open pays for. The line under the brief teaches ⏎ and ⌘⏎ —
  the latter was previously taught only in a `title` on a control nobody hovers.

`Composer` survives as a primitive with one remaining caller, `CommandPalette`.
Its own doc comment says a container with one caller would be a layout rather
than a primitive; that test is now marginal and is left as a live question rather
than acted on, since deleting a primitive to satisfy a comment is a worse trade
than a comment that has stopped being true.

## Consequences

- Any extension can take the stage over. Nothing enforces that a screen is worth
  it, and the bar is written in the SDK's doc comment rather than in code —
  consistent with how `pane`'s bar is stated, and with the same weakness.
- `SettingsScreen` is now the odd one out: a takeover the shell hardcodes, beside
  a takeover anything can contribute. Folding it onto this surface is the obvious
  next move and is deliberately not done here, because ADR 0040's settings screen
  covers the rail and this one does not, and reconciling that is a question about
  settings rather than about composing.
