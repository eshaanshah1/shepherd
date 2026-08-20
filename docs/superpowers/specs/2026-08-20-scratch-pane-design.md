# Scratch: a markdown pane

Date: 2026-08-20
Scope: `v2/` only.
Status: design, approved in chat. Implementation plan not yet written.

## What this is

A new pane type. A leaf of the layout tree that is a plain text editor instead
of a terminal, holding markdown, rendering it live as you type.

It is for the notes a person keeps while driving agents: what to check, what
broke, the URL of the run that failed, the three things left before this lands.
Today those live in a terminal scrollback that scrolls away, or in another app.

The audience is a human typing by hand. That is the whole reason the markdown
set is small: nobody hand-types a table.

## What was decided

Five questions, answered before this document existed. They are recorded here
because every section below is downstream of one of them.

1. **Live preview, in place.** Not a toggle, not a split. You type `# foo` and
   the line becomes a heading when you leave it; put the caret back and the `#`
   returns.
2. **A buffer per pane.** No names, no picker, no library. Every scratch pane is
   its own text, the way every terminal pane is its own shell.
3. **Survives relaunch, dies with the pane.** The buffer's lifetime is the
   pane's. Quit and reopen and the text is there because the pane is there.
   Close the pane and the text is gone.
4. **The typing set.** Headings, bold, italic, strikethrough, inline code, code
   fences, bullet and ordered lists with nesting, task checkboxes, blockquotes,
   links, bare URLs, horizontal rules. Checkboxes and links are interactive.
   Everything else stays as literal characters.

   Bare URLs autolink because a pasted link is the single most likely thing to
   land in a scratch pane, and typing `[](…)` around one is exactly the
   ceremony this pane exists to avoid.
5. **It takes the name `scratch`.** D9's existing Scratch is renamed.

## The name, and D9

`Scratch (D9)` already exists in the v2 plans and means something else: ⌘T
opening a loose tab that is not a task, backed by a list of cwd and title, never
resuming an agent. It is documented and unbuilt, so its name is still cheap to
move.

This feature takes `scratch`. D9's concept becomes **loose tab**, which is more
literally what it is. The rename covers headings, prose and cross-references in:

- `docs/superpowers/plans/2026-08-07-v2-m3-plan.md` (the D9 entry, ~line 479)
- `docs/superpowers/plans/2026-08-08-v2-handoff.md` (What is left, item 1)
- `docs/superpowers/plans/2026-08-12-v2-m4-punch-list.md` (item 3)
- `CLAUDE.md` (the "Scratch (D9) and then M4" line)

D9's own design is untouched. Only the word changes.

## The editor

### CodeMirror 6

Live preview needs three things: a parse of the buffer, decorations applied to
ranges of it, and a rule that turns decoration off where the caret is. That is
an editor, and building one on `contenteditable` means reimplementing undo, IME
composition and paste. `packages/ui/src/prompt-field.tsx` already documents that
road; it took it deliberately for a one-line prompt field with pills, and its
own comments are clear that inherited editing behaviour is the thing you are
spending when you go there.

CodeMirror 6 also keeps the document as exact text. ProseMirror-family editors
(Tiptap, Milkdown, Lexical) hold a rich document and serialize to markdown on
the way out, so they rewrite what you paste. For a pane whose job is partly
"somewhere to dump text", that is disqualifying.

Packages: `@codemirror/state`, `@codemirror/view`, `@codemirror/language`,
`@codemirror/commands`, `@codemirror/lang-markdown`, `@lezer/markdown`,
`@lezer/highlight`. Pinned in the workspace catalog (`pnpm-workspace.yaml`), the
way every other shared version is.

They are a private vendor dependency of the extension, declared in its own
`package.json` and imported only from its `ui/` half. `tooling/eslint/
boundaries.js` already permits this; `@shepherd/ext-github` owns `@octokit/rest`
and `react-markdown` on exactly the same footing.

**Bundle cost is unmeasured and must be measured in the plan.** CodeMirror would
be the largest renderer dependency after xterm. If it lands somewhere
unacceptable, the fallback is lazy-loading the editor module on first scratch
pane rather than changing the design.

### The construct set is an import list, not a filter

`@lezer/markdown` ships GFM as four separately importable extensions:
`Strikethrough`, `TaskList`, `Autolink`, `Table`.

Enable the first three. Do not import `Table`.

