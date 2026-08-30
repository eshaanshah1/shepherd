# 0051. (v2) A face is a way of reading a subject the shell already has

Status: Accepted
Date: 2026-08-30
Scope: `v2/` only.
Extends: [0044](0044-v2-a-pane-may-be-a-contributed-view.md), [0033](0033-v2-extension-ui-is-in-proc-react.md), [0049](0049-v2-a-scratchpad-is-a-document-without-a-path.md), [0050](0050-v2-a-composer-is-a-screen-because-a-card-is-a-claim-about-size.md).

## Context

The takeover makes the window an attention router: Home triages, and entering a
task means the window *is* that task — a 48px band and, under it, the work. The
band offers four faces of one subject: **Agents**, **Diff**, **Intent**,
**Files**.

`Agents` is free. It is the stage, which the takeover deliberately does not
paint over, so the real panes stay mounted with their ptys attached.

The other three are not. Two of them already exist as contributed PANE views —
`editor.workspace` and `github.review` — and the third is a document `tasks`
holds and has never drawn. So the question is how a shell that must not know
which extensions it has gets a body under the tab it drew.

Three ways were considered and each broke something load-bearing.

**Mount `ExtensionPane` inside the face.** `ExtensionPaneProps` requires a
`paneId`, because a pane can be asked about before it closes and the claim has
to name the leaf it belongs to. A face has no leaf. Synthesizing one produces a
pane id the layout has never heard of, and every verb the view invokes about
"its" pane then misses — silently, since a command about an unknown pane is not
an error the page can see.

**Resolve the slot in the shell** — `face === 'diff' → github.review`. This is
the shell having learned which extension it hired. It is the same rule that
keeps a vendor's name out of `tasks` (D11, `agents.resumeTarget` and not
`claudeCode.resumeTarget`), and the same rule that made extension UI cross the
port as a NAME in the first place (0033). A shell that can name one extension
can name any of them, and the second kind will not fit.

**Open the surface as a pane in the task's root.** Reuses everything and is
wrong about what the user asked for: a face would then be a pane *among* the
agents rather than the body of the window, and pressing `2` would split the
screen instead of turning the page.

## Decision

**A fifth surface: `face`.** A component declares

```ts
{ kind: 'component', component: 'github.taskDiff',
  surface: 'face', face: { slot: 'diff', subject: 'task' } }
```

and the takeover draws one tab per slot **that something claims**.

Four consequences, each a rule:

- **A slot is claimed, never assigned.** A build without `github` has no Diff
  tab. That is the honest failure and it is the whole point: the shell never
  resolves a slot to a view type whose name it knows. A slot claimed twice keeps
  the FIRST claim — two extensions both saying they are the diff cannot be
  settled on merit, and taking the last would make the answer depend on
  activation order, which is the failure `head` was written to prevent one layer
  down.
- **A key is a POSITION, not a face.** With no Diff tab, `2` is Intent. A key
  bound to a face that is not drawn is a keystroke that appears to do nothing.
- **A face is not a place.** `1`–`4` swap what you are reading inside a task;
  `esc` leaves the task. The four are one subject seen four ways, and a history
  of them would make `esc` mean two different things depending on which tab you
  arrived on.
- **The body is edge to edge.** The component owns the whole rectangle under the
  band the way a pane owns its leaf. A document drawn inside a card is the window
  claiming the document is a widget, which is the shape the takeover replaced.

**A fourth props table**, `EXTENSION_FACE_UI`, beside the dock's, the row's and
the pane's. `ExtensionFaceProps` is `ExtensionViewProps` plus one field, and the
three absences are the design:

- **No `paneId`** — there is no leaf. This is the whole reason a face could not
  be squeezed into the pane table.
- **No `state`** — the subject was not minted when the view opened. A pane's
  state is a subject it chose; a face's subject is handed to it.
- **No `focused`** — a face is the whole body of the window and has no sibling
  to lose a keystroke to, so the flag would be a constant `true` and an
  invitation to write the branch that reads it.

`done()` keeps its meaning and loses its effect: a face has nothing to close, and
it is ignored rather than refused, exactly as a dock section already ignores it.
A component should not have to know which surface it landed on to be correct.

**This is 0049's deferred contribution point.** That ADR named "a
document-surface contribution point (a third table beside `EXTENSION_PANE_UI`)"
as a thing a SECOND consumer would have to buy. The takeover is that consumer,
and it arrives with three claims rather than one — which is the bar 0050 also
had to clear.

## Consequences

The three faces are wrappers, and deliberately:

- `github.taskDiff` renders `WorkingChanges`, which was already task-scoped
  (`github.changes { task }`). There is one idea of what a task changed, and the
  face is a claim on the slot rather than a second implementation of it.
- `editor.taskFiles` renders `EditorPane` over the task's directory, so a file
  and its diff stay one surface under one theme (0048). `EditorPane`'s props
  narrowed to `EditorSurfaceProps` — a `Pick` of the three it actually reads — so
  the face does not have to invent the `paneId` this ADR exists to refuse.
- `tasks.intent` draws the brief off the record. It is the only face whose
  subject its own extension already holds, and the reason it is worth having: a
  brief is typed once at the composer and then appears nowhere. Three days in,
  "what did I actually ask for" had no surface, and the transcript is not it —
  that is what the agent did, at length, and the ask is one paragraph.

Each face resolves its own subject from the task id, by asking a command its own
extension may invoke — `editor` and `github` both already declare `TASKS_ID` in
`dependencies`, which is §7c's "declared, not discovered". The shell hands over
the task and learns nothing about what any face does with it.

**Five layers had to be touched and all five are load-bearing**: the SDK
declaration, `ext-host/api.ts`'s serializer, the wire schema in
`shared/ext-protocol.ts`, main's handler, and `view-registry.ts`. That is the
`head` trap in another costume — a serializer that names its fields silently
discards the one nobody added to it, and every layer but the wire then agrees
the feature works. The wire schema is a strict `s.object`, so a field SENT but
not NAMED there costs the whole registration: the tab would not be misplaced,
the view would not register at all. `runtime.test.ts` pins both halves, and the
assertion was mutation-checked against a serializer with the field removed.

`view-registry.ts` also had `surface` typed `'dock' | 'overlay' | 'pane'` long
after `screen` shipped, and the value crossed anyway because that file only
spreads it. A type that lags does not break anything until somebody reads it,
and then it lies. It is one exported `ViewSurface` now, used by both interfaces
there.

### What is still open

`subject` is `'task'` and only `'task'`. It is stated rather than assumed so the
second subject — a repo, a pull request — arrives as a value on that field
rather than as a second field meaning the same thing. Nothing should add one
until something needs it; that is the bar 0049 set and this ADR is the result of
it being met.
