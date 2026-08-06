import { describe, expect, it } from 'vitest';
import { FALLBACK_SHELLS, shellDefaults, shellDefaultsFrom } from './shell.ts';

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
});
