import { describe, expect, it } from 'vitest';
import { cwdFromOsc7 } from './osc.ts';

describe('cwdFromOsc7', () => {
  it('reads a path off a payload with no host', () => {
    expect(cwdFromOsc7('file:///Users/me/code', undefined)).toBe('/Users/me/code');
  });

  it('percent-decodes the path', () => {
    expect(cwdFromOsc7('file:///Users/me/my%20code', undefined)).toBe('/Users/me/my code');
  });

  it('accepts our own host', () => {
    expect(cwdFromOsc7('file://mac-b/Users/me', 'mac-b')).toBe('/Users/me');
  });

  /**
   * `zsh`'s `$HOST` is the short name and `os.hostname()` may carry a domain.
   * Comparing whole strings rejects the machine the user is sitting at.
   */
  it('accepts our host however many labels either side spells', () => {
    expect(cwdFromOsc7('file://mac-b/Users/me', 'mac-b.local')).toBe('/Users/me');
    expect(cwdFromOsc7('file://mac-b.local/Users/me', 'mac-b')).toBe('/Users/me');
    expect(cwdFromOsc7('file://MAC-B/Users/me', 'mac-b')).toBe('/Users/me');
  });

  /** An `ssh` session inside the pane names a directory that is not here. */
  it('refuses another machine', () => {
    expect(cwdFromOsc7('file://build-box/srv/app', 'mac-b')).toBeUndefined();
  });

  it('refuses a host when we do not know our own name', () => {
    expect(cwdFromOsc7('file://mac-b/Users/me', undefined)).toBeUndefined();
  });

  it('refuses anything that is not a file URL', () => {
    expect(cwdFromOsc7('http://mac-b/Users/me', 'mac-b')).toBeUndefined();
    expect(cwdFromOsc7('/Users/me', 'mac-b')).toBeUndefined();
    expect(cwdFromOsc7('', 'mac-b')).toBeUndefined();
  });

  /** A relative path is not a cwd, and would resolve against whatever ran next. */
  it('refuses a path that is not absolute', () => {
    expect(cwdFromOsc7('file://', undefined)).toBeUndefined();
    expect(cwdFromOsc7('file://mac-b', 'mac-b')).toBeUndefined();
  });

  /** A malformed escape makes `decodeURIComponent` THROW. */
  it('refuses a broken percent escape instead of throwing', () => {
    expect(cwdFromOsc7('file:///Users/%ZZ', undefined)).toBeUndefined();
  });
});
