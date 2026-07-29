# 0005. Install the plugin via the skills-dir auto-load

Status: Accepted
Date: 2026-06-27

## Context
Shepherd needs its Claude Code hooks loaded globally without clobbering the
user's heavily-customized `~/.claude/settings.json`. Options: merge hooks into
settings.json (invasive), register a local marketplace (`/plugin marketplace
add` + a `marketplace.json`), or use the skills-dir auto-load.

## Decision
Install as a **skills-dir plugin**: any folder under `~/.claude/skills/<name>/`
containing `.claude-plugin/plugin.json` auto-loads as `<name>@skills-dir` (no
marketplace, no settings.json edits). We **symlink** the repo's `claude-plugin/`:
```
ln -s <repo>/claude-plugin ~/.claude/skills/shepherd
```
so repo edits apply on the next `/reload-plugins`. `${CLAUDE_PLUGIN_ROOT}` resolves
to the install dir in `hooks.json`, and hooks inherit the PTY env (so `report.sh`
reads `$SHEPHERD_TAB_ID`). Confirmed against current Claude Code docs.

## Update (2026-07-29): the app ships the plugin and links it itself
The symlink above assumes a **source checkout**, which a DMG user doesn't have —
so the install step for them was "clone the repo to obtain a hooks directory",
and until they did, every pane sat at `shell` and the product's whole premise
silently did nothing.

`claude-plugin/` is now copied into `Shepherd.app/Contents/Resources` (an
xcodegen folder reference, which preserves `.claude-plugin/` and `report.sh`'s
exec bit — both verified in the built bundle), and Settings → General installs
the link. `${CLAUDE_PLUGIN_ROOT}` already made the plugin location-independent,
so `hooks.json` needed no change.

- **Link into the bundle, never copy out of it.** The updater replaces
  Shepherd.app in place, so a link keeps resolving to the running build's plugin;
  a copy would silently go stale one update later.
- **Only ever create; never replace.** `ClaudePluginInstaller.state` classifies
  what sits at the path — ours / another checkout's link / a real dir — and
  installs only when it is *absent*. Installing over a foreign entry would delete
  a working setup, and a dev build's link would dangle on the next rebuild, which
  is why the dev target doesn't bundle the plugin at all.
- The manual symlink stays the right move when developing the plugin, since edits
  then apply on the next `/reload-plugins`.

## Consequences
- Zero changes to the user's settings.json; uninstall = remove the symlink.
- The plugin is a **silent no-op outside Shepherd** (checks the env + socket), so
  it's safe to leave installed globally.
- **`plugin.json` `author` must be an object** (`{"name": "..."}`), not a string —
  a string fails manifest validation ("expected object, received string").