This matters more than it sounds. "No tables" is then not a rule anything
enforces at render time. A table is simply not a construct the parser knows, so
`| a | b |` is a line of text and stays a line of text. The same holds for
footnotes and reference links, which base CommonMark in `@lezer/markdown`
handles but which we leave undecorated.

Rendered, with markers hidden or replaced:

| construct | syntax |
|---|---|
| headings | `#` through `###` |
| bold, italic | `**x**`, `*x*` |
| strikethrough | `~~x~~` |
| inline code | `` `x` `` |
| code fence | ```` ```lang ```` |
| lists | `-`, `1.`, nested |
| task list | `- [ ]`, `- [x]` |
| blockquote | `>` |
| link | `[text](url)` |
| autolink | a bare URL |
| rule | `---` |

Literal, always, no decoration: tables, footnotes, reference links, raw HTML,
images, math.

Raw HTML rendering as its own characters is the same answer
`extensions/github/ui/markdown.tsx` reached for PR bodies, arrived at from the
other direction. There it took a remark plugin to get; here it is the default.

### How live preview works

A `ViewPlugin` holds a `DecorationSet` and rebuilds it on `docChanged`,
`selectionSet` and viewport change. It walks the syntax tree over
`view.visibleRanges` only, so cost is proportional to what is on screen rather
than to document length.

Three decoration kinds:

- `Decoration.replace` on syntax markers, so `**` disappears and the text
  between it does not move.
- `Decoration.mark` for styling, so bold is bold and inline code gets its
  background.
- `Decoration.widget` for the one thing that is not text: the task checkbox.

**The caret rule.** A construct renders raw when its range intersects any
selection range. The unit differs by kind:

- Block constructs (heading, list item marker, blockquote, fence) use the
  **line**. Caret anywhere on the line, the whole line is raw.
- Inline constructs (bold, italic, code, link) use the **node**. Caret inside
  the bold, that bold is raw; the rest of the line stays rendered.

This is the Obsidian behaviour and it is what was mocked up and approved.

Two gotchas known in advance:

1. **Hidden ranges need `atomicRanges`.** Without it the caret can be moved
   into a zero-width replaced range with an arrow key and appear stuck.
2. **The checkbox widget must not take focus.** `ignoreEvent` and an explicit
   `preventDefault` on mousedown; a widget that steals focus moves the caret and
   the surrounding line flips to raw on every click.

### Interaction

**Checkbox.** Plain click toggles it. The widget dispatches a transaction
replacing the single character between the brackets. There is no competing
meaning for a click on a widget, so no modifier is needed.

**Link.** ⌘-click opens in the default browser. Plain click places the caret,
which reveals the raw `[text](url)` and is therefore how you edit the URL.
Plain-click-to-open would fight the primary meaning of clicking text in an
editor, and would make a link uneditable.

**Opening a URL.** There is no kernel `shell.openExternal`; github's note at
`extensions/github/src/index.ts:461` says so and says what to do instead. Scratch
does the same: `process.exec(['/usr/bin/open', url])` with an **argv array**, so
nothing in the URL is interpreted by a shell.

The scheme guard differs from github's, and has to. Github checks a
`https://github.com/` prefix because its URLs come from an API response. These
come from the user's own typing, so the question is not where the click goes but
what `open(1)` is being asked to launch. **Allow `http://` and `https://` only.**
Anything else, `file://` and custom schemes included, does not open and is not an
error; it is just a link that is text.

## Shape

A new extension, `shepherd.scratch`, in the two halves ADR 0033 requires.

```
v2/extensions/scratch/
  package.json          manifest, deps, the ./ui and ./manifest subpaths
  src/index.ts          activate: KV, commands, registerViewType
  src/manifest.ts       the typed copy, asserted equal by manifest.test.ts
  src/store.ts          the KV wrapper and its schema
  ui/index.ts           the ./ui barrel
  ui/scratch-pane.tsx   the pane component
  ui/editor.ts          CodeMirror configuration
  ui/live-preview.ts    the ViewPlugin and its decorations
  ui/theme.ts           design-token-driven CodeMirror theme
```

Registration in `src/index.ts` copies `extensions/github/src/index.ts:235`
nearly line for line:

The view type and the component name are one string, `scratch.pad`, following
`github.review` and `tasks.composer`:

