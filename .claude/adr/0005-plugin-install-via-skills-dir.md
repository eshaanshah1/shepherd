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

## Consequences
- Zero changes to the user's settings.json; uninstall = remove the symlink.
- The plugin is a **silent no-op outside Shepherd** (checks the env + socket), so
  it's safe to leave installed globally.
- **`plugin.json` `author` must be an object** (`{"name": "..."}`), not a string —
  a string fails manifest validation ("expected object, received string").
