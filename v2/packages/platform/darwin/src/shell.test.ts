import { describe, expect, it } from 'vitest';
import {
  FALLBACK_SHELLS,
  INHERITED_SHEPHERD_VARS,
  isBuildScriptVar,
  isEphemeralNetworkVar,
  shellDefaults,
  shellDefaultsFrom,
} from './shell.ts';

const home = '/Users/tester';

describe('shellDefaultsFrom', () => {
  it('launches the user’s $SHELL as a login shell', () => {
    const defaults = shellDefaultsFrom({ home, env: { SHELL: '/opt/homebrew/bin/fish' } });
    expect(defaults.command).toBe('/opt/homebrew/bin/fish');
    // `-l`: a GUI-launched .app inherits a minimal PATH, so a pane's shell has
    // to read the user's profile or nothing they installed is on PATH — the
    // exact trap v1 hit with Homebrew.
    expect(defaults.args).toEqual(['-l']);
    expect(defaults.cwd).toBe(home);
  });

  it('falls back when $SHELL is missing or not a path', () => {
    for (const env of [{}, { SHELL: '' }, { SHELL: 'zsh' }, { SHELL: undefined }]) {
      expect(shellDefaultsFrom({ home, env }).command).toBe(FALLBACK_SHELLS[0]);
    }
  });

  it('passes the environment through, and sets HOME from the OS not the env', () => {
    const defaults = shellDefaultsFrom({
      home,
      env: { PATH: '/usr/bin', HOME: '/wrong', LANG: 'en_US.UTF-8' },
    });
    expect(defaults.env['PATH']).toBe('/usr/bin');
    expect(defaults.env['LANG']).toBe('en_US.UTF-8');
    expect(defaults.env['HOME']).toBe(home);
  });

  it('strips the variables that describe Electron rather than the shell', () => {
    const defaults = shellDefaultsFrom({
      home,
      env: {
        PATH: '/usr/bin',
        ELECTRON_RUN_AS_NODE: '1',
        ELECTRON_RENDERER_URL: 'http://localhost:5173',
        NODE_OPTIONS: '--inspect',
        TERM: 'dumb',
        TERM_PROGRAM: 'vscode',
        COLORTERM: 'truecolor',
      },
    });
    // ELECTRON_RUN_AS_NODE in a child makes `node`, `code` and any other
    // Electron app behave differently for no visible reason; TERM is node-pty's
    // to set from the spec, and an inherited one would silently win.
    for (const key of [
      'ELECTRON_RUN_AS_NODE',
      'ELECTRON_RENDERER_URL',
      'NODE_OPTIONS',
      'TERM',
      'TERM_PROGRAM',
      'COLORTERM',
    ]) {
      expect(defaults.env, key).not.toHaveProperty(key);
    }
    expect(defaults.env['PATH']).toBe('/usr/bin');
  });

  it('strips ANOTHER Shepherd’s correlation env, so a pane cannot drive a different app', () => {
    // The real scenario, not a hypothetical: v2 is developed inside v1, so
    // `pnpm dev` from a v1 pane hands this process a live SHEPHERD_TAB_ID and
    // SHEPHERD_SOCK. v1's plugin guards on exactly that pair, so a `claude` in a
    // v2 pane would post its lifecycle events to the RUNNING v1 app.
    const defaults = shellDefaultsFrom({
      home,
      env: {
        PATH: '/usr/bin',
        SHEPHERD_TAB_ID: '7D0CD503-3962-4C58-AD9D-B2BDF83201CB',
        SHEPHERD_SOCK: '/tmp/shepherd-49046.sock',
        SHEPHERD_CTL_SOCK: '/tmp/control.sock',
        SHEPHERD_PTY_SOCK: '/tmp/shepherd-pty-49046.sock',
        SHEPHERD_SESSION_ID: 'a-v2-session',
        SHEPHERD_EVENTS_SOCK: '/tmp/hooks.sock',
        SHEPHERD_CONTROL_SOCK: '/tmp/v2-control.sock',
      },
    });
    for (const key of INHERITED_SHEPHERD_VARS) {
      expect(defaults.env, key).not.toHaveProperty(key);
    }
    expect(defaults.env['PATH']).toBe('/usr/bin');
  });

  it('strips every SHEPHERD_ variable this build injects, so the list cannot fall behind', () => {
    // A negative control on the list itself. The failure it guards against is a
    // new injected variable being added to the injector and forgotten here, which
    // would leak silently — the injected name is the one that matters, because a
    // child Shepherd would inherit it and believe it.
    const injected = ['SHEPHERD_SESSION_ID', 'SHEPHERD_EVENTS_SOCK', 'SHEPHERD_CONTROL_SOCK'];
    for (const key of injected) {
      expect(INHERITED_SHEPHERD_VARS as readonly string[], key).toContain(key);
    }
  });

  it('drops undefined values rather than passing "undefined" strings to a pty', () => {
    const defaults = shellDefaultsFrom({ home, env: { NOT_SET: undefined, SET: 'yes' } });
    expect(defaults.env).toEqual({ SET: 'yes', HOME: home });
  });

  it('reads the real machine without throwing', () => {
    const defaults = shellDefaults();
    expect(defaults.command.startsWith('/')).toBe(true);
    expect(defaults.cwd.startsWith('/')).toBe(true);
    expect(defaults.env['HOME']).toBe(defaults.cwd);
  });

  it('carries no SHEPHERD_ variable off the REAL environment', () => {
    // The fixture-based test above proves the filter; this one proves it against
    // the environment that actually leaks. It has teeth exactly when the suite is
    // run from inside a Shepherd pane — which is the situation it protects, and
    // was true of the session that wrote it (SHEPHERD_TAB_ID was set, and this
    // assertion fails without the strip). Elsewhere it is vacuous, so it is a
    // companion to the fixture test and never a replacement for it.
    const leaking = Object.keys(process.env).filter((key) => key.startsWith('SHEPHERD_'));
    const defaults = shellDefaults();
    for (const key of leaking) {
      expect(defaults.env, `${key} reached a pane from the real environment`).not.toHaveProperty(key);
    }
    // Say what was actually exercised, so a vacuous run is visible rather than
    // being mistaken for a proof.
    expect(Array.isArray(leaking)).toBe(true);
  });
});