```ts
views.registerViewType(SCRATCH_VIEWS.pad, {
  kind: 'component',
  component: SCRATCH_VIEWS.pad,   // 'scratch.pad'
  surface: 'pane',
  title: 'scratch',
  key: 'CmdOrCtrl+Shift+N',
})
```

The renderer gains one line in `EXTENSION_PANE_UI`
(`packages/app/src/renderer/extension-ui.ts`), which is the second entry that
table has ever had.

**`extensions/github/ui/markdown.tsx` is not reused or promoted.** It renders
markdown to React elements. This renders markdown to CodeMirror decorations.
The output types share nothing, and an abstraction over both would be an
abstraction over one line of agreement.

## Storage

KV, namespace `shepherd.scratch`, one row per buffer:

```ts
interface ScratchDoc {
  readonly text: string
  readonly updatedAt: number
  readonly closedAt?: number
}
```

The pane's `view.state` carries `{ id }` and nothing else.

**The text must not live in `view.state`.** `LayoutStore` re-encodes the entire
layout and writes it on a 400ms debounce
(`packages/core/src/layout/store.ts:350-362`), and the comment at line 358 says
the debounce exists so it does not "write once per keystroke". A document in
there would restore that exact problem, for every pane in the window at once.

KV is one sqlite row per key with an upsert
(`packages/core/src/storage/store.ts:163`), so a scratch write touches one row
and nothing else.

**Save cadence.** Debounced 400ms idle from the pane, matching the layout
store's number so there is one cadence in the app rather than two. Flushed on
blur, on pane close, and on window teardown.

## Lifetime

Restated as one rule: **the buffer is the pane.**

- Relaunch restores the pane, so it restores the text.
- Closing the pane ends the text.

Underneath that rule, close is a **soft delete**: set `closedAt`, keep the row,
garbage-collect rows older than 7 days at startup.

The reason is `layout.closeGroup`, which runs `store.close` per pane directly in
main (`packages/core/src/layout/commands.ts:573`) and is what shelving a task
does. That path never reaches the renderer, so no prompt can guard it, and
without a soft delete shelving a task would silently take your notes with it.
One deletion path, and the prompt below is a courtesy on top of it rather than
the only thing standing between you and losing an hour of notes.

**The prompt.** ⌘W is a menu accelerator (`menu-template.ts:123`) and macOS
resolves menu key equivalents before the page sees them, so the pane itself
cannot bind it. It does not need to: the menu item routes through the renderer's
`runMenuCommand` (`packages/app/src/renderer/app.tsx:331`) before invoking
`layout.close`. The guard sits there, and covers ⌘W, the File menu item and the
tab strip's close control in one place.

A scratch pane with text prompts. An empty one closes silently.

## Opening it

`⌘⇧N`. Sibling of `⌘N`, which is the task composer, so the shift reads as "new,
but the other kind of new".

It is free. Everything bound today:

- menu, AppKit-resolved: `⌘,` `⌘T` `⌘D` `⌘⇧D` `⌘W` `⌘⌥` arrows
- menu roles, Electron's: `⌘Z` `⌘⇧Z` `⌘X` `⌘C` `⌘V` `⌘A` `⌘M` `⌘R` `⌘⇧R`
  `⌥⌘I` `⌘Q` `⌘H`
- renderer: `⌘K`, `⌘F`, `⌘⇧I`
- contributed: `⌘N` composer, `⌘⇧F` session search
  (both `extensions/tasks/src/index.ts`)

**The seam this needs.** `registerViewType`'s `key` field exists but
`packages/app/src/main/view-registry.ts` documents it as "the accelerator that
raises an overlay", and `view-overlay.tsx` honours it for overlays only.

This work generalises it by adding one field: **a `pane` contribution may declare
`key` together with a `command`, and the renderer binds the key to invoke that
command.** The key runs a verb rather than opening a pane directly, because the
buffer id has to be minted and written before `layout.newTab` carries it in
`view.state`. A pane that minted its own id on mount would have nowhere to put
it, since nothing can rewrite a pane's `view.state` after the fact.

`contributes.commands[].key` was the other candidate, and the punch list calls
that field "read by nothing". It stays that way: command contributions do not
reach the renderer at all, so that route means a new IPC channel, whereas
`ViewContributionDTO` already carries `key` and `surface` across
(`packages/app/src/shared/bridge.ts:169-179`). One new optional field on a DTO
that already crosses beats a new channel.

