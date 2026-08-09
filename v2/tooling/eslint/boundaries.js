// The import boundaries, as lint rules. This file IS the architecture diagram:
// if a package can import something, it is because a line here says so.
//
//   core            -> stdlib + node-pty + sdk        (no electron, no react, no OS APIs)
//   sdk             -> stdlib only                    (types + pure helpers; imports nobody)
//   design-tokens   -> nothing                        (data + generators)
//   ui              -> react + sdk + design-tokens    (the primitive set; a page and nothing else)
//   platform/*      -> stdlib + OS APIs + electron    (the ONLY place OS APIs appear)
//   app/main|preload-> electron + core + sdk + platform
//   app/renderer    -> react + xterm + tokens + ui + sdk + @shepherd/core/layout
//                      + @shepherd/ext-*/ui           (in-proc extension views, ADR 0033)
//   app/ext-host    -> sdk + app/shared + built-in extensions
//                                                     (a utility process: no electron, no core)
//   extensions/*/src-> sdk only, + TYPE-only imports of another extension
//                                                     (values go through extensions.get)
//   extensions/*/ui -> the above + react + ui          (the extension's own half of the page)
//
// Enforced with the core `no-restricted-imports` rule so the lint step needs no
// type information and stays fast enough to run on every save. One rule — the
// extension-to-extension one — uses the typescript-eslint variant of that same
// rule, for `allowTypeImports`; it needs no type information either.

import tseslint from 'typescript-eslint';

const ELECTRON = ['electron', 'electron/*', '@electron/*'];
const REACT = ['react', 'react-dom', 'react/*', 'react-dom/*'];
const XTERM = ['@xterm/*'];
/**
 * The DRAWING half of xterm — the part that measures cells and builds elements.
 *
 * Split out from `XTERM` in R0, when core acquired a legitimate need for the
 * OTHER half. `@xterm/headless` is deliberately absent from this list; see the
 * comment on `boundary/core` for why that is a narrowing rather than a hole.
 */
const XTERM_VIEW = ['@xterm/xterm', '@xterm/xterm/*', '@xterm/addon-fit', '@xterm/addon-webgl'];
const NODE_PTY = ['node-pty', 'node-pty/*'];

// "OS API" = the node builtins through which a process reaches the machine
// itself. fs/path/url are stdlib and stay allowed everywhere; these are not.
//
// Three builtins core DOES use, deliberately, and which this list therefore
// does not name — recorded because a deny-list is silent about what it permits,
// and this file is supposed to be readable as the architecture:
//   node:sqlite  the one store (stdlib, so no native build against Electron's ABI)
//   node:http    the two ingress sockets — HTTP over a unix path buys framing,
//                acks, request timeouts and body caps for free
//   node:net     the unix paths those listen on
// They are the kernel's own persistence and its external front door, not a
// reach into the machine, which is what the entries below are about.
const OS_APIS = [
  'os',
  'node:os',
  'child_process',
  'node:child_process',
  'node:process',
  'worker_threads',
  'node:worker_threads',
  'node:v8',
  'node:vm',
];

// Why the renderer may import an extension's `ui` subpath and nothing else of it.
const SERVICE_HALF =
  "the renderer may import only an extension's `/ui` subpath (§7b's in-proc React). Everything else is its " +
  'service half and runs in the extension host — importing it here evaluates it in the page.';

const WORKSPACE = {
  sdk: ['@shepherd/sdk'],
  core: ['@shepherd/core'],
  tokens: ['@shepherd/design-tokens'],
  ui: ['@shepherd/ui', '@shepherd/ui/*'],
  platform: ['@shepherd/platform-*'],
  app: ['@shepherd/app'],
};

// Why `@shepherd/ui` is denied nearly everywhere despite being the one package
// that is PUBLIC by design.
//
// It is a set of React components and a stylesheet. There are exactly two places
// in this repo that can mount one — the renderer, and an extension's `ui/` half,
// which runs in the renderer's process (§7b, ADR 0033). Everywhere else the
// import would either evaluate a component module in a process with no document
// (main, the extension host, an extension's service half) or pull react into a
// package whose whole claim is that it is headless (core, sdk, platform,
// design-tokens). Both failures are silent at typecheck — `packages/app` compiles
// with DOM in `lib`, and so does an extension — which is why the boundary is here
// rather than in a tsconfig.
const NO_PAGE =
  '@shepherd/ui draws: it is importable only from packages/app/src/renderer and extensions/*/ui, which are the two things that run in the page.';

