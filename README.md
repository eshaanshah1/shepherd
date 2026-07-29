# Shepherd

An agent-native macOS terminal built on **libghostty**. It behaves like a normal
terminal (iTerm/Ghostty-style) until you start a **Claude Code** session in a
pane — then that pane becomes a first-class, tracked **agent** with a live state
in the sidebar, so you can run several at once without babysitting any of them.
When one needs you and you've switched apps, a notification and a dock badge pull
you back.

Working and in daily use. Single window; see [`SPEC.md`](SPEC.md) §6 for what's
deliberately out of scope.

## Install

### 1. The app

Grab **`Shepherd.dmg`** from the
[latest release](https://github.com/eshaanshah1/shepherd/releases/latest) and drag
Shepherd to `/Applications`.

The build is **ad-hoc signed, not notarized**, so macOS blocks the first launch as
an "unidentified developer". Either allow it under **System Settings → Privacy &
Security → Open Anyway**, or clear the quarantine flag directly:

```sh
xattr -d com.apple.quarantine /Applications/Shepherd.app
```

(`-r` is not portable — some macOS builds ship an `xattr` without it. The flag on
the bundle itself is the one Gatekeeper reads.)

Shepherd asks for notification permission on first run — allow it, or agents can't
pull you back when you're away.

Installing into `/Applications` also enables the built-in updater: it checks
GitHub daily and offers an in-place update. Run it from anywhere else and the
updater stays dormant.

### 2. The Claude Code plugin — required

**Without this, Shepherd is just a terminal.** Agent state comes from Claude
Code's lifecycle hooks, so the plugin has to be installed for any pane to be
tracked; otherwise every pane sits at `shell` forever.

The plugin ships inside the app. Open **Settings (`⌘,`) → General → Claude Code
plugin → Install plugin**, then run `/reload-plugins` in any Claude Code session.

It links `~/.claude/skills/shepherd` at the copy inside `Shepherd.app`, so updates
carry it along. Nothing in your `~/.claude/settings.json` is touched, and if
anything already exists at that path Shepherd leaves it alone rather than
replacing it. Uninstall from the same place.

The plugin is a **silent no-op outside Shepherd**, so it's safe to leave installed
globally. From a source checkout you can link the repo copy instead, so your edits
apply on the next `/reload-plugins`:

```sh
ln -s "$PWD/claude-plugin" ~/.claude/skills/shepherd
```

### 3. Optional: the `shepherd` CLI

```sh
mkdir -p ~/.local/bin
ln -sf /Applications/Shepherd.app/Contents/MacOS/shepherdd ~/.local/bin/shepherd
```

### Requirements

- **Apple Silicon** — release builds are arm64-only; Intel Macs are not supported.
- **macOS 13+** (declared minimum; developed and tested on macOS 26).
- **Claude Code**, for anything agent-related.

## What you get

- **Panes are agents.** Split a tab (`⌘D` / `⌘⇧D`) and every pane tracks its own
  Claude session independently.
- **Live state per pane** — `working` · `blocked` · `needs a look` · `idle` ·
  `error` · plain `shell` — driven by Claude Code's own hooks, correlated per pane
  rather than guessed from process trees.
- **Attention routing.** A pane that needs you grows into a card in the sidebar,
  badges the dock, and notifies you when Shepherd isn't frontmost. `⌘⇧A` jumps to
  the next one across every workspace.
- **Workspaces** — a collapsible folder per project in the sidebar, each holding
  its own tabs; agents keep running in the ones you're not looking at.
- **The workbench (`⌘G`)** — a built-in review-and-edit surface for the pane's
  repo: diffs, line/hunk staging, commit, branch history and blame, merge-conflict
  resolution, and PR review threads, in an editable buffer.
- **Git worktrees as tabs** — create one from a workspace folder, and archive it on
  close so uncommitted work and the agent's session can be restored later.
- **Stay Awake** — keep the Mac up while agents are running (see below).
- **`⌘/`** lists every keybinding; `⌘,` opens Settings (theme, font, workspaces,
  keybindings).

Config lives in `~/.config/shepherd/config` — libghostty's own keys plus a few
Shepherd ones on `# shepherd:` comment lines (`theme = dark|light|warm`,
`worktree-base`, `editor-wrap-lines`). `⌘⇧R` reloads it live without disturbing
running agents.

## Optional: clamshell-survival (Tier 2)

Shepherd's "Stay Awake" feature keeps the Mac awake while agents run. Out of the box it
uses an IOKit idle assertion (no setup) which holds while the lid is open. To also survive
**closing the lid**, grant Shepherd passwordless `pmset` once:

```sh
echo "$(whoami) ALL=(root) NOPASSWD: /usr/bin/pmset" | sudo tee /etc/sudoers.d/shepherd-pmset >/dev/null
sudo visudo -cf /etc/sudoers.d/shepherd-pmset      # validate
sudo -n pmset -g >/dev/null 2>&1 && echo "PASSWORDLESS OK" || echo "blocked"
```

If absent (or reverted by MDM), Shepherd auto-degrades to the idle assertion. The "Stay
Awake" menu shows which tier is active. A hard crash while holding can leave the kernel
`SleepDisabled` flag set until Shepherd's next launch (which clears it) or a reboot.

## Control CLI

A running Shepherd can be driven from any shell — and by Claude Code itself —
through the `shepherd` CLI, which talks to the app over a local unix socket. It
can list/create/edit/delete workspaces, tabs, and panes, split/focus/zoom, change
config, `tell` a pane text, `view` a pane's output, and `wait` on a pane's state.

```sh
shepherd ls                              # workspace -> tab -> pane tree with handles
shepherd tab new                         # prints the new pane handle
shepherd tell p3 "run the tests"         # type into a pane (agents queue it)
shepherd wait p3 --any-attention         # block until it needs you
shepherd view p3 --lines 60              # read its transcript
```

Install it per step 3 above (from a source checkout, use
`./scripts/install-shepherd-cli.sh [path/to/Shepherd.app]`).

Full verb reference: **[`docs/control-cli.md`](docs/control-cli.md)**.

## Remote push (FCM) — host setup

Shepherd can wake a paired phone over Firebase Cloud Messaging when an agent
needs you and you're away from the Mac (lid shut, no external display). Setup is
one-time and shared with the Android client (step 3).

1. Create a free Firebase project at <https://console.firebase.google.com>.
2. **Project Settings → Service accounts → Generate new private key** → download the JSON.
3. Save it as `~/.config/shepherd/fcm-service-account.json`.

That's all — `project_id` is read from the key. With no key present, push is
silently disabled (Shepherd alerts locally as usual). The key is a send-only
FCM credential; treat it as a secret. Pushes carry only `{paneID, state, urgent}` — no
terminal content ever transits Google.

## Building from source

Needs Xcode with the Metal Toolchain and brew `zig@0.15` (libghostty is built
locally; the compiled xcframework isn't committed).

```sh
./scripts/build-libghostty.sh             # -> vendor/GhosttyKit.xcframework
./scripts/vendor-codeedit-languages.sh    # -> vendor/CodeEditLanguages

cd spike/seam1
xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build \
  -clonedSourcePackagesDirPath ~/Library/Caches/shepherd-spm \
  CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache build
codesign --force --deep --sign - ./build/Build/Products/Debug/Shepherd.app
```

Full instructions, architecture notes, and the gotchas worth reading first are in
**[`CLAUDE.md`](CLAUDE.md)**. Design record: **[`SPEC.md`](SPEC.md)**. The
decisions behind anything load-bearing: **[`.claude/adr/`](.claude/adr/)**.
