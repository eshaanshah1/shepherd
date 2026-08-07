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
//   extensions/*    -> sdk only
//
// Enforced with the core `no-restricted-imports` rule so the lint step needs no
// type information and stays fast enough to run on every save.

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
    rules: restrict(
      deny(ELECTRON, 'an extension sees the host only through @shepherd/sdk.'),
      deny(NODE_PTY, 'an extension asks the session API; it never spawns a pty.'),
      deny(OS_APIS, 'an extension asks the platform through @shepherd/sdk.'),
      deny(
        [...WORKSPACE.core, ...WORKSPACE.app, ...WORKSPACE.platform],
        'an extension may only import @shepherd/sdk.',
      ),
    ),
  },
];

export default boundaries;
