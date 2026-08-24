import { describe, expect, it } from 'vitest';
import { createLogger, type LogRecord } from '@shepherd/sdk';
import { forwardRendererDiagnostics, type DiagnosticSource } from './renderer-diagnostics.ts';

/** What the page says, and where it lands. */

const clock = { now: () => 0, setTimeout: () => ({ dispose: () => {} }) };

/** A window's `webContents`, reduced to the three events that carry a fault. */
function source(): DiagnosticSource & { emit(event: string, ...args: unknown[]): void } {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  return {
    on: (event: string, listener: (...args: never[]) => void) => {
      listeners.set(event, listener as (...args: unknown[]) => void);
      return undefined;
    },
    emit: (event, ...args) => listeners.get(event)?.(...args),
  } as DiagnosticSource & { emit(event: string, ...args: unknown[]): void };
}

function recorder(): { records: LogRecord[]; logger: ReturnType<typeof createLogger> } {
  const records: LogRecord[] = [];
  return {
    records,
    logger: createLogger({ clock, level: 'debug', sink: (_line, record) => records.push(record) }),
  };
}

describe('forwardRendererDiagnostics', () => {
  it('logs a console message at the level the page used, under `renderer`', () => {
    const { records, logger } = recorder();
    const page = source();
    forwardRendererDiagnostics(page, logger);

    page.emit('console-message', { level: 2, message: 'a React warning' });

    expect(records).toEqual([{ ts: 0, level: 'warn', category: 'renderer', message: 'a React warning' }]);
  });

  it('logs a NAMED level, which is what Electron actually sends', () => {
    const { records, logger } = recorder();
    const page = source();
    forwardRendererDiagnostics(page, logger);

    page.emit('console-message', { level: 'error', message: 'ResizeObserver loop completed' });
    page.emit('console-message', { level: 'warning', message: 'a deprecation' });

    expect(records.map((record) => record.level)).toEqual(['error', 'warn']);
  });

  it('keeps a level it does not recognise instead of guessing one', () => {
    const { records, logger } = recorder();
    const page = source();
    forwardRendererDiagnostics(page, logger);

    page.emit('console-message', { level: 9, message: 'from a newer Electron' });

    expect(records[0]?.level).toBe('info');
    expect(records[0]?.message).toBe('[level 9] from a newer Electron');
  });

  it('reports a load that failed — the empty window with nothing saying why', () => {
    const { records, logger } = recorder();
    const page = source();
    forwardRendererDiagnostics(page, logger);

    page.emit('did-fail-load', undefined, -6, 'ERR_FILE_NOT_FOUND', 'file:///renderer/index.html');

    expect(records[0]).toMatchObject({
      level: 'error',
      category: 'renderer',
      message: 'load failed: -6 ERR_FILE_NOT_FOUND file:///renderer/index.html',
    });
  });

  it('reports a renderer that died', () => {
    const { records, logger } = recorder();
    const page = source();
    forwardRendererDiagnostics(page, logger);

    page.emit('render-process-gone', undefined, { reason: 'crashed' });

    expect(records[0]).toMatchObject({ level: 'error', category: 'renderer', message: 'the renderer is gone: crashed' });
  });
});