function deny(groups, message) {
  return { group: groups, message };
}

/**
 * An EXACT module name, not a pattern. `patterns` are gitignore-style, and
 * gitignore treats `@shepherd/core` as a directory prefix — so it also matches
 * `@shepherd/core/layout`, and a `!` negation does not rescue it (measured).
 * `paths` matches the import string literally, which is what a carve-out of one
 * subpath needs.
 */
function denyExact(name, message) {
  return { name, message };
}

function restrict(...entries) {
  const paths = entries.filter((entry) => 'name' in entry);
  const patterns = entries.filter((entry) => 'group' in entry);
  return {
    'no-restricted-imports': ['error', { paths, patterns }],
  };
}

/**
 * The DOM half of the same boundary.
 *
 * `packages/app` compiles main, preload and renderer under ONE tsconfig (a
 * package's worth of project-reference wiring is not worth three), so `lib`
 * carries DOM and TypeScript alone would happily let a main-process file touch
 * `document`. The type layer therefore cannot be the boundary here — this rule
 * is, and it is the honest one anyway: the objection to `document` in main was
 * never that it fails to typecheck.
 */
const noDom = {
  'no-restricted-globals': [
    'error',
    { name: 'document', message: 'there is no DOM in the main process.' },
    { name: 'window', message: 'there is no DOM in the main process (BrowserWindow is not it).' },
    { name: 'navigator', message: 'there is no DOM in the main process.' },
  ],
};

