# The editor pane: a file tree, an editor, and your changes

Date: 2026-08-24
Scope: `v2/` only. Nothing under `spike/` is touched.
Status: **designed, not built.**

## What this is

A tab you open on a task. Down the left, the files of its worktrees. On the
right, the file you clicked — editable, syntax-highlighted, saved with ⌘S. A
second mode over the same two panels shows what you have changed against `HEAD`,
as diffs.

It is the surface the app does not have: every way to look at a file today goes
through a terminal or through a pull request. Neither is where you edit.

## The one thing worth reading first

**`@pierre/diffs` and `@pierre/trees` are already dependencies of
`@shepherd/ext-github`, and between them they do almost all of this.** The
Files tab of the review pane (`extensions/github/ui/pr-panels.tsx`) is already a
Pierre `FileTree` beside a Pierre `CodeView` — the same two panels this asks
for, read-only and scoped to a PR instead of to your working tree.

What was not obvious, and what changed this design twice:

1. **`@pierre/diffs` ships a real editor.** `@pierre/diffs/edit` exports
   `Editor`, `TextDocument`, `EditorKeymap` / `EditorCommand` /
   `EditorShortcut`, undo, and state persistence; `@pierre/diffs/react` exports
   `EditProvider`, `useCreateEditor`, and `<File edit editorOptions={…}>`. So
   the editor and the diff view are the same component with the same shiki
   highlighting under the same registered theme, rather than two renderers that
   have to be made to look alike. **This design was written once with CodeMirror
   in it and that was wrong.**

   Confirmed against the shipped types in `@pierre/diffs@1.3.5`
   (`dist/edit/index.d.ts`, `dist/react/File.d.ts`) and against `t3code`, which
   is the same shape end to end — `apps/web/src/components/files/FilePreviewPanel.tsx`
   mounts `<File contentEditable>` inside an `<EditProvider>` and the repository
   contains no CodeMirror and no Monaco anywhere. Note the rename: t3code pins
   `1.3.0-beta.10`, where the prop is `contentEditable`; in `1.3.5` it is `edit`,
   with editor configuration moved to `editorOptions`.

2. **`@pierre/trees` draws git status itself.** `FileTree`'s model has
   `setGitStatus(entries)` and the options take `gitStatus` — modified, added and
   untracked marks on the rows are a call, not a feature. `useFileTreeSearch` is
   likewise already there, which is what filters the tree instead of a control
   this design would otherwise have specified.

The consequence is that the build is mostly a service half — listing paths,
reading and writing files, and asking git questions — plus a pane that wires
two components that already exist to it.

## Why a new extension

`shepherd.editor`, a new directory beside `github` and `scratch`.

Not a mode on `github`: that pane's subject is a pull request, and it carries
`@octokit/rest` to have one. An editor that opened through it would drag a
GitHub client into a surface that never talks to GitHub, and would inherit a
subject (`repo#number`) that has nothing to do with the file you want to edit.

Not a widening of `scratch`: that extension is one markdown document held in
key/value storage, with no tree, no path and no git. Growing it into a repo
browser makes it two extensions sharing a manifest. What the two should share is
covered under **Reconciling with the scratchpad** below, and it is not this.

## The pane

A contributed view with `surface: 'pane'` (ADR 0044), registered as
`editor.workspace`, following `github.review`'s registration exactly:
`kind: 'component'`, a `title`, and an `icon` for the slot a terminal tab draws
its agent state in.

### The subject

```ts
interface EditorPaneState {
  /** The directory the tree is rooted at. */
  readonly root: string;
  /** The document that was open, so a reopened tab lands where you left it. */
  readonly doc?: string;
}
```

`state` is the subject and never the contents (ADR 0044). A restored editor pane
re-lists its tree and re-reads its file from disk; it does not restore a
three-week-old buffer. **Unsaved buffers are not persisted** — a store of
path-less edited text is a document store, and the app has one of those already.

`root` defaults to the focused task's synthesized root, so the tree spans the
task's repos. `editor.open` takes an optional `path` for anything else. Read
through the same `tasks.list` seam `github` uses (`extensions/github/src/tasks-read.ts`):
the answer is `unknown` and is read rather than cast, and a task with no root is
dropped rather than defaulted.

Re-invoking the command finds the open tab **by asking `layout` what it holds**,
not by remembering what it opened — a record of our own is wrong the moment you
close the tab, and wrong again across a relaunch. `github.review` established
this; there is no reason for a second answer.

## The file tree

`useFileTree({ paths, density: 'compact' })` takes a **flat, eager list of
paths**. There is no async-children hook, so the whole path set is computed by
the service half up front. That single fact drives everything below.

### `.env` must be in the tree, and `node_modules` must not

The first version of this design listed paths with
`git ls-files --cached --others --exclude-standard`, which is gitignore-aware
and therefore hides `.env`. That is wrong: an ignored file is very often exactly
the file you opened the editor to change.

But the opposite — an unpruned walk — puts a hundred thousand `node_modules`
entries into a list that has to be built and held in full.

