# Claude profiles — multiple Claude Code accounts in one Shepherd

**Date:** 2026-08-06 · **Scope:** local workspaces only (v1)
**Status: built and shipped** (P1–P4, same day). Briefly parked for the Electron shift on
the grounds that the UI third would be written twice; that call was reversed because the
mechanism half is the valuable half and it ports verbatim. The chrome is one Settings
section, one composer menu and one context-menu item — a cheap thing to redo.

## The problem

One Mac, two Claude accounts: the work one and the personal one. Today every pane
Shepherd opens inherits the same `~/.claude`, so the only way to work on something
personal is `/logout` → `/login` → and back again, which drops every other running
agent's credential with it. Two accounts cannot be live at once.

Claude Code already has the seam: **`CLAUDE_CONFIG_DIR`**. Set it and every `~/.claude`
path moves under that directory — settings, projects, sessions, MCP config, skills.
Shepherd already injects per-pane env into the PTY (`SHEPHERD_TAB_ID`, `SHEPHERD_SOCK`,
…), so the mechanism costs one more entry in one array. Everything else in this spec is
the consequences.

### Verified, because the docs are incomplete here

The [authentication docs](https://code.claude.com/docs/en/authentication#credential-management)
say `CLAUDE_CONFIG_DIR` relocates `.credentials.json` **on Linux and Windows**, and that
macOS stores credentials in the Keychain — which reads as though macOS shares one login
across config dirs. It does not. Reading the v2.1.223 CLI, the Keychain **service name**
is derived from the config dir:

```js
function r7(e=""){ let t=process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
  r = t!==void 0 ? !t : !process.env.CLAUDE_CONFIG_DIR, ...
  o = r ? "" : `-${sha256(configDir).substring(0,8)}`;
  return `Claude Code${OAUTH_FILE_SUFFIX}${e}${o}` }
```

So a set `CLAUDE_CONFIG_DIR` yields its own item, `Claude Code-credentials-<8hex>`.
Confirmed by running it: with a fresh dir and a valid login in the default Keychain item,

```
$ CLAUDE_CONFIG_DIR=…/altcfg claude -p "say hi"
Not logged in · Please run /login
```

**The load-bearing consequence:** the hash suffix is appended *iff the variable is set*,
so `CLAUDE_CONFIG_DIR=$HOME/.claude` is **not** the same as leaving it unset — same
directory, different Keychain item, and the user's existing login vanishes. The default
profile must therefore inject **nothing at all**. Never "normalize" it by exporting the
default path explicitly; that is a one-line change that logs everybody out.

`CLAUDE_SECURESTORAGE_CONFIG_DIR` overrides the namespace independently (two config dirs
can deliberately share one login). Out of scope for v1, worth knowing it exists.

## The model

A **profile** is a name plus a config dir. Nothing more — no credential handling of our
own; `/login` inside the pane does that, once per profile, and Claude Code owns it.

```swift
struct ClaudeProfile: Identifiable, Codable, Equatable {
    let id: String            // "default" is reserved
    var name: String          // "Work", "Personal"
    var configDir: String?    // tilde-allowed path; nil ⇒ Claude Code's own default
    var colorHex: String?     // optional tint for the UI
    var isDefault: Bool { configDir == nil }
}
```

`ClaudeProfiles.swift` is **pure** (new `ShepherdModelTests` file) and owns:

- `resolve(paneOverride:workspace:profiles:) -> ClaudeProfile` — pane override wins, else
  the workspace's, else default. Same shape as `defaultPath`: set on the workspace,
  overridable per tab at creation.
- `environment(for:) -> [String: String]` — `[:]` for the default profile, else
  `["CLAUDE_CONFIG_DIR": expandedPath]`. The emptiness for default is the whole point
  above, and gets its own test.
- `expand(_:)` / validation: absolute after tilde expansion, not a file, creatable.
- `keychainService(for:)` — `"Claude Code-credentials-" + sha256(dir).prefix(8)`,
  diagnostics only. Derived from the binary; **not** verified against a real second login
  yet, so nothing may depend on it being right.

### Where the selection lives

- `Workspace.claudeProfileID: String?` — nil ⇒ default. Optional on disk, so existing
  `shepherd.workspaces.v1` blobs decode unchanged (same trick `defaultPath`/`collapsed` use).
- `Pane.claudeProfileID: String?` — an explicit per-tab override, persisted.
- The profile list itself: `shepherd.claudeProfiles.v1` in UserDefaults. That means the
  dev app (separate domain) starts with none, which is correct — dev must not open panes
  pointed at a real account's config dir by accident.

Workspaces are the right default grain because they are already the work/personal
boundary in this app: they carry `defaultPath` and the worktree hook.

## Injection

One branch in `GhosttyTerminal.makeSurface`, in the non-mirror arm, beside the existing
four env vars:

```swift
for (k, v) in AgentStore.shared.claudeEnvironment(forPane: paneID) {
    envVars.append(ghostty_env_var_s(key: dup(k), value: dup(v)))
}
```

**Mirror panes get nothing** — their surface is a byte pipe to the host via `shepherdd
attach`; the PTY, and therefore the account, lives on the host. A remote workspace's
profile is the host's business (v1 limitation, matching worktree errors surfacing host-side).

## The four things that break if you stop there

1. **The plugin, and this is the one that looks like a Shepherd bug.** The hook script
   that drives every state dot is reached through `<configDir>/skills/shepherd`.
   `ClaudePluginInstaller` hardcodes `NSHomeDirectory()/.claude/skills`, so a pane on a
   second profile fires **no hooks at all**: it stays `.shell` forever, no sidebar state,
   no notifications, no attention badge — indistinguishable from agent tracking being
   broken. Fix: `skillsDir`/`linkPath` become parameters (`ClaudePluginInstaller
   .linkPath(configDir:)`), state is computed per profile, and Settings shows an install
   row **per profile**. ADR 0005's rule is unchanged and applies per dir: create or
   repair, never replace.

2. **Transcripts.** `AgentStore` builds `NSHomeDirectory()/.claude/projects` for
   `shepherd view` (line ~3235). Under a profile that directory holds a *different*
   account's sessions, so `view` on an agent pane reads the wrong tree and silently finds
   nothing. It takes the resolved profile's `<configDir>/projects`.

3. **Resume.** `claude --resume <id>` only resolves inside its own config dir. A pane
   persists both its `sessionID` and its profile, so restore is correct for free —
   *provided* profiles are loaded before `takeInitialInput` runs. Changing a pane's
   profile must **clear its `sessionID`**, or the resume line points at a session that
   doesn't exist in the new dir and the pane quietly drops to a plain shell.

4. **A new profile is a blank slate.** No `CLAUDE.md`, no skills, no MCP servers, no
   settings — the user's global memory does not follow them into it. Shepherd installs
   the shepherd plugin and nothing else; the profile row says so, and offers to copy
   nothing. Anything more is the user symlinking what they want.

## UI

Deliberately small. No new sidebar chrome — sidebar rows are fixed-height whatever the
state, and that rule has already been re-learned once.

- **Settings → a new "Claude" tab**: the profile list (add / rename / set dir / delete),
  each row showing its config dir, its plugin-install state, and its **login identity**.
- **Login identity, without touching the Keychain**: read `<configDir>/.claude.json` →
  `oauthAccount.emailAddress`. Present ⇒ "signed in as …", absent ⇒ "not signed in — run
  `/login` in a pane on this profile". Verified: the default account's file carries
  `oauthAccount { emailAddress, organizationUuid, … }`, and a freshly created config dir
  has the file with no such key. Note the default profile's copy lives at `~/.claude.json`
  (home root), while a profile's lives *inside* its config dir. A Keychain probe would
  work too, but reading another app's item risks an authorization prompt for a label.
- **Workspace folder right-click → Claude Profile ▸**, next to Set Directory…; also in
  Settings → Workspaces.
- **⌘T composer**: a profile picker beside the workspace picker, defaulting to the
  workspace's and shown only when more than one profile exists (`NewTabRequest
  .claudeProfileID`, and `profileAvailable` alongside `worktreeAvailable`/`promptAvailable`).
- **Control CLI**: `shepherd tab new --profile <name>`, and `shepherd ls` reports each
  pane's profile. Verb reference gets a line.

Deleting a profile never touches its config dir; panes referencing it fall back to
default with their `sessionID` cleared, exactly as a re-point does.

## Phases

| | | |
|---|---|---|
| **P1** | `ClaudeProfile` + `ClaudeProfiles` pure model, persistence, env injection, workspace/pane fields | a hand-configured second profile runs a second account |
| **P2** | per-profile plugin install + transcript path + sessionID clearing | that account gets state dots, notifications and `view` |
| **P3** | Settings tab, login identity, composer picker, workspace menu | it is usable without editing UserDefaults |
| **P4** | control-CLI `--profile`, `ls` reporting, docs | agents can drive it |

## Testing

Pure (`ClaudeProfilesTests`): resolution precedence (pane > workspace > default); **the
default profile's environment is empty**; tilde expansion; validation; persistence
round-trip with old blobs lacking both new fields. `ClaudePluginInstallerTests` gains the
parameterized-dir cases. Manual, and the bar for calling it done: two profiles, two
accounts, both live at once, both showing state dots, `/status` in each reporting the
right email, and — the regression that matters — the default profile's panes still logged
in after the feature ships.

## Deferred

Per-profile model/settings overrides; sharing one login across dirs via
`CLAUDE_SECURESTORAGE_CONFIG_DIR`; profiles on remote/mirror workspaces; seeding a new
profile from an existing one; profile-aware onboarding (the tour uses default).