export const boundaries = [
  {
    // Why core may import `@xterm/headless` (R0, 2026-08-09), when for three
    // milestones the rule here read "xterm is a renderer concern; core owns
    // bytes, not views."
    //
    // That sentence rested on a claim about the DOM, and it is still true of
    // `@xterm/xterm`, which measures cells and builds elements — so that half
    // stays denied, as `XTERM_VIEW`. `@xterm/headless` is the same VT state
    // machine with the renderer removed and no DOM anywhere in its import graph.
    // It is a PARSER, which is exactly the kind of thing a kernel that owns ptys
    // should own.
    //
    // It is load-bearing rather than convenient. Without a host-side screen an
    // attach can only replay a byte ring, so a viewer has to have watched from
    // the beginning to be correct — which is why v1's phone needed a bespoke
    // integration, and why v1's remote design lists a cold-reconnect redraw as an
    // accepted limitation rather than a bug. A serialized screen deletes it.
    // Measured in docs/superpowers/probes/2026-08-09-r0.
    //
    // Two things keep this narrow. The view addons are named explicitly rather
    // than left to a `@xterm/*` wildcard, so a future addon is denied by default
    // and appears here as a decision. And the mirror lives in `session/`, next to
    // the fanout it feeds — a `@xterm/headless` import anywhere else in core is
    // still wrong, but it is wrong in a way review catches rather than lint.
    name: 'boundary/core',
    files: ['packages/core/**/*.ts'],
    rules: restrict(
      deny(ELECTRON, 'core is process-agnostic: no electron. Put shell wiring in packages/app.'),
      deny(REACT, 'core is headless: no react. Views live in packages/app/src/renderer.'),
      deny(
        XTERM_VIEW,
        'the renderer draws: @xterm/xterm and its view addons are a renderer concern. ' +
          'core may import @xterm/headless + @xterm/addon-serialize (the VT state machine, no DOM) — see the comment above.',
      ),
      deny(OS_APIS, 'OS APIs live in packages/platform/darwin only (node-pty is the one exception).'),
      deny(
        [...WORKSPACE.app, ...WORKSPACE.platform, ...WORKSPACE.tokens, ...WORKSPACE.ui],
        'core may only import @shepherd/sdk.',
      ),
    ),
  },
  {
    // Core's TESTS may reach the machine; core itself may not.
    //
    // The rule above exists so the shipped kernel stays process-agnostic. A test
    // is not shipped, and the on-disk half of the store — migrations only happen
    // on a real file — needs a temp directory. Without this carve-out the test
    // author's options are to read `process.env.TMPDIR` off the global (lint
    // cannot see it, which makes the rule theatre) or to write fixtures into the
    // repo. Everything else still applies: no electron, no react, no other
    // workspace package.
    //
    // Ordered AFTER boundary/core so it wins for the files it names.
    name: 'boundary/core-tests',
    files: ['packages/core/**/*.test.ts'],
    rules: restrict(
      deny(ELECTRON, 'core is process-agnostic: no electron, not even in a test.'),
      deny(REACT, 'core is headless: no react, not even in a test.'),
      // Same split as `boundary/core`: a mirror test may build a second
      // `@xterm/headless` to repaint a snapshot into and compare screens, which
      // is the only honest way to assert round-trip fidelity. The drawing half
      // stays denied — there is no DOM in a core test either.
      deny(XTERM_VIEW, 'the renderer draws; a core test may use @xterm/headless to check a screen.'),
      deny(
        [...WORKSPACE.app, ...WORKSPACE.platform, ...WORKSPACE.tokens, ...WORKSPACE.ui],
        'core may only import @shepherd/sdk.',
      ),
    ),
  },
  {
    name: 'boundary/sdk',
    files: ['packages/sdk/**/*.ts'],
    rules: restrict(
      deny(ELECTRON, 'sdk is types + pure helpers: no electron.'),
      deny(REACT, 'sdk is types + pure helpers: no react.'),
      deny(NODE_PTY, 'sdk describes sessions; core implements them.'),
      deny(OS_APIS, 'sdk is pure: no OS APIs.'),
      deny(
        [...WORKSPACE.core, ...WORKSPACE.app, ...WORKSPACE.platform, ...WORKSPACE.tokens, ...WORKSPACE.ui],
        'sdk sits below everything and imports no other workspace package.',
      ),
    ),
  },
  {
    name: 'boundary/design-tokens',
    files: ['packages/design-tokens/**/*.ts'],
    rules: restrict(
      deny(ELECTRON, 'tokens are data: no electron.'),
      deny(REACT, 'tokens are data: no react (the consumer applies them).'),
      deny(OS_APIS, 'tokens are data: no OS APIs.'),
      deny(
        [...WORKSPACE.core, ...WORKSPACE.app, ...WORKSPACE.platform, ...WORKSPACE.sdk, ...WORKSPACE.ui],
        'design-tokens imports nobody — and it sits BELOW @shepherd/ui, which reads it.',
      ),
    ),
  },
  {
    // The primitive set. It is the one package written to be imported BY code we
    // do not control, which makes its own import list the more interesting half
    // of the boundary: whatever `@shepherd/ui` can reach, every contributed view
    // reaches through it.
    //
    //   - **react + design-tokens**: the two it is made of. Tokens are where the
    //     roles live, and the roles are what a primitive styles from — a hex or a
    //     px literal in here is the drift this package exists to end.
    //   - **sdk**: permitted, and now used. `fuzzy.ts` moved down there with the
    //     repo picker, because an extension's SERVICE half needs the same ranking
    //     the ⌘K palette uses — it is the side that holds the history and reads a
    //     directory, so it is the side that must filter and cap before an answer
    //     crosses a message port, and this package is importable only from the
    //     page. The original reason stands too: a primitive that takes a
    //     host-shaped value (a session id, an agent state) should name it with the
    //     sdk's type rather than restate it, which is exactly the duplication the
    //     extension type-import carve-out was added to prevent.
    //   - **no electron**: a component that reached `ipcRenderer` would hand every
    //     extension mounting it the main process. The props an extension is given
    //     (`ExtensionViewProps`) are supposed to be the whole of its power.
    //   - **no core, no platform, no app**: a primitive draws. It does not know
    //     what a session is, and a `<Row>` that fetched its own data would make
    //     every consumer inherit the kernel.
    //   - **no OS APIs, no node-pty, no xterm**: there is no machine here, this
    //     runs in the page — and a terminal is a core view, not a primitive.
    name: 'boundary/ui',
    files: ['packages/ui/**/*.ts', 'packages/ui/**/*.tsx'],
    rules: restrict(
      deny(ELECTRON, 'a primitive draws; it never holds ipcRenderer, or every view that mounts it does too.'),
      deny(XTERM, 'a terminal is a core view; @shepherd/ui is the chrome around it.'),
      deny(NODE_PTY, 'there is no pty in the page.'),
      deny(OS_APIS, 'there is no machine here — this runs in the page.'),
      deny(
        [...WORKSPACE.core, ...WORKSPACE.app, ...WORKSPACE.platform, '@shepherd/ext-*'],
        '@shepherd/ui may import react, @shepherd/design-tokens and @shepherd/sdk. It is below the app and below every extension: a primitive that imported one would invert the dependency it exists to serve.',
      ),
    ),
  },
  {
    name: 'boundary/platform',
    files: ['packages/platform/**/*.ts'],
    rules: restrict(
      deny(REACT, 'platform is headless: no react.'),
      deny(NODE_PTY, 'sessions belong to core; platform is presence/notifications/keychain.'),
      deny([...WORKSPACE.core, ...WORKSPACE.app, ...WORKSPACE.ui], 'platform may only import @shepherd/sdk.'),
    ),
  },
  {
    name: 'boundary/app-main',
    files: ['packages/app/src/main/**/*.ts'],
    rules: {
      ...restrict(
        deny(REACT, 'react belongs to packages/app/src/renderer.'),
        deny(OS_APIS, 'OS APIs live in packages/platform/darwin only.'),
        deny(WORKSPACE.ui, NO_PAGE),
      ),
      ...noDom,
    },
  },
  {
    // Preload is the one file that legitimately sees both sides, so it keeps
    // the import restrictions without the DOM ban.
    name: 'boundary/app-preload',
    files: ['packages/app/src/preload/**/*.ts'],
    rules: restrict(
      deny(REACT, 'react belongs to packages/app/src/renderer.'),
      deny(OS_APIS, 'OS APIs live in packages/platform/darwin only.'),
      // The preload sees the page but does not DRAW in it: it runs before the
      // document exists and its whole job is to expose a bridge object.
      deny(WORKSPACE.ui, NO_PAGE),
    ),
  },
  {
    // One of the two places `@shepherd/ui` is importable, by omission from every
    // list below — this and `boundary/extension-ui` are the only rules in the file
    // that do not deny it, and that is the permission.
    name: 'boundary/app-renderer',
    files: ['packages/app/src/renderer/**/*.ts', 'packages/app/src/renderer/**/*.tsx'],
    rules: restrict(
      deny(ELECTRON, 'the renderer talks to main through the preload bridge, never electron directly.'),
      deny(NODE_PTY, 'the renderer attaches to a session over IPC; it never owns a pty.'),
      deny(OS_APIS, 'OS APIs live in packages/platform/darwin only.'),
      // The kernel entry point stays shut: a session, a command or an event
      // reaches the renderer through the preload bridge and nowhere else —
      // importing `@shepherd/core` here would also drag node-pty into a page.
      // `@shepherd/core/layout` is carved out because the split tree is pure
      // geometry with no platform in its import graph, and the renderer is the
      // thing that draws it. The subpath IS the boundary: it is enumerable, it
      // cannot reach `session/`, and a widening shows up as an edit to this
      // line rather than as a quiet new import.
      denyExact(
        '@shepherd/core',
        'the renderer reaches core through the preload bridge; only @shepherd/core/layout (pure geometry) is importable directly.',
      ),
      deny(
        ['@shepherd/core/session*'],
        'the session registry lives in main; the renderer attaches over IPC.',
      ),
      // §7b's in-proc React seam, kept to ONE subpath (ADR 0033).
      //
      // `@shepherd/ext-*/ui` is an extension's own half of the page and is the
      // reason `renderer/extension-ui.ts` exists. Everything else in an
      // extension package is its SERVICE half — it runs in a utility process,
      // and importing it here would run its module graph inside the page,
      // undoing §7b's process split in one line and (for `.`) evaluating an
      // `activate` module in the renderer.
      //
      // It takes TWO entries, and the shape is measured rather than reasoned.
      // A single `['@shepherd/ext-*', '!@shepherd/ext-*/ui']` denies the `/ui`
      // import as well: these are gitignore-style patterns, and gitignore
      // cannot re-include a path under an excluded *directory* — the same
      // measurement that put `denyExact` in this file for `@shepherd/core`.
      // Matching one segment down (`/*`) makes `/ui` a file-level match, which
      // a negation does rescue.
      //
      // So the roots are named exactly, one line per extension. That is a
      // maintenance cost paid deliberately: this file is the architecture
      // diagram, and a new extension whose service half becomes importable from
      // the page should require an edit here to say so.
      denyExact('@shepherd/ext-tasks', SERVICE_HALF),
      denyExact('@shepherd/ext-diagnostics', SERVICE_HALF),
      denyExact('@shepherd/ext-agents-core', SERVICE_HALF),
      denyExact('@shepherd/ext-claude-code', SERVICE_HALF),
      deny(['@shepherd/ext-*/*', '!@shepherd/ext-*/ui'], SERVICE_HALF),
    ),
  },
  {
    // The extension host's utility process — a fourth process kind, and the
    // narrowest of the four.
    //
    // It runs extension code, so what it can reach is what an extension can
    // reach through it. Each denial below is therefore load-bearing rather than
    // tidy:
    //
    //   - **electron**: a utility process has no `electron` module at all. The
    //     port arrives as the `process.parentPort` GLOBAL, which lint cannot see —
    //     so an `import` here would typecheck against electron's .d.ts and then
    //     fail at runtime, in a child process, with the symptom "the extension
    //     host never said hello".
    //   - **@shepherd/core**: the kernel lives in main and is reached over the
    //     port. A `CommandRegistry` imported here would be a SECOND, empty one —
    //     every register succeeding, every invoke finding nothing, and no line
    //     anywhere saying why. Denied as a `group` so the subpaths
    //     (`@shepherd/core/layout`) go with it: unlike the renderer, this process
    //     has no reason to draw a tree.
    //   - **OS APIs / node-pty**: an extension asks for a session through the
    //     API; it does not get to spawn one. Same rule as `extensions/**`, applied
    //     to the process that hosts them.
    //   - **react / the DOM**: there is no document here, and §7b puts extension
    //     *UI* in-proc in the renderer — not in the services process.
    name: 'boundary/app-ext-host',
    files: ['packages/app/src/ext-host/**/*.ts'],
    rules: {
      ...restrict(
        deny(ELECTRON, 'a utility process has no electron module; its port is the process.parentPort global.'),
        deny(REACT, 'extension UI is in-proc in the renderer (§7b); extension services are here.'),
        deny(XTERM, 'xterm is a renderer concern.'),
        deny(NODE_PTY, 'an extension asks the session API; it never spawns a pty.'),
        deny(OS_APIS, 'OS APIs live in packages/platform/darwin only.'),
        deny(
          [...WORKSPACE.core, ...WORKSPACE.platform, ...WORKSPACE.tokens, ...WORKSPACE.ui],
          'the kernel lives in main and is reached over the message port; a core import here would be a second, empty kernel.',
        ),
      ),
      ...noDom,
    },
  },
  {
    name: 'boundary/app-shared',
    files: ['packages/app/src/shared/**/*.ts'],
    rules: restrict(
      deny(ELECTRON, 'shared code is loaded in both processes: no electron.'),
      deny(REACT, 'shared code is loaded in both processes: no react.'),
      deny(NODE_PTY, 'shared code is loaded in both processes: no node-pty.'),
      deny(OS_APIS, 'OS APIs live in packages/platform/darwin only.'),
      deny(WORKSPACE.ui, NO_PAGE),
    ),
  },
  {
    // An extension's SERVICE half. `ui/` is the other half and has its own rule
    // below — the split is a process boundary (§7b), so it is two rules.
    name: 'boundary/extensions',
    files: ['extensions/*/src/**/*.ts'],
    // The TS variant of the same rule, for `allowTypeImports` below. It needs no
    // type information either, so the "fast enough to run on every save" property
    // this file is built on is intact.
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      ...restrict(
        deny(ELECTRON, 'an extension sees the host only through @shepherd/sdk.'),
        deny(NODE_PTY, 'an extension asks the session API; it never spawns a pty.'),
        deny(OS_APIS, 'an extension asks the platform through @shepherd/sdk.'),
        // The service half runs in a utility process with no DOM (§7b). React
        // here would typecheck — `ui/` compiles under the same tsconfig — and
        // then be a component nothing can mount, in a process that cannot draw.
        // Its home is `<extension>/ui`, which the renderer imports.
        deny(REACT, "extension UI lives in <extension>/ui and is mounted by the renderer; the service half has no DOM."),
        deny(
          [...WORKSPACE.core, ...WORKSPACE.app, ...WORKSPACE.platform, ...WORKSPACE.ui],
          'an extension may only import @shepherd/sdk. ' + NO_PAGE,
        ),
      ),
      // One extension may TYPE-import another and may not VALUE-import it.
      //
      // Added deliberately in M2, when `claude-code` became the first extension
      // to depend on another (`agents-core`'s state vocabulary). Sharing types is
      // how a vendor extension speaks the noun it plugs into — the alternative is
      // duplicating the union, which drifts. Sharing *values* is different: §7c
      // decided cross-extension calls are **declared, not discovered**, so the
      // runtime path is `manifest.dependencies` + `extensions.get`, which the host
      // can review and gate. A direct value import reaches the same code with no
      // manifest entry and no gate, which is the whole mechanism routed around.
      //
      // `allowTypeImports` is exactly this distinction, and it is why this one
      // rule uses the typescript-eslint variant: a type import is erased, so it
      // cannot be a runtime edge at all.
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@shepherd/ext-*'],
              allowTypeImports: true,
              message:
                'one extension may only TYPE-import another (`import type`). The runtime path is ' +
                'manifest `dependencies` + `extensions.get`, which the host gates; a value import routes around it.',
            },
          ],
        },
      ],
    },
  },
  {
    // An extension's UI half — §7b's in-proc React, ADR 0033.
    //
    // It is the only place outside `app/src/renderer` where react is allowed,
    // and the allowance is the whole point: a granted extension renders a real
    // view in the real page rather than being handed a widget vocabulary
    // through a port. What it may NOT reach is everything the service half may
    // not reach either — it is in the renderer's process, so an electron import
    // here would be an extension holding `ipcRenderer`, and the props it is
    // handed (`ExtensionViewProps`) would stop being the whole of its power.
    //
    // It may import its own package's `src/` (the pure model is where a
    // derivation like `repoName` belongs, so the picker and the provisioner
    // cannot disagree). It may not import ANOTHER extension's, by the same
    // declared-not-discovered rule the service half keeps.
    name: 'boundary/extension-ui',
    files: ['extensions/*/ui/**/*.tsx', 'extensions/*/ui/**/*.ts'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      ...restrict(
        deny(ELECTRON, 'a contributed view sees the host through its props (ExtensionViewProps), never electron.'),
        deny(XTERM, 'a terminal is a core view; an extension contributes around it.'),
        deny(NODE_PTY, 'an extension asks the session API; it never spawns a pty.'),
        deny(OS_APIS, 'there is no machine here — this runs in the page.'),
        deny(
          [...WORKSPACE.core, ...WORKSPACE.app, ...WORKSPACE.platform],
          'a contributed view may import @shepherd/sdk, @shepherd/ui, react, and its own package.',
        ),
      ),
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@shepherd/ext-*'],
              allowTypeImports: true,
              message:
                'one extension may only TYPE-import another (`import type`), in its UI half too. The runtime path is ' +
                'manifest `dependencies` + `extensions.get`, which is the service half\'s to walk.',
            },
          ],
        },
      ],
    },
  },
  {
    // An extension's TESTS may reach the machine; the extension may not.
    //
    // Exactly the `boundary/core-tests` carve-out, for the same reason and with
    // the same limits. `tasks` provisions worktrees and materializes a task root,
    // and testing that against a real filesystem needs a temp directory —
    // `node:os` is how you name one. The alternatives are reading
    // `process.env.TMPDIR` off the global, which lint cannot see and which makes
    // the rule theatre, or writing fixtures into the repo.
    //
    // Everything else still applies, and the two that matter most are untouched:
    // no `child_process` (an extension asks `ProcessAPI`, in a test too — that is
    // what makes the runner injectable and the boundary real) and no node-pty.
    //
    // Ordered AFTER boundary/extensions so it wins for the files it names.
    name: 'boundary/extension-tests',
    files: ['extensions/**/*.test.ts'],
    rules: restrict(
      deny(ELECTRON, 'an extension sees the host only through @shepherd/sdk, in a test too.'),
      deny(NODE_PTY, 'an extension asks the session API; it never spawns a pty.'),
      deny(
        ['child_process', 'node:child_process'],
        'an extension asks ProcessAPI; a test that spawned directly would prove nothing about the seam.',
      ),
      deny(
        [...WORKSPACE.core, ...WORKSPACE.app, ...WORKSPACE.platform, ...WORKSPACE.ui],
        'an extension may only import @shepherd/sdk.',
      ),
    ),
  },
];

export default boundaries;