The distinction that resolves it is **ignored files versus ignored
directories**. `.env`, `.env.local` and `*.log` are ignored files you edit;
`node_modules/`, `dist/` and `.next/` are ignored directories you never open.
Git will draw that line itself:

```
git ls-files --cached --others --exclude-standard
git ls-files --others --ignored --exclude-standard --directory
```

The first is tracked plus untracked. The second is the ignored set with
fully-ignored directories collapsed to a single entry — `--directory` is exactly
that behaviour — so it answers `node_modules/`, `dist/`, `.env`. **Keep the
entries with no trailing slash.** Two git calls, no walk, and the ignored
directories never enumerate.

For a `root` that is not a git repository, fall back to a `readdir` walk that
prunes `.git` and stops at a cap. t3code caps its index at 25,000 entries
(`WORKSPACE_INDEX_MAX_ENTRIES`), which is a reasonable number to borrow; a
truncated listing must say so in the pane rather than silently show a partial
tree.

For a multi-repo task, each repo's paths are prefixed with the repo's name, so
the tree has one root per repo under the task root.

### Git status is Pierre's

`git status --porcelain` per repo, mapped to `GitStatusEntry[]` and handed to
`model.setGitStatus(...)`. The rows draw their own marks. Refreshed on save and
on an explicit refresh; **not** watched — see **What is deliberately not here**.

### Filtering to what changed

`useFileTreeSearch` is the package's own filter, and the changed-file view is a
filter rather than a mode switch on the tree: the same tree, narrowed to the
paths `git status --porcelain` named. An earlier draft specified a separate
"Changes mode" for the tree; the search hook makes that a control, not a second
code path.

## Editing

`<File edit editorOptions={…}>` inside an `<EditProvider editor={editor}>`, with
the editor built by `useCreateEditor` and disposed on unmount. Wrapped in
Pierre's `Virtualizer`, as t3code wraps it, so a large file does not render in
full. The theme is the one `extensions/github/ui/diff-theme.ts` already
registers, so a file and its diff are the same surface with the same colors.

`editor.read` and `editor.write` are the only filesystem verbs. Extensions use
`node:fs` directly and no permission covers it — `extensions/scratch/src/install.ts`
records why: fs and path are stdlib, and the grant that matters is
`process.exec`, which this extension needs anyway for git.

### ⌘S, and why not autosave

Dirty is marked on the tree row and on the tab. ⌘S writes.

t3code autosaves on a debounce (`fileSaveCoordinator.ts`), and `scratch`
autosaves at 400ms. Both are right for what they hold. This is not: **an agent
is editing these files while you are.** A debounce that fires 400ms after you
stop typing will overwrite an agent's edit without either of you seeing it
happen, and the window in which that is possible is the entire time a task is
running — which is all of the time this pane exists for.

### The stale-file refusal

A read stamps `mtimeMs` and `size`. A save re-stats first, and **refuses** if the
stamp no longer matches, saying the file changed on disk and offering to reload.
No merge, no silent clobber, no "which one do you want" dialog that discards the
loser without showing it.

This is the common case here, not an edge, and it is the one behaviour in this
design that has no equivalent in either reference implementation — because
neither of them has an agent writing the same working tree.

## The changes view

`git diff HEAD -- <path>` per changed file, through the identical path
`pr-panels.tsx` already runs: `processFile(patch, { cacheKey, isGitDiff: true })`
into a `CodeView`. Untracked files have no diff against `HEAD`, so they get a
synthesized all-added patch — `extensions/github/src/model/patch.ts` already
builds one, and records why `@pierre/diffs` refuses a patch that does not say
which file it is.

Clicking a tree row **scrolls** the diff list to that file rather than replacing
it, which is what the Files tab does and for the stated reason: everything is on
screen in one scroll, so a click is a request to be taken somewhere.

### The duplication this accepts

`diff-theme.ts`, the SVG sprite sheet and the untracked-patch synthesizer live in
`@shepherd/ext-github`, and the boundary lint forbids one extension importing
another's UI (`extensions/README.md`; the `github` → `tasks` relationship is
type-only for the same reason). So roughly seventy lines are **copied** into
`@shepherd/ext-editor`.

That is deliberate. Two consumers is not a package. The ADR should record that a
**third** consumer promotes the diff theme and the patch synthesizer into a
shared home, so the next person meets the decision rather than the duplicate.

## Reconciling with the scratchpad

Two panes in one app that are both "editable text" is worth an answer rather
than a shrug. The answer is that most of the differences are earned and one is
not.

| | `scratch.pad` | `editor.workspace` |
|---|---|---|
| Subject | a KV id, no path | a path on disk |
| Engine | CodeMirror 6 | `@pierre/diffs` |
| Save | 400ms debounce | ⌘S |
| Read by | nothing else | an agent, concurrently |

**Subject** is earned: that is the whole difference between a note and a file.
**Cadence** is earned, and the table says why — the right-hand column has a
second writer. **Engine** is not earned in principle: it is two editors where
one would do. It is still not worth fixing. Scratch's value is its live
preview — CodeMirror decorations that hide a heading's `#` when the caret leaves
the line and swap a `- [ ]` for a real checkbox — and Pierre's `File` is a shiki
code renderer with no decoration surface to port that onto. Rewriting four
thousand working lines to change nothing the user sees is not a reconciliation.