describe('isForeignAgentVar', () => {
  // The dev app launched from inside a Claude Code session inherits that
  // session's markers, and an agent spawned in a pane then believes it is a
  // nested child of a session it has never met. Measured on the first live
  // spawn: a transcript-saving-off warning in a brand-new pane.
  it('strips another agent session’s breadcrumbs from a pane', () => {
    const defaults = shellDefaultsFrom({
      home: '/Users/u',
      env: {
        SHELL: '/bin/zsh',
        CLAUDE_CODE_CHILD_SESSION: '1',
        CLAUDE_CODE_SESSION_ID: 'abc',
        CLAUDECODE: '1',
        CLAUDE_PID: '123',
        PATH: '/usr/bin',
      },
    });
    expect(Object.keys(defaults.env).filter((k) => k.includes('CLAUDE'))).toEqual([]);
    expect(defaults.env['PATH']).toBe('/usr/bin');
  });

  it('keeps CLAUDE_CONFIG_DIR — the USER’s profile choice, not a session breadcrumb', () => {
    const defaults = shellDefaultsFrom({
      home: '/Users/u',
      env: { SHELL: '/bin/zsh', CLAUDE_CONFIG_DIR: '/Users/u/.claude-work' },
    });
    expect(defaults.env['CLAUDE_CONFIG_DIR']).toBe('/Users/u/.claude-work');
  });
});

