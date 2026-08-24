# A scratch pane that is a skill

A markdown scratch pane whose document is a valid `SKILL.md` says so, and offers
to install itself. The tab wears a skill glyph and the skill's name; a control at
the trailing edge of the tab strip writes the file into `~/.claude/skills` or into
a repo.

Design canvas: <https://claude.ai/code/artifact/26583461-6088-444d-83ce-2982b9394f7f>

## What is being added, and where

| piece | lives in |
|---|---|
| a pane publishing its own glyph and actions | `packages/core/src/layout` |
| the tab strip drawing them | `packages/ui`, `packages/app/src/renderer` |
| frontmatter parsing and validation | `extensions/scratch/src/skill.ts` |
| writing the skill directory | `extensions/scratch/src/install.ts` |
| the frontmatter's rendered form | `extensions/scratch/ui/frontmatter.ts` |
| the level and provider dialog | `extensions/scratch/ui/install-dialog.tsx` |

## 1. A pane publishes what it is and what it offers

`app.tsx` resolves a tab's glyph from the view-type contribution, so every pane of
one type wears one glyph. A scratch pane needs two, decided by its own contents.

`layout.rename` gains two optional fields:

```
layout.rename { pane, title, icon?: string | null, actions?: PaneAction[] }

PaneAction = { id: string, label: string, glyph: string, command: string }
```

The verb was chosen over a sibling `layout.setIcon` because the scratch pane
already calls it on every heading change, so a second command would fire on the
same edit and leave a window where the tab wore a skill glyph and a scratch name.

**Absent means leave alone; `null` and `[]` mean clear.** A palette rename passes
only `title`, and must not wipe a glyph it knows nothing about.

**Neither field persists.** `serialize.ts` keeps what survives a relaunch and
drops what a running program produced: `userTitle` persists, the OSC `title` does
not. A glyph derived from a document's contents is the second kind, and the pane
already re-publishes on mount (`scratch-pane.tsx` retitles from the read, not only
from edits). Actions are stronger still: an action names a command that exists
only while its extension is active, so a persisted one would draw a button that
invokes nothing.

`store.rename` grows the two optional arguments. `PersistedPane` is untouched, and
that is the assertion worth writing: a layout holding a skill pane round-trips
byte-identical to one written before this existed.

### The renderer

`app.tsx`'s icon resolution reads the focused pane's own `icon` first and falls
back to the view type's. Both still go through `namedGlyph`, so an extension
cannot name a picture the build never saw, and `declared-glyphs.test.ts` fails
until the allow-list carries `skill`.

Actions reach `TabStrip` as a new `actions` prop and draw before `__new`, which is
already pinned to the trailing edge with `margin-inline-start: auto`.

### One thing deliberately not done

`layout.rename` now writes more than a name. The honest fix is to call it
`layout.present`, and that is its own change: the verb is a palette entry, a CLI
verb and a keybinding, and folding a rename into this work would put a migration
in the middle of a feature.

## 2. Detection

`src/skill.ts` is pure and takes the document text.

A document **is a skill** when it opens with a `---` fence holding parseable YAML
carrying both `name` and `description`. Nothing else qualifies it. That is Claude
Code's own requirement, and the pane must not refuse to install a file Claude Code
reads happily.

Everything else is a **warning**, never a refusal:

- `name` outside `[a-z0-9-]+`, reported with the slug it will install as
- `description` over 200 characters, reported with the count
- `tags` or `requires` present but not a list of strings

The YAML subset parsed is what frontmatter actually uses: `key: value`, folded
(`>`) and literal (`|`) blocks, and flow sequences (`[a, b]`). A key this parser
cannot read is carried through unexamined rather than failing the document. No
YAML dependency: `extensions/*/src` imports the SDK and stdlib only, and a
frontmatter block is not a reason to vendor a parser.

## 3. Install

Two commands.

`scratch.skillTargets` answers where a skill can go: `~/.claude/skills` always,
then one entry per repo of the task owning this tab, read through
`extensions.get<TasksAPI>(TASKS_ID)`. A scratch pane in a plain tab gets the user
level and nothing else, plus the caller's own option to name a folder.

`scratch.installSkill { id, level, providers, overwrite? }` writes
`<target>/<name>/SKILL.md` with `mkdir -p`. An existing directory refuses with a
reason rather than overwriting; the caller re-invokes with `overwrite: true`. The
manifest needs no new permission: `node:fs` is stdlib and allowed in an extension
by `boundaries.js`.

`providers` is a list today holding one value, `claude-code`. It resolves to the
`.claude/skills` path fragment, which is the only thing a provider currently
decides.

## 4. The rendered frontmatter

`ui/frontmatter.ts` adds a `live-preview.ts` decoration: the `---` fences hide,
keys draw at `textMute` in the small step, values at the document's own size, and
`name` draws mono because it becomes a directory. The block closes with a
hairline.

The existing rule holds without amendment: **the block renders raw when the
selection touches it.** Frontmatter is a block construct, so the unit is the line,
which is what `BLOCK_CLASS` already means.

A warning renders as a quiet sentence under the row that produced it, one step
down the ink ramp. Not red: `red` means a run that failed, and a 212-character
description is a file that works.

## 5. The strip control and the dialog

`Button variant="secondary" size="sm"` fused to an `IconButton` chevron inside one
`lineStrong` box. Secondary rather than primary because a wool fill in a strip
beside three tabs is the loudest thing in the window, and the one primary belongs
to the dialog.

The chevron opens a `Menu` of levels and installs straight to one. The label opens
`InstallDialog`: a `Modal` holding the target path, a `Select` of levels, a
checkbox per provider, and the primary.

**`modal.css` will clip the Select's list.** The card sets `overflow: auto`, which
makes it a scroll container, and the only carve-out coded is
`:has(.sh-ui-composer)`. The dialog needs its own, written beside that one and for
the same stated reason.

## Error handling

Every failure is a sentence on the surface that caused it. The dialog holds a
problem line, the way `review.tsx` does, because each verb here fails for reasons
only the far side knows: a directory that exists, a path that is not writable, a
task whose repo moved. A refusal is a success carrying a reason, not a thrown
error, which is the convention `scratch.open` already follows.

Losing detection is not an error. The pane publishes the heading title, no glyph
and no actions, and the strip empties itself.

## Testing

- `skill.ts`: unit tests over the detection boundary and each warning. Pure input,
  pure output.
- `install.ts`: tmpdir tests, seeded the way `provision.test.ts` seeds
  `.claude/skills`. Covers the fresh write, the refusal on an existing directory,
  and the overwrite.
- `serialize.test.ts`: a pane carrying a glyph and actions round-trips without
  them, and the payload is unchanged.
- `store.test.ts`: absent leaves, `null` clears, a palette rename preserves the
  glyph.
- `tab-strip.test.tsx`: actions draw before `__new`; a strip with none is
  unchanged.
- `declared-glyphs.test.ts` and `refusals.css.test.ts` cover the new glyph name
  and the new CSS with no new test written.
