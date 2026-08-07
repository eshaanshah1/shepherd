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
pnpm smoke          # THE M0 GATE — see below. Run this to answer "is M0 done?"
pnpm smoke:session  # main-only: node-pty under Electron's ABI, userData before the lock
pnpm smoke:terminal # the whole chain: build, boot, xterm attached, menu keys, quit
pnpm smoke:isolation       # builds twice; each build must own its own userData dir
pnpm smoke:single-instance # two copies, one dir: the second must exit 2, promptly
pnpm dev            # electron-vite: the window, with HMR on the renderer
pnpm build          # electron-vite build -> packages/app/out
```

`pnpm smoke` is the milestone gate. One run of the real built app: boot → a
session exists → write `echo …` **through the page's own bridge** → assert those
bytes are in the session's replay ring → split with the ⌘D menu item → assert two
leaves and two live sessions → quit. It runs **twice back to back into the same
userData directory**, which is the only way to catch a leaked single-instance
lock (a fresh dir per run hides exactly that), and it checks the pty pids the app
reported are really gone afterwards.

`smoke:terminal` is the one that answers "does the app work". It builds, launches
the real app under a throwaway userData dir, and asserts 27 things a headless
vitest run cannot: that pty bytes reach xterm's *buffer*, that `window.shepherd`
is exactly the declared bridge and `window.require` is undefined, that clicking
the real ⌘D / ⌘⇧D / ⌘⌥← / ⌘W menu items drives the layout the way the layout
model says, and that ⌘W closes the window only on the last pane. It passes only
if the process exits 0 **and** prints `smoke: OK` — an Electron main process
that dies of an unhandled rejection exits zero, which was measured, not assumed.

Add `SHEPHERD_CAPTURE=/tmp/shot.png` to photograph the three-pane state it
asserts.

### Screenshotting the window

`screencapture -l <window-id>` needs macOS **Screen Recording** permission,
which an automated session does not have — it fails with `could not create
image from window`, which looks exactly like the app never drew. So the app
takes its own picture instead:

```sh
SHEPHERD_CAPTURE=/tmp/shot.png pnpm dev     # writes one PNG, then says so
```

It works against `pnpm build` + `electron-vite preview` too. In dev the
renderer's console is forwarded to the terminal (`[renderer:error] …`), because
otherwise the only place a React error appears is a DevTools window nobody has
open.

## Layout

```
packages/
  sdk/                 @shepherd/sdk — types + pure helpers. Imports nobody.
  core/                @shepherd/core — the kernel. stdlib + node-pty + sdk.
  design-tokens/       Flock tokens as data + CSS/xterm generators.
  platform/darwin/     @shepherd/platform-darwin — the ONLY place OS APIs appear.
  app/                 @shepherd/app — Electron main + preload + React renderer.
                       React lives here and nowhere else. The renderer's one
                       door into the kernel is `@shepherd/core/layout` (pure
                       geometry); everything else goes over the preload bridge,
                       and both halves of that are lint rules.
extensions/            built-ins (M2/M3); sdk only.
tooling/
  eslint/boundaries.js the import rules, which are the architecture
  scripts/             postinstall fixes, the pty proofs, the two smokes
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
the daily app's lock and refuses to launch beside it. The order lives in
`packages/app/src/main/bootstrap.ts` and is asserted by a test that swaps the
electron module for a recorder and reads the call sequence back — the property
is invisible in the result, so a comment could not have carried it. The paths
themselves are `packages/platform/darwin/src/paths.ts`, and which build this is
comes from `build-flags.ts`, substituted into the bundle by electron-vite's
`define` rather than read at runtime: an env var or an argv flag is a switch
anybody can flip to point a dev build at the production directory.
`pnpm smoke:isolation` asserts both halves — the path each build prints, and
that the identifier is gone from the bundle.

**The renderer is sandboxed, and that is why the preload is `.cjs`.**
`window-options.ts` sets `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true` and mentions `enableRemoteModule` nowhere (a key that is present
is a key somebody flips during a debugging session). A sandboxed preload is not
an ES module, so electron-vite emits `out/preload/index.cjs` while the package
stays `"type": "module"`. Getting that wrong does not produce an error you can
read: measured, an `.mjs` preload under `sandbox: true` left the app **hung** —
no window, no log line — and it then declined the SIGTERM the smoke runner's
timeout sends, which is why those runners now kill with SIGKILL.

## Toolchain pins

node 25.2.1 · pnpm 10.28 · TypeScript 6.0.3 · Electron 43.3.0 · node-pty 1.1.0 ·
vitest 4.1.10 · @xterm/xterm 6. Every version lives once, in
`pnpm-workspace.yaml`'s `catalog:`; packages depend on `"catalog:"`.

TypeScript is pinned to the 6.0 line rather than 7.0: `typescript@7` is the
native (Go) compiler and ships no JS compiler API, which `typescript-eslint`
(peer `typescript <6.1.0`) parses with — so 7.0 would cost the boundary lint,
the thing this phase exists to install. Revisit when typescript-eslint supports it.
staged-change
