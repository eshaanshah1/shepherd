# Shepherd

An agent-native macOS terminal built on **libghostty**. It behaves like a normal
terminal (iTerm/Ghostty-style) until you start a **Claude Code** session in a
tab — then that session becomes a first-class, tracked **agent** with a live
state, surfaced in a sidebar, so you can run several at once without babysitting
any of them.

- **[`SPEC.md`](SPEC.md)** — the v1 design (state model, hook-driven engine,
  sidebar, build approach, deferred scope).
- **[`spike/`](spike/)** — the throwaway three-seam spike that de-risks the
  architecture before real building starts. Seams 2 & 3 (socket + Claude plugin)
  run today; seam 1 (libghostty surface) needs Xcode + GhosttyKit.

> v1 = single window, tabs (≤1 agent each), agent-state sidebar, attention-routing
> navigation, dock badge + backgrounded alerts. Everything else is v1.x — see
> SPEC.md §6.
