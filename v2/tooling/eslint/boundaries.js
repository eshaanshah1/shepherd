// The import boundaries, as lint rules. This file IS the architecture diagram:
// if a package can import something, it is because a line here says so.
//
//   core            -> stdlib + node-pty + sdk        (no electron, no react, no OS APIs)
//   sdk             -> stdlib only                    (types + pure helpers; imports nobody)
//   design-tokens   -> nothing                        (data + generators)
//   platform/*      -> stdlib + OS APIs + electron    (the ONLY place OS APIs appear)
//   app/main|preload-> electron + core + sdk + platform
//   app/renderer    -> react + xterm + tokens + sdk + @shepherd/core/layout
//                                                     (the ONLY place react appears)
//   app/ext-host    -> sdk + app/shared + built-in extensions
//                                                     (a utility process: no electron, no core)
//   extensions/*    -> sdk only, + TYPE-only imports of another extension
//                                                     (values go through extensions.get)
//
// Enforced with the core `no-restricted-imports` rule so the lint step needs no
// type information and stays fast enough to run on every save. One rule — the
// extension-to-extension one — uses the typescript-eslint variant of that same
// rule, for `allowTypeImports`; it needs no type information either.

import tseslint from 'typescript-eslint';

const ELECTRON = ['electron', 'electron/*', '@electron/*'];
const REACT = ['react', 'react-dom', 'react/*', 'react-dom/*'];
const XTERM = ['@xterm/*'];
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

const WORKSPACE = {
  sdk: ['@shepherd/sdk'],
  core: ['@shepherd/core'],
  tokens: ['@shepherd/design-tokens'],
  platform: ['@shepherd/platform-*'],
  app: ['@shepherd/app'],
};

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
    name: 'boundary/core',
    files: ['packages/core/**/*.ts'],
    rules: restrict(
      deny(ELECTRON, 'core is process-agnostic: no electron. Put shell wiring in packages/app.'),
      deny(REACT, 'core is headless: no react. Views live in packages/app/src/renderer.'),
      deny(XTERM, 'xterm is a renderer concern; core owns bytes, not views.'),
      deny(OS_APIS, 'OS APIs live in packages/platform/darwin only (node-pty is the one exception).'),
      deny(
        [...WORKSPACE.app, ...WORKSPACE.platform, ...WORKSPACE.tokens],
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
      deny(XTERM, 'xterm is a renderer concern.'),
      deny(
        [...WORKSPACE.app, ...WORKSPACE.platform, ...WORKSPACE.tokens],
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
        [...WORKSPACE.core, ...WORKSPACE.app, ...WORKSPACE.platform, ...WORKSPACE.tokens],
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
        [...WORKSPACE.core, ...WORKSPACE.app, ...WORKSPACE.platform, ...WORKSPACE.sdk],
        'design-tokens imports nobody.',
      ),
    ),
  },
  {
    name: 'boundary/platform',
    files: ['packages/platform/**/*.ts'],
    rules: restrict(
      deny(REACT, 'platform is headless: no react.'),
      deny(NODE_PTY, 'sessions belong to core; platform is presence/notifications/keychain.'),
      deny([...WORKSPACE.core, ...WORKSPACE.app], 'platform may only import @shepherd/sdk.'),
    ),
  },
  {
    name: 'boundary/app-main',
    files: ['packages/app/src/main/**/*.ts'],
    rules: {
      ...restrict(
        deny(REACT, 'react belongs to packages/app/src/renderer.'),
        deny(OS_APIS, 'OS APIs live in packages/platform/darwin only.'),
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
    ),
  },
  {
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
          [...WORKSPACE.core, ...WORKSPACE.platform, ...WORKSPACE.tokens],
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
    ),
  },
  {
    name: 'boundary/extensions',
    files: ['extensions/**/*.ts', 'extensions/**/*.tsx'],
    // The TS variant of the same rule, for `allowTypeImports` below. It needs no
    // type information either, so the "fast enough to run on every save" property
    // this file is built on is intact.
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      ...restrict(
        deny(ELECTRON, 'an extension sees the host only through @shepherd/sdk.'),
        deny(NODE_PTY, 'an extension asks the session API; it never spawns a pty.'),
        deny(OS_APIS, 'an extension asks the platform through @shepherd/sdk.'),
        deny(
          [...WORKSPACE.core, ...WORKSPACE.app, ...WORKSPACE.platform],
          'an extension may only import @shepherd/sdk.',
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
        [...WORKSPACE.core, ...WORKSPACE.app, ...WORKSPACE.platform],
        'an extension may only import @shepherd/sdk.',
      ),
    ),
  },
];

export default boundaries;