describe('isEphemeralNetworkVar', () => {
  // The environment measured inside a real pane of an app shipped from a
  // sandboxed agent session. The proxy it names (127.0.0.1:63135) and the process
  // that minted the CA were both already dead, so every pane the app opened had
  // no route to anything — and `claude` reported it as an unverifiable token.
  const SANDBOX_ENV = {
    SHELL: '/bin/zsh',
    PATH: '/usr/bin',
    http_proxy: 'http://127.0.0.1:63135',
    HTTP_PROXY: 'http://127.0.0.1:63135',
    https_proxy: 'http://127.0.0.1:63135',
    HTTPS_PROXY: 'http://127.0.0.1:63135',
    no_proxy: 'localhost,127.0.0.1,::1',
    NO_PROXY: 'localhost,127.0.0.1,::1',
    PIP_PROXY: 'http://127.0.0.1:63135',
    YARN_HTTP_PROXY: 'http://127.0.0.1:63135',
    YARN_HTTPS_PROXY: 'http://127.0.0.1:63135',
    NODE_USE_ENV_PROXY: '1',
    NODE_EXTRA_CA_CERTS: '/var/folders/t9/T/pmg-ca-cert-59872.pem',
    SSL_CERT_FILE: '/var/folders/t9/T/pmg-ca-cert-59872.pem',
    REQUESTS_CA_BUNDLE: '/var/folders/t9/T/pmg-ca-cert-59872.pem',
    YARN_HTTPS_CA_FILE_PATH: '/var/folders/t9/T/pmg-ca-cert-59872.pem',
  } as const;

  it('strips a dead session’s proxy and its throwaway CA', () => {
    const defaults = shellDefaultsFrom({ home: '/Users/u', env: SANDBOX_ENV });
    for (const key of Object.keys(SANDBOX_ENV)) {
      if (key === 'SHELL' || key === 'PATH') continue;
      expect(defaults.env, key).not.toHaveProperty(key);
    }
    expect(defaults.env['PATH']).toBe('/usr/bin');
  });

  it('matches the suffix in either case, since tools disagree about spelling', () => {
    for (const key of ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'PROXY', 'proxy']) {
      expect(isEphemeralNetworkVar(key), key).toBe(true);
    }
  });

  it('leaves a CA that is a machine’s configuration rather than a session’s', () => {
    // NIX_SSL_CERT_FILE points into a nix profile that outlives every process
    // here. Stripping it would break the machine to fix a pane.
    expect(isEphemeralNetworkVar('NIX_SSL_CERT_FILE')).toBe(false);
    const defaults = shellDefaultsFrom({
      home: '/Users/u',
      env: { NIX_SSL_CERT_FILE: '/nix/var/nix/profiles/default/etc/ssl/certs/ca-bundle.crt' },
    });
    expect(defaults.env['NIX_SSL_CERT_FILE']).toBe('/nix/var/nix/profiles/default/etc/ssl/certs/ca-bundle.crt');
  });
});

describe('isBuildScriptVar', () => {
  it('strips the npm/pnpm lifecycle env the shipping script left behind', () => {
    const defaults = shellDefaultsFrom({
      home: '/Users/u',
      env: {
        PATH: '/usr/bin',
        CI: 'true',
        INIT_CWD: '/Users/u/.shepherd/worktrees/shepherd/v2-refactor/v2',
        NODE: '/opt/homebrew/Cellar/node/26.5.0/bin/node',
        npm_lifecycle_event: 'ship',
        npm_config_registry: 'https://registry.npmjs.org/',
        pnpm_config_verify_deps_before_run: 'false',
        PNPM_SCRIPT_SRC_DIR: '/Users/u/v2',
      },
    });
    expect(Object.keys(defaults.env).sort()).toEqual(['HOME', 'PATH']);
  });

  it('does not strip a variable that merely starts the same way', () => {
    // `NODE` is the lifecycle script's; NODE_ENV and PNPMHOME are not it.
    for (const key of ['NODE_ENV', 'NODEJS_HOME', 'CID', 'INIT_CWD_OLD']) {
      expect(isBuildScriptVar(key), key).toBe(false);
    }
  });
});
