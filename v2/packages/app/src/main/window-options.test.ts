import { describe, expect, it } from 'vitest';
import { DEFAULT_WINDOW_SIZE, windowOptions } from './window-options.ts';

const options = () =>
  windowOptions({ preloadPath: '/app/out/preload/index.cjs', backgroundColor: '#100E0B' });

describe('window security posture', () => {
  it('isolates the preload world from the page', () => {
    expect(options().webPreferences?.contextIsolation).toBe(true);
  });

  it('gives the page no node integration, in any frame or worker', () => {
    const web = options().webPreferences;
    expect(web?.nodeIntegration).toBe(false);
    expect(web?.nodeIntegrationInWorker).toBe(false);
    expect(web?.nodeIntegrationInSubFrames).toBe(false);
  });

  it('sandboxes the renderer process', () => {
    expect(options().webPreferences?.sandbox).toBe(true);
  });

  it('does not mention enableRemoteModule at all', () => {
    // Absent, not `false`: a key that is present is a key somebody flips during
    // a debugging session and forgets. `@electron/remote` hands the page the
    // whole main process behind one require.
    const web = options().webPreferences as Record<string, unknown>;
    expect('enableRemoteModule' in web).toBe(false);
    expect(JSON.stringify(options())).not.toContain('enableRemoteModule');
  });

  it('keeps web security on', () => {
    expect(options().webPreferences?.webSecurity).toBe(true);
  });

  it('loads a CommonJS preload, which is what a sandboxed renderer can run', () => {
    // Not decoration: a sandboxed preload is not an ES module. An `.mjs` here
    // fails at load time with the window already on screen and empty.
    expect(options().webPreferences?.preload?.endsWith('.cjs')).toBe(true);
  });
});

describe('window chrome', () => {
  it('starts hidden so the first frame is never a half-painted window', () => {
    expect(options().show).toBe(false);
  });

  it('paints the backdrop colour before any HTML exists', () => {
    expect(options().backgroundColor).toBe('#100E0B');
  });

  it('takes a size, and has one when nobody says', () => {
    expect(options()).toMatchObject(DEFAULT_WINDOW_SIZE);
    const sized = windowOptions({
      preloadPath: '/p.cjs',
      backgroundColor: '#000000',
      width: 400,
      height: 300,
    });
    expect(sized).toMatchObject({ width: 400, height: 300 });
  });
});
