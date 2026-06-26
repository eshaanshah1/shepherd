# Shepherd spike — three seams

A throwaway spike that proves the architecture before any real building. Each
piece maps to a seam in [`../SPEC.md`](../SPEC.md) §7.

```
spike/
  socket-probe/    seam 2+3 — Swift unix-socket listener (RUNS TODAY, no GUI)
  claude-plugin/   seam 3   — throwaway Claude Code plugin: hooks → socket
  app-skeleton/    seam 1   — SwiftUI chrome + GhosttySurfaceView stub (needs Xcode + GhosttyKit)
```

## Seams 2 + 3 — runnable right now (no GUI, no libghostty)

This validates env-injection → hook → socket → correlation → state mapping
end-to-end, without touching Metal/AppKit.

**1. Start the socket listener:**
```sh
cd socket-probe
swift run socket-probe          # listens on $SHEPHERD_SOCK (default /tmp/shepherd.sock)
```

**2. Smoke-test the socket alone** (new terminal) — no Claude needed:
```sh
printf '{"tab_id":"t1","event":"SessionStart"}\n'  | nc -U /tmp/shepherd.sock
printf '{"tab_id":"t1","event":"UserPromptSubmit"}\n' | nc -U /tmp/shepherd.sock
printf '{"tab_id":"t1","event":"Notification"}\n'  | nc -U /tmp/shepherd.sock
printf '{"tab_id":"t1","event":"Stop"}\n'          | nc -U /tmp/shepherd.sock
printf '{"tab_id":"t1","event":"SessionEnd"}\n'    | nc -U /tmp/shepherd.sock
```
The probe prints each transition (`t1 → idle → working → blocked → need-to-check → removed`)
and a live board.

**3. Test the hook script directly** — simulates what Claude will do:
```sh
chmod +x claude-plugin/hooks/report.sh
SHEPHERD_TAB_ID=t2 SHEPHERD_SOCK=/tmp/shepherd.sock \
  claude-plugin/hooks/report.sh Stop </dev/null
```
The probe should print `[t2] Stop → need-to-check`.

**4. Real end-to-end with Claude** (the actual seam-3 proof):
- Install `claude-plugin/` as a Claude Code plugin (see below).
- In any terminal:
  ```sh
  export SHEPHERD_SOCK=/tmp/shepherd.sock
  export SHEPHERD_TAB_ID=real1     # the app will inject this per-PTY; we fake it here
  claude
  ```
- Drive a turn (ask it something, let it use a tool, let it finish). Watch the
  probe: you should see `SessionStart → idle`, `UserPromptSubmit → working`,
  `Pre/PostToolUse → working`, `Stop → need-to-check`, and `SessionEnd → removed`
  on exit — each tagged `real1`.

> If `${CLAUDE_PLUGIN_ROOT}` isn't populated by your install method, edit
> `hooks/hooks.json` to use an absolute path to `report.sh`.

### Installing the throwaway plugin

`claude-plugin/` is a standard plugin layout (`.claude-plugin/plugin.json` +
`hooks/hooks.json`). Install it however your setup auto-loads plugins/skills from
`~/.claude` — e.g. symlink it in:
```sh
ln -s "$PWD/claude-plugin" ~/.claude/plugins/shepherd-spike      # or your loader's path
```
Uninstall = remove the symlink/dir. It touches **nothing** in `settings.json`.

## Seam 1 — needs Xcode + GhosttyKit

The hard, genuinely-unknown one: a live libghostty surface in your own window.
See [`app-skeleton/SEAM1.md`](app-skeleton/SEAM1.md). The `app-skeleton/` SwiftUI
code is the chrome around it (sidebar + state store already wired to the SPEC's
transition rules); `GhosttySurfaceView` is the stub you replace.

## What "green" means

- [ ] Seam 2/3: probe shows correct states for a real `claude` run, correlated by `tab_id`.
- [ ] Seam 1: a real shell renders + takes keystrokes inside your `NSWindow`, sidebar beside it.
- [ ] Bonus: the surface spawns its shell with `SHEPHERD_TAB_ID` set, so a real
      `claude` in it reaches the socket with the right id — all three seams at once.
