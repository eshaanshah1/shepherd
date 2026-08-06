# Shepherd v2 (ADE)

The rebuild: Electron + TypeScript, an extension-shaped kernel, terminal
sessions that outlive their views. v1 (`spike/seam1/`, Swift + libghostty)
stays the daily driver and is **never touched** from here.

- Design: [`docs/superpowers/specs/2026-08-06-ade-v2-core-design.md`](../docs/superpowers/specs/2026-08-06-ade-v2-core-design.md)
- Design language: [`…/2026-08-06-ade-design-language.md`](../docs/superpowers/specs/2026-08-06-ade-design-language.md)
- M0 plan: [`docs/superpowers/plans/2026-08-07-v2-m0-plan.md`](../docs/superpowers/plans/2026-08-07-v2-m0-plan.md)

## Getting started

```sh
cd v2
pnpm install        # node 25.2.1 (mise.toml / .node-version), pnpm 10.28
pnpm -r test        # every package's vitest suite
pnpm -r typecheck   # tsc -b per package (project references)
pnpm lint           # the import boundaries
pnpm test:count     # the mechanical "did the test count move" number
pnpm pty:proof      # spawns a real pty under node and asserts it echoes
pnpm pty:proof:electron   # …and again under Electron's ABI
```

## Layout

```
packages/
  sdk/                 @shepherd/sdk — types + pure helpers. Imports nobody.
  core/                @shepherd/core — the kernel. stdlib + node-pty + sdk.
  design-tokens/       Flock tokens as data + CSS/xterm generators.
  platform/darwin/     @shepherd/platform-darwin — the ONLY place OS APIs appear.
  app/                 @shepherd/app — Electron main + preload + React renderer.
extensions/            built-ins (M2/M3); sdk only.
tooling/
  eslint/boundaries.js the import rules, which are the architecture
  scripts/             postinstall fixes + the pty proof
```

## Two traps this scaffold exists to keep closed

**node-pty needs two things pnpm will not do for you.** pnpm ≥ 10 ignores
dependency lifecycle scripts unless they are listed in
`pnpm.onlyBuiltDependencies` (package.json) — without it the install prints
`Ignored build scripts: node-pty@1.1.0` and moves on. And even once it builds,
node-pty's darwin prebuild ships `spawn-helper` mode 0644, so every spawn throws
`Error: posix_spawnp failed.` with nothing naming a file mode;
`tooling/scripts/fix-node-pty-perms.mjs` runs from v2's own postinstall and
chmods it. Both were measured, and both look like application bugs when they
bite later. `pnpm pty:proof` is the check.

No `@electron/rebuild`: node-pty 1.1.0 ships Node-API prebuilds that load
unmodified in Electron 43 — `pnpm pty:proof:electron` runs the same script under
the Electron binary and gets the same `"ok\r\n"` back. Forcing a source rebuild
invokes node-gyp, which does not support the default python3 here (3.14). Add it
only if a native load actually fails.

Electron 43 has **no postinstall script at all**: it downloads its binary lazily
on the first `require('electron')` (see its `index.js`), so an install that
prints nothing about Electron is healthy, and a first run is a ~100 MB download.
`electron` stays listed in `pnpm.onlyBuiltDependencies` for the day it needs a
build script again.

**Dev/prod isolation is an ordering rule.** Chromium keys the single-instance
lock off the user-data directory, so `app.setPath('userData', …)` must run
*before* `app.requestSingleInstanceLock()`. Locked first, the dev build shares
the daily app's lock and refuses to launch beside it. The paths themselves are
`packages/platform/darwin/src/paths.ts`.

## Toolchain pins

node 25.2.1 · pnpm 10.28 · TypeScript 6.0.3 · Electron 43.3.0 · node-pty 1.1.0 ·
vitest 4.1.10 · @xterm/xterm 6. Every version lives once, in
`pnpm-workspace.yaml`'s `catalog:`; packages depend on `"catalog:"`.

TypeScript is pinned to the 6.0 line rather than 7.0: `typescript@7` is the
native (Go) compiler and ships no JS compiler API, which `typescript-eslint`
(peer `typescript <6.1.0`) parses with — so 7.0 would cost the boundary lint,
the thing this phase exists to install. Revisit when typescript-eslint supports it.
