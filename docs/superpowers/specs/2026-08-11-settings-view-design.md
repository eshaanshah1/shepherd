# v2 — an extensible settings view

**Status:** designed, not built. **Date:** 2026-08-11.
**Reads on:** [core design](2026-08-06-ade-v2-core-design.md) §4.2 (views), the
[minimal-core sketch](2026-08-06-ade-minimal-core-sketch.md) §2.1 ("declarative
contributions … settings panes") and §7/§7b/§7c, ADR 0020 (one viewing
predicate), ADR 0031 (a row's verbs are the extension's), ADR 0033 (extension UI
is in-proc React and crosses the port as a **name**).

## Why

v2 has no configuration system, and the codebase says so in two places:

- `extensions/agents-core/src/manifest.ts:54` — the quick-tier model override is
  "one key rather than a settings system, because v2 has none".
- `extensions/worktree-hook/src/index.ts:245` — its editor "is a view of its own
  ONLY because v2 has no settings surface yet. When there is one this belongs
  inside it."

So today a user changes the quick-tier model by typing `shepherd agent
quick-model` in a pane, and changes a worktree hook through a ⌘-key overlay whose
gear icon exists only because it sat next to the composer's `+` and the two were
indistinguishable. There is also no way to pick light mode, despite
`@shepherd/design-tokens` shipping a complete, contrast-validated `light` palette
that nothing selects (`DEFAULT_THEME_MODE` is a constant).

The general settings are the smaller half of the need. The larger half is that
**an extension must be able to contribute settings** the way it contributes
rows, glyphs and views — a vendor's extension owning the choice of its own
models, `remote` owning its transport preferences — without the shell learning
what any of them mean. That is the same thesis as everything else in v2: the
shell offers structure, the extension supplies meaning.

## What this is

A full-window **settings screen**: a shell-owned frame (section nav on the left,
a page on the right, a search field, a back arrow) that takes over the window.
The panes it covers stay mounted and keep running; ⌘, raises it and Esc or the
back arrow returns you to exactly where you were. Each extension contributes
**pages of settings** into it, declaratively, from its manifest.

Not a window. Not a region in the layout tree. A layer, like the ⌘K palette,
scaled up to the whole frame.

## 1. The registry

### 1.1 A setting is declared in the manifest

`contributes.settings` is an array of pages, and a page is either a list of
specs or a named component:

```ts
contributes: {
  settings: [
    {
      id: 'agents.models',
      title: 'Models',
      order: 100,
      settings: [
        {
          key: 'agents.quickKind',
          type: 'enum',
          label: 'Quick-tier agent',
          description: 'Which agent answers short, non-interactive questions.',
          default: null,
          choicesFrom: 'agents.quickKindChoices',
        },
      ],
    },
  ],
}
```

A spec is `{ key, type, label, default }` plus optional `description`,
`choices`, `choicesFrom`, `group`, `placeholder`, and per-type bounds (`min` /
`max` for `number`). `type` is one of `boolean | string | number | enum | path`.

A spec may be `nullable`, and `agents.quickKind` above is why: its unset state is
not a missing value but a meaning — "whichever capable kind is first" — that only
the extension can compute. For a nullable spec `null` is a legal value and a
legal default, the row draws an explicit *Default* choice, and validation lets
`null` past the enum-membership check. A spec that is not nullable rejects it.
The set is deliberately small: a widget kind is a promise the shell has to keep
in both themes and at every width, and the escape hatch below is what covers
everything else.

Static, in the manifest, for one consequence that is worth the loss of dynamism:
**the settings screen opens with zero extensions activated.** Values live in the
kernel and defaults live in the manifest, so listing every setting, reading its
current value and writing a new one needs nothing running. Activation stays lazy
by declaration (core-design §4), which it would not if opening ⌘, meant
activating every installed extension to ask it what it can be configured with.

`choicesFrom` is the one dynamic seam: a command id whose answer is
`{ value, label, description? }[]`, invoked when that page is *opened*. That
invocation activates that one extension through the existing `onCommand:` event.
It exists because the honest answer to "which models can I pick" lives in the
vendor's extension and changes without a release, and the alternative is a
hardcoded list that goes stale or a free-text field that accepts typos.