`matchesAccelerator` is already exported from `view-overlay.tsx` and is reused
verbatim, so `CmdOrCtrl` resolves the same way for a pane key as for an overlay
key.

The alternative, a menu item in `menu-template.ts`, is rejected. It would put an
extension's command in the app's own menu template and give up the property ADR
0031 and ADR 0044 were both protecting, that main knows no extension by name.

`⌘⇧N` must not be added to the menu, for the reason `menu-template.ts`'s opening
note gives: a menu item on a key does not compete with a contributed accelerator
on that key, it deletes it silently.

## Undo and redo

**This is a real problem and it is new with this feature.**

`role: 'undo'` and `role: 'redo'` sit in the Edit menu
(`packages/app/src/main/menu-template.ts:73-74`). macOS resolves them before the
page sees the keystroke, and Electron's role calls `webContents.undo()`, which
is the browser's native document undo. CodeMirror keeps its own history in its
state. The two do not know about each other, so ⌘Z in a scratch pane either does
nothing or corrupts the buffer.

No terminal pane ever hit this because xterm has no undo. The editor is the
first thing in the app for which ⌘Z means something.

The fix is the same shape as the close prompt: replace the two roles with
command items that route through the renderer, and have the renderer dispatch to
the focused pane. A terminal pane ignores them, as it does today. A scratch pane
runs CodeMirror's `undo` / `redo` from `@codemirror/commands`.

This is an app-level change, not an extension-level one, and it must land in
this work rather than after it.

## Appearance

The editor is themed from `@shepherd/design-tokens`, not from CodeMirror's
stock themes, and must follow the light and dark palettes ADR 0040 introduced.
Syntax colours come from the token set; no new colours are invented here.

The pane is a document, so it gets a comfortable measure rather than the full
pane width at large sizes, and generous line height. Monospace for code
constructs, the UI text face for prose. A scratch pane should not look like a
terminal wearing a hat.

## Not in scope

Named notes, a picker, a list, search across scratches, export, a file on disk,
tables, images, raw HTML rendering, math, footnotes, reference links, vim mode,
spellcheck, collaborative editing, agent access to the buffer.

**Dynamic tab titles are the flagged regret.** Every scratch pane reads
"scratch" in the tab strip, so three open panes are indistinguishable.

The blocker is narrower than it first looks. `layout.rename` exists and sets a
pane's `userTitle` (`packages/core/src/layout/commands.ts:259`), which is the
field that already beats the OSC title. What is missing is that
`ExtensionPaneProps` carries `state`, `focused`, `invoke` and `done`, and **not
the pane's own id**, so a pane component cannot name the pane it is drawn in.

So the follow-up is one field on `ExtensionPaneProps` plus a debounced
`layout.rename` from the first heading. Deferred by decision, not by difficulty.

## Testing

- **`live-preview.ts` is pure and gets the most tests.** Given a document and a
  selection, it produces a decoration set. That is a function, and the caret
  rule, the construct set, and the tables-stay-literal property are all
  assertions about it with no DOM involved.
- **The parser configuration is asserted directly**: a document containing a
  table, a footnote and a reference link produces no decorations over them.
- **`manifest.test.ts`**, the file every extension has, asserting the typed
  manifest matches `package.json`.
- **Store round-trip**: write, read, close, garbage-collect.
- **The close guard** in the renderer: a scratch pane with text prompts, an
  empty one does not, and `closeGroup` soft-deletes without prompting.
- **The undo routing**: the menu command reaches the focused pane, and a
  terminal pane ignores it.
- jsdom cannot render CodeMirror meaningfully, so the pane component's tests
  cover mounting, id wiring and save debouncing, not layout.

## Risks

1. **Bundle size, unmeasured.** Mitigation is lazy-loading the editor module.
2. **The caret rule is fiddly at boundaries.** Caret immediately after a `**`,
   an empty list item, a fence with the caret on its opening line. These are
   where hand-rolled live preview implementations usually feel wrong, and they
   deserve explicit test cases rather than manual checking.
3. **The undo change touches the app's menu**, which every pane type sees. It
   needs to be provably inert for terminals.
4. **`atomicRanges` interacts with selection**, not just the caret. Select-all
   then type must behave.

## Open

Nothing blocking. Two things deferred by decision rather than by uncertainty:
dynamic tab titles, and whether an agent in a task should be able to read the
scratch buffer.
