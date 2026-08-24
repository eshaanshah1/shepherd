import type { BrowserWindow } from 'electron';
import type { LogLevel, Logger } from '@shepherd/sdk';

/**
 * What the page says, in the log.
 *
 * Otherwise the only place a renderer error appears is a DevTools window nobody
 * has open, and an empty window says nothing about why it is empty.
 */

/** By index, which is the older shape of `console-message`. */
const BY_INDEX = ['debug', 'info', 'warn', 'error'] as const;

/** By name, which is what Electron sends now. `warning` is this app's `warn`. */
const BY_NAME: Readonly<Record<string, LogLevel>> = {
  debug: 'debug',
  verbose: 'debug',
  info: 'info',
  warning: 'warn',
  warn: 'warn',
  error: 'error',
};

/** The level a console message carries, whichever shape it arrives in. */
function levelOf(level: number | string): LogLevel | undefined {
  return typeof level === 'number' ? BY_INDEX[level] : BY_NAME[level.toLowerCase()];
}

/**
 * The three events, narrowed to what a logger needs — `BrowserWindow` is not
 * constructible in a test, so the seam is this shape rather than the window.
 */
export interface DiagnosticSource {
  on(event: 'console-message', listener: (details: { level: number | string; message: string }) => void): unknown;
  on(
    event: 'did-fail-load',
    listener: (event: unknown, code: number, description: string, url: string) => void,
  ): unknown;
  on(event: 'render-process-gone', listener: (event: unknown, details: { reason: string }) => void): unknown;
}

export function forwardRendererDiagnostics(source: DiagnosticSource, logger: Logger): void {
  const log = logger.child('renderer');
  source.on('console-message', (details) => {
    const level = levelOf(details.level);
    // An unknown level keeps what it said rather than being mapped to a guess.
    if (level === undefined) log.info(`[level ${String(details.level)}] ${details.message}`);
    else log[level](details.message);
  });
  source.on('did-fail-load', (_event, code, description, url) => {
    log.error(`load failed: ${code} ${description} ${url}`);
  });
  source.on('render-process-gone', (_event, details) => {
    log.error(`the renderer is gone: ${details.reason}`);
  });
}

/** The same thing, for the real window. */
export function attachRendererDiagnostics(win: BrowserWindow, logger: Logger): void {
  forwardRendererDiagnostics(win.webContents as unknown as DiagnosticSource, logger);
}