### 1.2 A page may be a component instead

```ts
{ id: 'worktreeHook.editor', title: 'Worktree hooks', component: 'worktree-hook.editor' }
```

This is ADR 0033 unchanged and reused: the string crosses the port, the renderer
resolves it against the static `EXTENSION_UI` table, and the component is handed
the same `ExtensionViewProps` (`invoke`, `done`) an overlay's component gets. A
component page draws its own body inside the frame's page area; the frame keeps
the nav, the heading and the back affordance.

It exists because two of the three real settings in the app today are not rows
of widgets — a per-repo script editor is a small application — and a schema
stretched until it could express one would be a UI toolkit in a JSON file. The
division is: a value the user *picks* is a spec; a value the user *authors* is a
component.

### 1.3 The API

```ts
export interface SettingsAPI {
  /** Never undefined: the declared default backs every read. */
  get<T>(key: string, schema: Schema<T>): T;
  set(key: string, value: unknown): Promise<Result<void, SettingsError>>;
  onDidChange(fn: (key: string, value: unknown) => void): Disposable;
}
```

Lands under `api.proposed.settings`, per §7 — everything lands proposed, and
built-ins are required to consume proposed APIs because that requirement is the
proving ground.

`get` takes a `Schema<T>` for the reason `KV.get` does: the value has crossed a
port and a cast is not a check. Unlike `KV.get` it cannot answer `undefined` —
the registry holds the declared default, so a caller that declared a setting
always has a value, and every "well what if it is unset" branch an extension
would otherwise carry disappears.

**Two rules the host enforces, both already established elsewhere:**

- **A key must sit in the declaring extension's own namespace.** The extension
  does not name its own namespace — the host derives it from the manifest id and
  rejects a page whose keys fall outside it, exactly the way `PointsAPI.define`
  fills in `owner` from the host's own word rather than the extension's claim
  (`packages/sdk/src/points.ts`). A namespace claim an extension makes about
  itself is not a fact.
- **An extension reads and writes its own namespace, and reads `shepherd.*`.**
  Nothing else. A cross-extension read is how D11 gets broken quietly: the
  moment `tasks` can read `claudeCode.model` it has learned which agent it
  hired, and the second kind will not fit. `shepherd.*` is readable because
  theme and its siblings are facts about the app, not about a vendor.

### 1.4 Storage

A `SettingsStore` in `@shepherd/core` over the existing node:sqlite store (ADR
0021), one namespace, key → JSON value.

**Only non-default values are stored, and a write equal to the default deletes
the row.** Two things fall out of that, and both are the reason: "reset to
default" is a real operation rather than a write of today's default frozen
forever, and a default the app *changes* in a later version reaches every
install that never touched the setting. The alternative — materializing every
default on first launch — makes the store a snapshot of one version's opinions.

A write validates against the declared spec (type, enum membership, bounds) and
answers a `Result`. An unknown key is an error, not a stored orphan: the
registry is the authority on what exists, and a store that accepts anything is
how a typo becomes a setting nobody can find.

Change notification is per-key, and the shell subscribes to it rather than
reading back what it just wrote — the CLI is a second writer (§5), and a screen
that trusted its own last write would be stale the moment somebody typed
`shepherd agent quick-model` in a pane behind it.

## 2. The takeover layer

`SettingsScreen`, mounted in `app.tsx` as a sibling of `.sh-body`, painted
opaque over the whole window.

