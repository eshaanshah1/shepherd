# 0048. (v2) The editor owns the working tree, and a save refuses a file that moved

Status: Accepted
Date: 2026-08-24
Scope: `v2/` only.
Extends: [0044](0044-v2-a-pane-may-be-a-contributed-view.md).
Design: [`../../docs/superpowers/specs/2026-08-24-editor-pane-design.md`](../../docs/superpowers/specs/2026-08-24-editor-pane-design.md)

## Context

Every way to look at a file in this app went through a terminal or through a
pull request, and neither is where you edit. `github`'s Files tab was already
the shape the ask describes — `@pierre/trees`' `FileTree` beside
`@pierre/diffs`' `CodeView` — but read-only and scoped to a PR rather than to
the worktree an agent is working in.

ADR 0044 predicted this: *"a diff view, a log viewer and a preview are the
shapes that follow, and none of them needs anything new here."* That held. The
pane needed no kernel change; what it needed were decisions about **files**.

## Decision

**A contributed pane whose subject is a DIRECTORY, saving on ⌘S, refusing a save
whose file changed on disk.**

`shepherd.editor`, a new extension rather than a mode on `github` (whose subject
is a pull request and which carries `@octokit/rest` to have one) or a widening
of `scratch` (one markdown document in key/value storage, with no tree, no path
and no git).

### The save is explicit, and that is not a preference

`scratch` debounces at 400ms. t3code — the closest thing to a reference
implementation, and the same two packages — debounces in
`fileSaveCoordinator.ts`. Both are right for what they hold, and both are wrong
here for one reason: **an agent is editing these files while you are.**

A debounced write fires 400ms after you stop typing. If an agent touched the
file in that window, the write overwrites its work, silently, and the window in
which that is possible is the entire time a task is running — which is all of
the time this pane exists for. Autosave is safe when there is one writer. This
surface exists because there are two.

### The stale-stamp refusal

A read stamps `mtimeMs` and `size`. A save re-stats first and **refuses** if the
stamp moved, answering `stale`; the pane says the file changed on disk, says the
edits are still in the buffer, and offers a reload. There is no merge and no
"which one wins" dialog that discards the loser unseen.

`stale` travels as a `reason` rather than as a thrown error, because it is not
exceptional here and the pane has something specific to do about it — an error
would flatten it into "could not save", losing the only useful part.

**mtime AND size**, because either alone lies: `one` → `two` leaves the size
identical, and two writes in one filesystem tick can leave the mtime identical.
Together they are wrong only for an edit of identical LENGTH inside one tick,
which is the collision this accepts rather than hashing every file on every
read.

### Ignored FILES are in the tree; ignored DIRECTORIES are not

The first draft listed paths with `git ls-files --cached --others
--exclude-standard`. That is gitignore-aware, so it hides `.env` — and an
ignored file is very often exactly the file you opened the editor to change.

The opposite, an unpruned walk, is not available either: `useFileTree`'s `paths`
is a **flat, eager list** with no async-children hook, so the whole set is held
in full and `node_modules` cannot be in it.

The line that resolves it is the one git already draws:

```
git ls-files --cached --others --exclude-standard
git ls-files --others --ignored --exclude-standard --directory
```

`--directory` collapses a fully-ignored directory to a single entry **with a
trailing slash**, so the slash is the whole test, at any depth: keep `.env` and
`*.log`, drop `node_modules/` and `dist/`. Two git calls, no walk, and the
ignored directories never enumerate. A non-git root falls back to a `readdir`
walk that prunes `.git` and caps at 25,000 entries — and a truncated listing
says so, because one that does not reads as complete.

### `git diff` exits 1 when there are differences

An untracked file has nothing in `HEAD`, so it diffs through `--no-index` from
`/dev/null`, which produces a real patch with the `new file mode` line — better
than synthesising one, since git writes the header the renderer wants. But that
call **always** exits 1, because there are always differences. Reading `ok`
alone means no new file ever renders. The patch is taken from `stdout` in both
branches.

### `layout.listRoots` gains `active`

`editor.open` with no argument should open on where you are. Nothing could
answer that: an extension can find the root holding a pane it **owns** (the walk
`scratch` does), but a verb invoked from ⌘K has no pane to start from. Core
already knows — `activeRoot` is the same value `layout.newTab` defaults its
group to — so this is one additive field rather than a second source of truth,
and a caller reading it lands where a caller passing nothing would.

### The diff theme is COPIED from `github`

`diff-theme.ts`, its `unsafeCSS` and the tree's palette overrides are duplicated
into this extension, because the boundary lint forbids importing another
extension's `ui/` and two consumers is not a package. Registering the same theme
name twice is safe: `registerCustomCSSVariableTheme` ends in a map set and both
copies write identical values.

**A third consumer promotes it** into a shared home, with both copies deleted.
The bar is a third, not a second.

## Consequences

- The editor and the diff are **one component under one theme**: `@pierre/diffs`
  ships a real editor (`/edit`, `EditProvider`, `<File edit>`), so no second
  engine and no CodeMirror. The plan was written with CodeMirror in it and that
  was wrong; the shipped `.d.ts` settled it. Note the rename — t3code pins
  `1.3.0-beta.10`, where the prop is `contentEditable` and configuration is
  positional; `1.3.5` is `edit` plus `editorOptions`, and `EditProvider` takes a
  **factory** rather than an instance.
- `@pierre/trees` draws git status itself (`model.setGitStatus`) and filters
  itself (`useFileTreeSearch`), so "Changes" is a filter over one tree rather
  than a second tree with a second selection model.
- **No filesystem watcher.** The tree refreshes on save and on request. A watcher
  over a worktree an agent is writing to is a stream of events during every edit
  it makes. The stale refusal is what makes the absence safe: you cannot lose
  work to a stale tree, only see one.
- Not here, deliberately: cross-file search, staging or committing, rename and
  delete in the tree, LSP, and a split editor.
- `pnpm smoke:editor` is the gate. It asserts the ignored-file line against git
  rather than a captured string, the refusal across a real port, and that the
  extension's module is compiled in — which 800 green unit tests did not
  (see below).

### The failure that is worth reading twice

The unit suite was green, the app booted, and the editor was not in it:
`main/index.ts` registered the manifest and `builtins.ts` had no module for it.
`builtins.test.ts` exists **precisely** for that failure, having been written
after `worktree-hook` hit it — and it passed, because its list of registered
manifests is a THIRD hand-maintained copy that also lacked the new entry.

A guard whose input is maintained by the same hand as the thing it guards is not
a guard. Adding an extension touches three places: `main/index.ts` (twice),
`builtins.ts`, and that literal. All three are now named in the test's comment.