There is also a hard constraint: **the editor pane cannot mount scratch's
component.** The boundary lint stops `@shepherd/ext-editor` from importing
`@shepherd/ext-scratch/ui`, and the pane-component table resolves one name to one
component.

So what ships here is the seam, not the merge.

### 1. A verb between them

`scratch.saveAs` — write the document's text to a path under the task's
worktree, drop the KV row, open the result in the editor pane. The reverse is
not built: a file you want to scribble on is a file, and `scratch.create` is
already one keystroke.

This is small, and it says the useful thing out loud: **a scratchpad is a
document that has not chosen a path yet.** Saving it is the moment it does.

### 2. `Notes` as a root in the editor's tree

Above the repo roots, a `Notes` root listing the live scratch documents. Clicking
one **opens or focuses its own `scratch.pad` tab** — it does not render inside
the editor pane. That respects the boundary without inventing anything, and it is
honest about what a note is: its own place, not a file in a repo that happens to
have no path.

What it buys is a single tree that lists everything in the task you can edit.

This needs one thing `scratch` does not have: a **`scratch.list`** command. The
manifest today contributes `create` / `read` / `write` / `close` / `open` /
`skillTargets` / `installSkill`, and nothing that answers "what documents are
there" — the KV is keyed by id and only a pane that already holds one ever asks.
`editor` reads its answer across the command port the way `github` reads
`tasks.list`: `unknown`, read rather than cast, and a row with no id dropped
rather than defaulted. `editor`'s manifest declares `shepherd.scratch` as a
dependency, which is the gate a value import would route around.

**Naming.** The rail's `Scratchpad` section is loose *shells* (ADR 0047) and a
scratch pane is a markdown *document*. A third thing called scratch in the
editor's tree would make the word useless. Hence `Notes`.

### 3. What this upgrades into, and is not

A **document-surface contribution point**: a third resolution table beside
`EXTENSION_PANE_UI`, where an extension registers a surface for a kind of file
and the editor pane resolves markdown to scratch's live preview — one tab, and
`README.md` gets checkboxes.

That is the real unification and it is deliberately **not in this spec**. It is a
new public seam on one consumer, and it needs its own ADR. Item 2 is what
upgrades into it when something asks a second time. Written down here so that
the next person finds a decision instead of an omission.

## What is deliberately not here

- **A filesystem watcher.** The tree and the status marks refresh on save and on
  an explicit refresh. A watcher over a worktree an agent is writing to is a
  stream of events during every edit it makes, and the pane has nothing useful to
  do with most of them. The stale-file refusal is what makes the absence safe —
  you cannot lose work to a stale tree, you can only see one.
- **Cross-file search.** `useFileTreeSearch` filters paths. Content search is a
  different feature with a different index (t3code carries a native one,
  `@ff-labs/fff-node`) and it is not what was asked for.
- **Staging, committing, or anything that writes to git.** The pane reads git and
  writes files. `git` is the terminal's, and the terminal is one pane away.
- **Rename, delete, and drag in the tree.** `@pierre/trees` supports all three.
  None of them is "make a change and view it", and each is a destructive verb
  that wants a confirmation story this does not have.
- **LSP, completion, go-to-definition.** Not what Pierre's editor is, and the
  agent in the next pane is the reason you are not typing most of this anyway.
- **A split editor, or more than one document open in the pane.** The tab strip
  is the app's answer to "two things at once".

## Testing

`vitest` with `jsdom`, following `github` and `scratch`. The service half is pure
functions over command output wherever it can be, because that is what makes the
interesting assertions cheap:

- **Path derivation.** Given the two `git ls-files` outputs, the tree gets
  `.env` and does not get `node_modules`. This is the test that would have caught
  the first draft.
- **Multi-repo prefixing**, and the non-git `readdir` fallback including its cap
  and its truncation flag.
- **Status mapping.** `git status --porcelain` in, `GitStatusEntry[]` out,
  including renames and untracked.
- **The stale-stamp refusal.** Read, mutate the file underneath, save, assert the
  write did not happen and the reason reached the caller. The single most
  important test here.
- **Untracked patch synthesis**, against the same fixtures `github`'s already
  uses.
- **Pane render**, in both the editing and the changes view, with the jsdom gaps
  `extensions/github/ui/jsdom-gaps.ts` already patches — `CodeView` constructs a
  `ResizeObserver` during setup.
- **`scratch.saveAs`**: the row leaves the KV, the file exists, the editor opens
  on it.

## ADRs this should produce

1. **The editor pane owns the working tree, and a save refuses a file that moved
   under it.** The cadence decision and the stale-stamp refusal, with the reason
   both differ from `scratch` and from t3code: a second writer.
2. **A scratchpad is a document without a path.** Items 1 and 2 of the
   reconciliation, and item 3 recorded as the upgrade a second consumer buys.

The copied diff theme is a consequence noted inside ADR 1 rather than an ADR of
its own — it is a cost accepted, not a decision made.