- **The roots stay mounted underneath**, hidden the way the inactive roots
  already are. Never a conditional mount around the stage: a torn-down pane is a
  released terminal and then, on the way back, a second pty (v1's
  `_ConditionalContent` lesson, recorded in `app.tsx`'s own comment). "The window
  gets pushed to the back" is a visual statement; every pty behind it keeps
  running.
- **⌘, is a menu item** (`menu-template.ts` → a `shepherd.settings.open`
  command through `menu-dispatch`), plus a palette entry. It goes in the menu
  because ⌘, is the macOS-standard Settings accelerator and AppKit will consume
  it before the page sees it anyway; contrast an *extension's* accelerator, which
  `ViewOverlay` handles in the page precisely so it is not deleted from every
  terminal in the app.
- **Esc and the back arrow close it**, and closing hands the keyboard back to
  the pane you left via `terminals.focus` — the fix `FindBar` already carries,
  because focus left on a removed element sends the next keystroke nowhere.

### 2.1 It suppresses viewing, and that is load-bearing

While the screen is open, `layout.isViewing` answers `false` for every pane.

This is the "full-takeover overlays" clause `packages/sdk/src/api-layout.ts:88`
already promises and nothing implements yet, and it is the one piece of this
feature that is about correctness rather than UI. `isViewing` is ADR 0020's
single predicate: it decides whether an agent that finishes a turn clears
`need-to-check`, whether a notification fires, whether the phone gets a push. An
agent that blocks while the user is reading settings must notify, and reading
settings must not silently mark a pane as seen.

The takeover state is reported from the renderer into main's existing
`ViewingResolver` inputs, so it composes with app-active, window-focused,
selected root, focus and zoom starvation in the one place they are already
composed. **No second visibility check.** The screen does not tell anybody
"viewing is false"; it tells the resolver one more fact about the window, and the
resolver keeps deciding.

## 3. The frame

**Left nav:** `General` first, then one entry per contributed page, ordered by
`order` then title. A page contributed by an extension is labelled with its
title alone — the extension's name is a subtitle, not a prefix, so the nav reads
as a list of subjects rather than a list of packages.

**Right page:** rows built from specs with `@shepherd/ui` primitives (`Field`,
`Row`, `Menu`, `SectionLabel`). No extension hand-rolls a control — the design
system's rule, and the reason a settings screen assembled from six extensions
can still look like one screen. A row shows its label, its description, its
control, and a reset affordance when its value is not the default.

**Search** filters rows across every page by label and description, and the nav
shows only sections with matches. A component page cannot be searched into (the
shell cannot see inside it) and is listed by title alone — stated because the
alternative is a search that silently omits half the settings.

**A `choicesFrom` page** shows its control disabled with the braille spinner
(`useBrailleFrame` — Rule 7; pulses and shimmer are banned) while the command
runs, and on failure shows the error with the stored value still visible and
editable as free text. A vendor that cannot be asked must not make its setting
unreachable.

## 4. General settings

| Key | Type | Notes |
| --- | --- | --- |
| `shepherd.theme` | enum `dark \| light \| system` | default `system` |
| `shepherd.version` | — | not a setting; a read-only row (version, build, commit) |

**Theme, end to end.** The renderer subscribes to `shepherd.theme`, resolves
`system` through `matchMedia('(prefers-color-scheme: dark)')` — in the renderer,
one place, and it re-resolves on its own when the OS flips — then calls
`applyThemeVariables(root, mode)` **and** re-themes every live xterm instance
with `xtermTheme(mode)`. Both halves, or the chrome and the grid end up on two
palettes, which is the exact failure `theme.ts`'s "one token map" comment exists
to prevent. `DEFAULT_THEME_MODE` becomes the pre-subscription fallback rather
than the answer.

No relaunch. A terminal's theme is a property of its xterm instance, and a
setting that needed a restart to take effect would be the first thing anyone
tried and the first thing that looked broken.

**Deferred, deliberately:** the update checker. v1's is five files plus a design
doc (`UpdateService`/`UpdateInstaller`/`UpdateController`/`IdlePolicy`/
`UpdatePillView`) and porting it is its own piece of work. The General page
leaves room for it and claims nothing.

## 5. The two consumers

§7's graduation rule wants built-ins to be the proving ground, and one consumer
shapes an API to one caller's needs. These two were chosen because they exercise
*both* halves of the seam and because both are already-written comments asking
for it.

**`agents-core` — the schema half, with a dynamic enum.** It contributes an
`agents.models` page with `agents.quickKind` and `agents.quickModel`, both
`choicesFrom` commands that read the registered kinds. So Claude's model ids
reach the screen as **data from the vendor's extension**, and nothing in
`agents-core`, in the shell or in this document names a vendor — the rule that
`agents.resumeTarget` already lives by.

The CLI and the screen become **one value**: `shepherd agent quick-model` writes
through `settings.set` and `resolveQuick` reads through `settings.get`, instead
of the `QUICK_MODEL_KEY` in `ctx.storage`. The existing key migrates on first
read (read it, write it through the settings API, delete it), so a user who
configured a model yesterday finds it selected today. `applyOverride`'s merge
semantics are preserved — setting the model must not move the user back to the
default vendor — which now falls out of the two keys being independent.

**`worktree-hook` — the component half.** It drops `surface: 'overlay'`, its
accelerator and its gear button, and contributes a component page pointing at the
same `worktree-hook.editor` module. The component is unchanged; only where the
shell puts it changes. This is the comment at `index.ts:245` resolved, and it is
the proof that the escape hatch is a real seam rather than a paragraph in a spec.

## 6. What this is not

- **Not a settings file.** No `~/.shepherd/v2/settings.json`, no watcher, no
  precedence rules, no parse-error UI. The store is the authority. A
  human-editable file is a good feature and a separate one; adding it later
  means adding a writer to the API that already exists, not reshaping it.
- **Not per-scope settings.** One global value per key. No per-task, per-repo or
  per-pane override, and no workspace layer. `worktree-hook` already carries its
  own per-repo scoping *inside* its component, which is exactly where a scope
  belongs until a second extension needs one.
- **Not third-party UI loading.** A component page resolves against the static
  `EXTENSION_UI` table, so a third-party extension can contribute
  **schema-driven** settings today (which need no code in the renderer) and a
  component page only once a runtime UI loader exists. That asymmetry is ADR
  0033's, inherited, and it is the argument for the schema half being the
  primary path rather than the fallback.
- **Not a keybindings editor.** v1's Keybindings tab is read-only for a reason;
  rebinding is its own design.

## 7. Testing

**Pure, in unit tests:**

- Namespace enforcement: a page whose keys fall outside the declaring
  extension's namespace is rejected, naming the extension and the key.
- The default/store contract: an unset key reads its default; a write equal to
  the default *deletes* the row; a changed default reaches a never-touched key;
  an unknown key is an error.
- Validation per type, including enum membership against a `choices` list,
  bounds on `number`, and `null` accepted by a nullable spec and refused by
  every other.
- Cross-namespace access: a read of another extension's key fails, a read of
  `shepherd.*` succeeds, a *write* to `shepherd.*` from an extension fails.
- Search filtering, and nav ordering with and without `order`.
- `resolveQuick` / `applyOverride` over the settings-backed values, and the
  `QUICK_MODEL_KEY` migration — including the second read, which must not
  re-migrate.

**In the renderer's component tests:** the screen opens and closes on the
command, Esc closes it, the roots underneath stay mounted (the assertion is on
the pane elements still being in the tree, not on what is visible), a
`choicesFrom` failure leaves the value editable, and a component page receives
`invoke`/`done`.

**In `pnpm smoke:m3`** (a green unit suite is not a working app, and this repo
has the scars): drive the real app, open the screen, change `shepherd.theme`,
assert the `data-theme` attribute *and* an xterm instance's background both
moved, close it, and assert the pty behind it is the same session id it was
before. Plus the invariant no unit test can reach: **while the screen is open,
`isViewing` is false for a pane that is otherwise focused and on screen.** A
test that supplied both halves of that correlation is precisely the class of
test this repo learned not to trust.

## 8. Milestones

1. **Registry + store + API.** Manifest schema, `SettingsStore`, the host facade
   with both access rules, unit tests. Nothing user-visible.
2. **The frame.** Takeover layer, ⌘, and the palette entry, nav, spec-driven
   rows, search, the viewing suppression and its smoke assertion.
3. **General.** `shepherd.theme` wired through chrome and grid, the version row.
4. **The two consumers.** `agents-core`'s page and its CLI/store migration;
   `worktree-hook` moved off `surface: 'overlay'`.

Each step is shippable, and steps 1–3 leave the two extensions exactly as they
are today.
