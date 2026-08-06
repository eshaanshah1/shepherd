// The import boundaries, as lint rules. This file IS the architecture diagram:
// if a package can import something, it is because a line here says so.
//
//   core            -> stdlib + node-pty + sdk        (no electron, no react, no OS APIs)
//   sdk             -> stdlib only                    (types + pure helpers; imports nobody)
//   design-tokens   -> nothing                        (data + generators)
//   platform/*      -> stdlib + OS APIs + electron    (the ONLY place OS APIs appear)
//   app/main|preload-> electron + core + sdk + platform
//   app/renderer    -> react + xterm + tokens + sdk   (the ONLY place react appears)
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

function restrict(...entries) {
  return {
    'no-restricted-imports': ['error', { patterns: entries }],
  };
}

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
    files: ['packages/app/src/main/**/*.ts', 'packages/app/src/preload/**/*.ts'],
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
      deny(WORKSPACE.core, 'the renderer reaches core through the preload bridge.'),
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
