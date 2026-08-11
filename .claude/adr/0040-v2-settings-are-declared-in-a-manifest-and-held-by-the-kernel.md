# 0040. (v2) Settings are declared in a manifest and held by the kernel

Status: Accepted
Date: 2026-08-11
Scope: `v2/` only.
Design: [`docs/superpowers/specs/2026-08-11-settings-view-design.md`](../../docs/superpowers/specs/2026-08-11-settings-view-design.md).

## Context

Two comments in the codebase asked for this, and both named the thing they were
standing in for:

> One key rather than a settings system, because v2 has none — there is no config
> API in core and no counterpart to v1's `SettingsView`. When one lands this
> becomes a row in it and no consumer changes.
> — `extensions/agents-core/src/manifest.ts`, of `QUICK_MODEL_KEY`

> The editor — a view of its own ONLY because v2 has no settings surface yet. When
> there is one this belongs inside it.
> — `extensions/worktree-hook/src/index.ts`, of its ⌘⇧H overlay

So the quick-tier model was reachable only by typing `shepherd agent quick-model`
in a pane, a worktree hook only through a ⌘-key overlay whose gear icon existed
because it sat beside the composer's `+` and the two were indistinguishable, and
light mode was unreachable at all — `@shepherd/design-tokens` has shipped a
contrast-validated `light` palette since M0 that nothing ever selected.

The larger half of the need is not the app's own settings. It is that an extension
must be able to contribute settings the way it contributes rows, glyphs and views:
a vendor owning the choice of its own models, `remote` owning its transports — with
the shell learning nothing about what any of them mean.

## Decision

Three decisions, each of which a later change will otherwise re-litigate.

### 1. A setting is declared statically in the manifest, not registered at activate time

`contributes.settings` is data in `package.json`, beside `contributes.commands`.
Registration inside `activate` was the alternative, and it is the one that matches
`views.registerViewType`.

It was rejected for one consequence: **the settings screen opens with zero
extensions activated.** Values live in the kernel and defaults live in the
manifest, so listing every setting, reading its current value and writing a new one
needs nothing running. Activation stays lazy by declaration (core-design §4), which
it would not if opening ⌘, meant activating every installed extension to ask what
it can be configured with.

`SettingSpec.choicesFrom` is the one dynamic seam — a command id whose answer is a
list of choices, invoked when that page is *opened*, which activates exactly one
extension through the `onCommand:` event it already declares. It exists because the
honest answer to "which models can I pick" lives in the vendor's extension and
changes without a release; the alternatives were a hardcoded list that goes stale
and a free-text field in which a typo is indistinguishable from a retired model.

A page may instead name a **component** (ADR 0033's static UI table, reused whole).
The division: a value the user *picks* is a spec; a value the user *authors* is a
component. `worktree-hook`'s script editor is a small application, and a schema
stretched until it could express one would be a UI toolkit in a JSON file.

### 2. Only non-default values are stored

`SettingsRegistry` writes a row only when a value differs from its declared
default, and a write equal to the default *deletes* the row.

Two things follow, and both are the reason rather than a side effect: "reset to
default" is a real operation rather than a write of today's default frozen forever,
and a default the app **changes** in a later version reaches every install that
never touched the setting. Materializing defaults on first launch — the obvious
alternative — makes the store a snapshot of one version's opinions.

An unknown key is an error, not a stored orphan: the registry is the authority on
what exists, and a store that accepts anything is how a typo becomes a setting
nobody can find and nothing can reset.

### 3. The takeover feeds `presence.overlay`; it does not check visibility itself

The settings screen is a layer over `.sh-body`, and whether it is open is owned by
**main** (`window.settings`), not by the renderer. That is what makes four gestures
one fact — the ⌘, menu item, the ⌘K palette entry, `shepherd raw window.settings`,
and Esc inside the screen — and it is ADR 0035's rule about not keeping a second
copy of "what is on screen", which this codebase has now broken twice.

The load-bearing half is that the same value feeds `ViewingResolver`. `Presence`
has always carried `overlay` and `api-layout.ts` has promised the clause since M1
("not covered by a full-takeover overlay") with nothing setting it, because nothing
took over the window until this. So an agent that blocks while the user is reading
settings still notifies, and reading settings does not mark a pane as seen. ADR
0020 allows exactly one writer of that predicate; the cost of that rule is that the
one writer must be provably right, which is why the composition is the pure
`presenceFor()` and not three lines inside `whenReady`.

## Consequences

- An extension reads and writes **its own namespace, plus reads `shepherd.*`**, and
  the host derives the namespace from the manifest id rather than taking the
  extension's word for it — the `owner` rule from `points.ts`. A cross-extension
  read is how D11 breaks quietly: the moment `tasks` can read `claudeCode.model` it
  has learned which agent it hired.
- `api.proposed.settings.get` is synchronous and **throws** for a key it was not
  seeded, rather than answering `undefined`. It promises a value backed by a
  declared default, so a missing key is never "the user has not chosen" — it is an
  undeclared key or somebody else's, and both are caller bugs.
- The child's settings mirror is **corrected by the bus**, not trusted like
  `ctx.storage`'s. The `storage.set` comment in `ext-protocol.ts` predicted exactly
  this ("the day a second writer exists (a settings UI editing an extension's
  keys)"), and there are three writers: the extension, the screen, and the CLI.
- `@shepherd/ui` gained `Switch` and `Select`. Select was on that package's
  "deliberately absent" list, and its absence is why `tasks` hand-rolled
  `RepoPicker` inside its own UI.
- Two traps were paid for and are now written down where they bite:
  - **`contributionsOf` in `core/extensions/manifest.ts` drops any contribution it
    does not name.** `contributes.settings` passed the schema, reached the registry
    as nothing, and `agents-core` then refused to activate because a setting it had
    declared was never seeded.
  - **`packages/app/src/shared/**` may not import a VALUE.** The preload bundle
    loads that barrel sandboxed; a `CORE_NAMESPACE` import there failed the preload
    script with `module not found` and took the whole window with it.

## Rejected

- **A human-editable `settings.json`.** §7b's rule is "machines write DBs, humans
  write files", and a hand-edited config is a good feature — but it brings a
  watcher, precedence rules and parse-error UI, and it can be added later as
  another writer to an API that already exists rather than a reshaping of one.
- **Per-scope settings** (per-task, per-repo, per-pane). One global value per key.
  `worktree-hook` already scopes per repo *inside* its own component, which is
  where a scope belongs until a second extension needs one.
- **Component pages for third parties.** A component page resolves against ADR
  0033's static table, so a third-party extension can contribute schema-driven
  settings today and a component page only once a runtime UI loader exists. That
  asymmetry is inherited, and it is the argument for the schema half being the
  primary path rather than the fallback.
- **A `settings` permission for READS.** An extension is handed its own effective
  values at activation; a permission over "may I know my own configuration" would
  be a permission over nothing. Writing is a grant, because a setting is a user's
  decision and an extension that can rewrite one silently can undo one.
