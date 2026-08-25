# 0049. (v2) A scratchpad is a document without a path

Status: Accepted
Date: 2026-08-24
Scope: `v2/` only.
Extends: [0048](0048-v2-the-editor-owns-the-working-tree-and-a-save-refuses-a-file-that-moved.md), [0033](0033-v2-extension-ui-is-in-proc-react.md).
Design: [`../../docs/superpowers/specs/2026-08-24-editor-pane-design.md`](../../docs/superpowers/specs/2026-08-24-editor-pane-design.md)

## Context

0048 put a second pane in the app that is editable text. `scratch` was the
first. Two surfaces doing what reads as one job is worth an answer rather than a
shrug, and the honest accounting is that most of the differences are earned and
one is not.

| | `scratch.pad` | `editor.workspace` |
|---|---|---|
| Subject | a KV id, no path | a path on disk |
| Engine | CodeMirror 6 | `@pierre/diffs` |
| Save | 400ms debounce | ⌘S |
| Read by | nothing else | an agent, concurrently |

**Subject** is earned: it is the whole difference between a note and a file.
**Cadence** is earned, and the last row says why — the right-hand column has a
second writer (0048). **Engine** is not earned in principle.

## Decision

**A scratchpad is a document that has not chosen a path yet.** `scratch.saveAs`
is the moment it does; the editor's `Notes` root lists the ones that have not.

### `scratch.saveAs`

Writes the buffer to a path under a repo, then closes the KV row. Three things
about it:

- The row goes **after** the file exists. Dropping it first and failing the
  write would lose the note entirely, which is the one outcome this verb must
  not have.
- `close`, not `delete`, so even a mistake stays recoverable for the seven days
  `GC_MAX_AGE_MS` already promises.
- It **refuses an existing file**. Saving a note is creating a document;
  replacing one the user already has is a different verb with a different
  confirmation, and this is not it.

### `Notes` in the editor's tree, and a row that opens its own tab

The rows sit above the repo roots and clicking one **reveals its own
`scratch.pad` tab** rather than rendering inside the editor pane.

That is forced — the boundary lint stops `@shepherd/ext-editor` importing
`@shepherd/ext-scratch/ui`, and the pane table resolves one name to one
component — and the restriction turns out to be the honest design. A note is its
own place, not a file in a repo that happens to have no path. What the root buys
is one tree listing everything in the task you can edit.

The note's **id rides in the tree path** because the tree is keyed by path: two
notes both titled `Notes` would collapse into one row and the second would be
unreachable. A slash in a title is flattened for the same class of reason — it
would fake a directory whose leaf resolves to no note at all. A row is matched
back against the notes actually held rather than parsed, so a `Notes/…` row
whose document has since been saved or closed resolves to nothing rather than to
a dead id.

Notes appear in **Files** and not in **Changes**: a note has no `HEAD` to differ
from, so a row there could never have a diff beside it.

### Two new commands, and one that was not the one it sounded like

`scratch.list` — the KV is keyed by id and nothing had ever needed to enumerate
it, because a pane always arrived already holding one.

`scratch.reveal` — **not** `scratch.open`, which is the ⌘-click-a-link verb and
takes an http URL. Something that lists notes needs a way to send you to one,
and the name that suggested it was already spent.

Both are untitled: one is a read with no effect, and the other only makes sense
with an id nobody can type.

### The engines are NOT unified

Scratch's value is its live preview — CodeMirror decorations that hide a
heading's `#` when the caret leaves the line and swap a `- [ ]` for a real
checkbox. `@pierre/diffs`' `File` is a shiki code renderer with no decoration
surface to port that onto. Rewriting four thousand working lines to change
nothing the user sees is not a reconciliation.

### Naming: `Notes`, not `Scratch`

The rail's `Scratchpad` section is loose **shells** (ADR 0047); a scratch pane is
a markdown **document**. A third thing called scratch would make the word mean
nothing.

## Consequences

- The two panes stay two panes, joined by a verb and a listing rather than
  merged. Each keeps the cadence its subject deserves.
- **What is deferred:** a *document-surface contribution point* — a third
  resolution table beside `EXTENSION_PANE_UI`, where an extension registers a
  surface for a kind of file and the editor pane resolves markdown to scratch's
  live preview. One tab, and `README.md` gets checkboxes. That is the real
  unification, and it is a new public seam with one consumer. **A second
  consumer buys it**; the `Notes` root is what upgrades into it. Written down
  here so the next person finds a decision rather than an omission.
- `scratch.list` is public surface now, so its shape is a compatibility
  question: `{ docs: [{ id, title, updatedAt }] }`, live rows only, newest
  first.
